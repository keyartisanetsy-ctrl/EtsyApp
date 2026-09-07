/**
 * Etsy Open API v3 transport.
 *
 * Everything the app sends to Etsy goes through here so that auth refresh,
 * the 10 req/s ceiling, retry/backoff and call logging are handled once.
 */
import config from '../config.js';
import { getDb, getSetting, setSetting, resolveSetting } from '../db/index.js';
import { seal, open as unseal } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { EtsyApiError, unauthorized, notFound } from '../lib/errors.js';
import { OPERATIONS } from './operations.generated.js';
import { outboundFetch } from '../lib/outbound.js';

const log = createLogger('etsy');

// --------------------------------------------------------- rate limiting

/** Token bucket sized to Etsy's documented 10 requests/second per app. */
class RateLimiter {
  constructor(perSecond) {
    this.capacity = perSecond;
    this.tokens = perSecond;
    this.last = Date.now();
    this.queue = [];
  }

  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.capacity);
    this.last = now;
  }

  acquire() {
    return new Promise((resolve) => {
      const attempt = () => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve();
        } else {
          setTimeout(attempt, Math.ceil((1 - this.tokens) * (1000 / this.capacity)) + 5);
        }
      };
      attempt();
    });
  }
}

const limiter = new RateLimiter(config.etsy.maxRequestsPerSecond);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- credentials

export function getCredentials() {
  const keystring = resolveSetting('etsy.keystring', config.etsy.keystring);
  const sharedSecret = resolveSetting('etsy.shared_secret', config.etsy.sharedSecret);
  return {
    keystring,
    sharedSecret,
    apiKeyHeader: buildApiKeyHeader(keystring, sharedSecret),
    redirectUri: resolveSetting('etsy.redirect_uri', config.etsy.redirectUri) ||
      `http://${config.publicHost}:${config.port}/api/auth/callback`,
  };
}

/**
 * Etsy's x-api-key must be "keystring:shared_secret", not the keystring alone.
 * Sending only the keystring is refused with
 *   403 {"error":"Shared secret is required in x-api-key header."}
 * on every endpoint, public ones included. Tolerate a keystring that already
 * has the secret appended, since that is an easy thing to paste.
 */
export function buildApiKeyHeader(keystring, sharedSecret) {
  const key = String(keystring ?? '').trim();
  const secret = String(sharedSecret ?? '').trim();
  if (!key) return '';
  if (key.includes(':')) return key;
  return secret ? `${key}:${secret}` : key;
}

/** OAuth's client_id is the bare keystring, never the combined pair. */
export const clientId = () => String(getCredentials().keystring ?? '').split(':')[0].trim();

const unsealRow = (row) => (row ? {
  ...row,
  access_token: unseal(row.access_token, config.dataDir),
  refresh_token: unseal(row.refresh_token, config.dataDir),
} : null);

/** The shop the screens are currently working with. */
export function getStoredToken() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM etsy_accounts WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  // If nothing is marked active (e.g. the active shop was removed), adopt the
  // first remaining one rather than behaving as if nothing is connected.
  if (!row) {
    row = db.prepare('SELECT * FROM etsy_accounts ORDER BY id LIMIT 1').get();
    if (row) db.prepare('UPDATE etsy_accounts SET is_active = 1 WHERE id = ?').run(row.id);
  }
  return unsealRow(row);
}

export const getAccountByShop = (shopId) =>
  unsealRow(getDb().prepare('SELECT * FROM etsy_accounts WHERE shop_id = ?').get(shopId));

/** Every connected shop, without exposing the tokens. */
export function listAccounts() {
  return getDb().prepare('SELECT * FROM etsy_accounts ORDER BY id').all().map((r) => ({
    id: r.id,
    shopId: r.shop_id,
    shopName: r.shop_name,
    userId: r.user_id,
    label: r.label || '',
    airtableName: r.airtable_name || '',
    scopes: (r.scopes || '').split(' ').filter(Boolean),
    expiresAt: r.expires_at,
    connectedAt: r.connected_at,
    isActive: !!r.is_active,
  }));
}

export function setActiveAccount(shopId) {
  const db = getDb();
  const row = db.prepare('SELECT id FROM etsy_accounts WHERE shop_id = ?').get(shopId);
  if (!row) throw notFound(`Shop ${shopId} is not connected.`);
  db.transaction(() => {
    db.prepare('UPDATE etsy_accounts SET is_active = 0').run();
    db.prepare('UPDATE etsy_accounts SET is_active = 1 WHERE id = ?').run(row.id);
  })();
  log.info(`active shop is now ${shopId}`);
  return listAccounts();
}

/**
 * The name this shop goes by in Airtable. Etsy's shop name and the option in
 * an Airtable select column are often spelled differently ("KeyArtisan" vs
 * "KeyArtisann"), and that column is what decides which view a row lands in,
 * so it is worth being explicit rather than guessing.
 */
export function setAirtableName(shopId, name) {
  getDb().prepare("UPDATE etsy_accounts SET airtable_name = ?, updated_at = datetime('now') WHERE shop_id = ?")
    .run(String(name ?? '').slice(0, 120), shopId);
  return listAccounts();
}

export function renameAccount(shopId, label) {
  getDb().prepare("UPDATE etsy_accounts SET label = ?, updated_at = datetime('now') WHERE shop_id = ?")
    .run(String(label ?? '').slice(0, 80), shopId);
  return listAccounts();
}

/**
 * Remove one shop. Its mirrored data goes too, so a disconnected shop leaves
 * nothing behind for another shop's screens to pick up.
 */
export function removeAccount(shopId, { purgeData = true } = {}) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM etsy_accounts WHERE shop_id = ?').run(shopId);
    if (purgeData) {
      db.prepare('DELETE FROM listings WHERE shop_id = ?').run(shopId);
      db.prepare('DELETE FROM receipts WHERE shop_id = ?').run(shopId);
      db.prepare('DELETE FROM tracking WHERE shop_id = ?').run(shopId);
      db.prepare('DELETE FROM shop_sections WHERE shop_id = ?').run(shopId);
    }
    // Keep exactly one shop active.
    const stillActive = db.prepare('SELECT COUNT(*) AS c FROM etsy_accounts WHERE is_active = 1').get().c;
    if (!stillActive) {
      const next = db.prepare('SELECT id FROM etsy_accounts ORDER BY id LIMIT 1').get();
      if (next) db.prepare('UPDATE etsy_accounts SET is_active = 1 WHERE id = ?').run(next.id);
    }
  })();
  log.info(`disconnected shop ${shopId}${purgeData ? ' and removed its local data' : ''}`);
  return listAccounts();
}

/**
 * Upsert one shop's tokens. Keyed by shop_id, so reconnecting a shop refreshes
 * it in place instead of creating a duplicate.
 *
 * A shop_id is not known during the very first token exchange (it takes another
 * API call to find out), so a row without one is written and completed later.
 */
export function saveToken({ access_token, refresh_token, expires_in, user_id, shop_id, shop_name, scopes, makeActive = true }) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();
  const sealedAccess = seal(access_token, config.dataDir);
  const sealedRefresh = seal(refresh_token, config.dataDir);

  db.transaction(() => {
    const existing = shop_id
      ? db.prepare('SELECT * FROM etsy_accounts WHERE shop_id = ?').get(shop_id)
      : db.prepare('SELECT * FROM etsy_accounts WHERE shop_id IS NULL ORDER BY id DESC LIMIT 1').get();

    if (existing) {
      db.prepare(`UPDATE etsy_accounts SET
          user_id = COALESCE(?, user_id), shop_id = COALESCE(?, shop_id),
          shop_name = COALESCE(?, shop_name), access_token = ?, refresh_token = ?,
          scopes = COALESCE(NULLIF(?, ''), scopes), expires_at = ?, updated_at = datetime('now')
        WHERE id = ?`)
        .run(user_id ?? null, shop_id ?? null, shop_name ?? null,
             sealedAccess, sealedRefresh, scopes ?? '', expiresAt, existing.id);
      if (makeActive) {
        db.prepare('UPDATE etsy_accounts SET is_active = 0').run();
        db.prepare('UPDATE etsy_accounts SET is_active = 1 WHERE id = ?').run(existing.id);
      }
    } else {
      const info = db.prepare(`INSERT INTO etsy_accounts
          (shop_id, shop_name, user_id, access_token, refresh_token, scopes, expires_at, is_active)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(shop_id ?? null, shop_name ?? null, user_id ?? null,
             sealedAccess, sealedRefresh, scopes ?? '', expiresAt, makeActive ? 1 : 0);
      if (makeActive) {
        db.prepare('UPDATE etsy_accounts SET is_active = 0 WHERE id <> ?').run(info.lastInsertRowid);
      }
    }
  })();

  return shop_id ? getAccountByShop(shop_id) : getStoredToken();
}

/** Disconnect every shop. Individual shops use removeAccount(). */
export const disconnect = () => getDb().prepare('DELETE FROM etsy_accounts').run();

/** Etsy access tokens live 1h; refresh a minute early to avoid a mid-flight 401. */
async function ensureFreshToken() {
  const token = getStoredToken();
  if (!token) throw unauthorized('No Etsy account connected. Open Settings and connect your shop.');
  if (new Date(token.expires_at).getTime() - Date.now() > 60_000) return token;

  log.info('access token expiring, refreshing');
  const res = await outboundFetch(config.etsy.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId(),
      refresh_token: token.refresh_token,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EtsyApiError(res.status, `Token refresh failed: ${body.error_description || body.error || res.statusText}`, { body });
  }
  return saveToken({
    ...body,
    shop_id: token.shop_id,
    shop_name: token.shop_name,
    user_id: token.user_id,
    scopes: token.scopes,
    makeActive: false, // refreshing must never change which shop is selected
  });
}

// ------------------------------------------------------------ request core

function logCall(entry) {
  try {
    getDb()
      .prepare('INSERT INTO api_calls (operation_id, method, url, status, duration_ms, error) VALUES (?,?,?,?,?,?)')
      .run(entry.operationId ?? null, entry.method, entry.url, entry.status ?? null, entry.durationMs, entry.error ?? null);
  } catch { /* logging must never break a request */ }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Perform one Etsy request with backoff. `auth: false` uses only the app
 * keystring, which is all the public read endpoints need.
 */
export async function request(pathname, {
  method = 'GET', query, body, bodyKind = 'json', headers = {},
  auth = true, operationId, raw = false, accessToken = null,
} = {}) {
  const { keystring, sharedSecret, apiKeyHeader } = getCredentials();
  if (!keystring) throw unauthorized('Etsy API keystring is not configured. Add it in Settings.');
  if (!sharedSecret && !keystring.includes(':')) {
    throw unauthorized(
      'Etsy shared secret is not configured. Etsy requires the x-api-key header to be '
      + '"keystring:shared_secret" — the keystring alone is rejected on every endpoint. Add it in Settings.',
    );
  }

  const url = new URL(pathname.startsWith('http') ? pathname : config.etsy.base + pathname);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.append(k, String(v));
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const started = Date.now();
    const h = { 'x-api-key': apiKeyHeader, Accept: 'application/json', ...headers };

    if (accessToken) {
      h.Authorization = `Bearer ${accessToken}`;
    } else if (auth) {
      const token = await ensureFreshToken();
      h.Authorization = `Bearer ${token.access_token}`;
    }

    let payload;
    if (body !== undefined && body !== null) {
      if (bodyKind === 'form') {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined || v === null) continue;
          // Etsy expects repeated keys for array form fields (tags, materials...).
          if (Array.isArray(v)) v.forEach((i) => p.append(k, String(i)));
          else p.append(k, typeof v === 'boolean' ? String(v) : String(v));
        }
        payload = p;
        h['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (bodyKind === 'multipart') {
        payload = body; // caller supplies a FormData
      } else {
        payload = JSON.stringify(body);
        h['Content-Type'] = 'application/json';
      }
    }

    await limiter.acquire();

    let res;
    try {
      res = await outboundFetch(url, { method, headers: h, body: payload });
    } catch (err) {
      logCall({ operationId, method, url: url.toString(), durationMs: Date.now() - started, error: err.message });
      if (attempt <= config.etsy.maxRetries) {
        await sleep(Math.min(8000, 2 ** attempt * 250));
        continue;
      }
      throw new EtsyApiError(502, `Could not reach Etsy: ${err.message}`, { operationId, url: url.toString() });
    }

    const durationMs = Date.now() - started;

    if (RETRY_STATUS.has(res.status) && attempt <= config.etsy.maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(10_000, 2 ** attempt * 300);
      log.warn(`${res.status} on ${operationId || pathname}, retry ${attempt} in ${wait}ms`);
      logCall({ operationId, method, url: url.toString(), status: res.status, durationMs, error: 'retrying' });
      await sleep(wait);
      continue;
    }

    logCall({ operationId, method, url: url.toString(), status: res.status, durationMs });

    if (raw) {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new EtsyApiError(res.status, `Etsy ${res.status} on ${operationId || pathname}`, { operationId, url: url.toString(), body: text });
      }
      return res;
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    if (!res.ok) {
      const msg = parsed?.error || parsed?.error_description || parsed?.message || res.statusText;
      throw new EtsyApiError(res.status, `Etsy ${res.status} on ${operationId || pathname}: ${msg}`, {
        operationId, url: url.toString(), body: parsed,
      });
    }
    return parsed;
  }
}

// ----------------------------------------------------- operation invocation

/** True when the operation needs a user token (it declares OAuth scopes). */
export const operationNeedsAuth = (op) => (op.scopes?.length ?? 0) > 0;

/**
 * Call any of the 105 documented operations by its operationId.
 * Path params, query params and the body shape are all taken from the spec.
 */
export async function call(operationId, args = {}, opts = {}) {
  const op = OPERATIONS[operationId];
  if (!op) throw new EtsyApiError(400, `Unknown Etsy operation "${operationId}"`);

  let pathname = op.path;
  for (const name of op.pathParams) {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      throw new EtsyApiError(400, `Missing path parameter "${name}" for ${operationId}`);
    }
    pathname = pathname.replace(`{${name}}`, encodeURIComponent(String(value)));
  }

  const query = {};
  for (const q of op.query) if (args[q.name] !== undefined) query[q.name] = args[q.name];

  let body;
  let bodyKind = op.body?.kind || 'json';
  if (op.body) {
    if (opts.formData) {
      body = opts.formData;
      bodyKind = 'multipart';
    } else {
      const picked = {};
      for (const key of Object.keys(op.body.props)) if (args[key] !== undefined) picked[key] = args[key];
      if (Object.keys(picked).length) body = picked;
    }
  }
  if (opts.body !== undefined) body = opts.body;

  // Some operations accept a token but do not require one; use it when present.
  const auth = opts.auth ?? (operationNeedsAuth(op) || opts.accessToken || !!getStoredToken());

  return request(pathname, {
    method: op.method, query, body, bodyKind, auth, operationId, raw: opts.raw, accessToken: opts.accessToken,
  });
}

/**
 * Walk a limit/offset endpoint to completion.
 * Etsy caps `limit` at 100 on every paged operation.
 */
export async function callAll(operationId, args = {}, { pageSize = 100, max = Infinity, onPage } = {}) {
  const out = [];
  let offset = Number(args.offset) || 0;
  for (;;) {
    const page = await call(operationId, { ...args, limit: Math.min(pageSize, 100), offset });
    const results = page?.results ?? [];
    out.push(...results);
    if (onPage) await onPage(results, page, offset);
    const total = page?.count ?? out.length;
    offset += results.length;
    if (!results.length || out.length >= Math.min(total, max)) break;
  }
  return out;
}

export { OPERATIONS };
