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
import { EtsyApiError, unauthorized } from '../lib/errors.js';
import { OPERATIONS } from './operations.generated.js';

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
  return {
    keystring: resolveSetting('etsy.keystring', config.etsy.keystring),
    sharedSecret: resolveSetting('etsy.shared_secret', config.etsy.sharedSecret),
    redirectUri: resolveSetting('etsy.redirect_uri', config.etsy.redirectUri) ||
      `http://127.0.0.1:${config.port}/api/auth/callback`,
  };
}

export function getStoredToken() {
  const row = getDb().prepare('SELECT * FROM oauth_token WHERE id = 1').get();
  if (!row) return null;
  return {
    ...row,
    access_token: unseal(row.access_token, config.dataDir),
    refresh_token: unseal(row.refresh_token, config.dataDir),
  };
}

export function saveToken({ access_token, refresh_token, expires_in, user_id, shop_id, shop_name, scopes }) {
  const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();
  const existing = getDb().prepare('SELECT * FROM oauth_token WHERE id = 1').get();
  getDb()
    .prepare(
      `INSERT INTO oauth_token (id, user_id, shop_id, shop_name, access_token, refresh_token, scopes, expires_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         user_id = COALESCE(excluded.user_id, oauth_token.user_id),
         shop_id = COALESCE(excluded.shop_id, oauth_token.shop_id),
         shop_name = COALESCE(excluded.shop_name, oauth_token.shop_name),
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         scopes = COALESCE(NULLIF(excluded.scopes,''), oauth_token.scopes),
         expires_at = excluded.expires_at,
         updated_at = datetime('now')`,
    )
    .run(
      user_id ?? existing?.user_id ?? null,
      shop_id ?? existing?.shop_id ?? null,
      shop_name ?? existing?.shop_name ?? null,
      seal(access_token, config.dataDir),
      seal(refresh_token, config.dataDir),
      scopes ?? '',
      expiresAt,
    );
  return getStoredToken();
}

export const disconnect = () => getDb().prepare('DELETE FROM oauth_token').run();

/** Etsy access tokens live 1h; refresh a minute early to avoid a mid-flight 401. */
async function ensureFreshToken() {
  const token = getStoredToken();
  if (!token) throw unauthorized('No Etsy account connected. Open Settings and connect your shop.');
  if (new Date(token.expires_at).getTime() - Date.now() > 60_000) return token;

  const { keystring } = getCredentials();
  log.info('access token expiring, refreshing');
  const res = await fetch(config.etsy.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: keystring,
      refresh_token: token.refresh_token,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EtsyApiError(res.status, `Token refresh failed: ${body.error_description || body.error || res.statusText}`, { body });
  }
  return saveToken({ ...body, shop_id: token.shop_id, shop_name: token.shop_name, user_id: token.user_id, scopes: token.scopes });
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
  auth = true, operationId, raw = false,
} = {}) {
  const { keystring } = getCredentials();
  if (!keystring) throw unauthorized('Etsy API keystring is not configured. Add it in Settings.');

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
    const h = { 'x-api-key': keystring, Accept: 'application/json', ...headers };

    if (auth) {
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
      res = await fetch(url, { method, headers: h, body: payload });
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
  const auth = opts.auth ?? (operationNeedsAuth(op) || !!getStoredToken());

  return request(pathname, { method: op.method, query, body, bodyKind, auth, operationId, raw: opts.raw });
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
