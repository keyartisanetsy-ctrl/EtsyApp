/**
 * Shopify Admin GraphQL API transport.
 *
 * Several stores can be connected at once, the same idea as Etsy's
 * etsy_accounts: exactly one is active, and withShop() lets a background job
 * (the scheduler, syncing every connected store in turn) act on a specific
 * store without touching which one is active for the browser. The OAuth app
 * itself (Client ID/Secret) is a single global setting - unlike Etsy, one
 * Shopify app is designed to be installed on any number of different stores,
 * so there is no need for each store to register its own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { readSetting } from '../services/settings.js';
import { seal, open as unseal } from '../lib/crypto.js';
import { outboundFetch } from '../lib/outbound.js';
import { createLogger } from '../lib/logger.js';
import { AppError, badRequest, unauthorized, notFound } from '../lib/errors.js';

const log = createLogger('shopify');

export class ShopifyApiError extends AppError {
  constructor(status, message, { errors, userErrors, query } = {}) {
    super(status, message, { errors, userErrors });
    this.name = 'ShopifyApiError';
    this.errors = errors;
    this.userErrors = userErrors;
    this.query = query;
  }
}

const cleanDomain = (d) => String(d ?? '').trim()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();

// -------------------------------------------------------------- accounts

/**
 * Lets a background job act as if a specific store were active, without
 * touching the persisted is_active flag - so it never visibly flips what a
 * human has open in the browser, and two such jobs can even run at once
 * without racing each other. Scoped to the async call chain inside
 * withShopifyShop(); nothing outside it is affected.
 */
const shopContext = new AsyncLocalStorage();

export function withShopifyShop(id, fn) {
  return shopContext.run(id, fn);
}

const unsealRow = (row) => (row ? { ...row, admin_token: unseal(row.admin_token, config.dataDir) } : null);

export const getAccountById = (id) =>
  unsealRow(getDb().prepare('SELECT * FROM shopify_accounts WHERE id = ?').get(id));

export const getAccountByDomain = (domain) =>
  unsealRow(getDb().prepare('SELECT * FROM shopify_accounts WHERE shop_domain = ?').get(cleanDomain(domain)));

/** The store the screens are currently working with. */
export function getStoredShopifyToken() {
  const override = shopContext.getStore();
  // Inside withShopifyShop(), a specific store always wins, connected or
  // not - a background job naming a store that got disconnected mid-flight
  // must see "not connected", never silently fall through to whichever store
  // the human's browser happens to have active right now.
  if (override !== undefined) return getAccountById(override);

  const db = getDb();
  let row = db.prepare('SELECT * FROM shopify_accounts WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  if (!row) {
    row = db.prepare('SELECT * FROM shopify_accounts ORDER BY id LIMIT 1').get();
    if (row) db.prepare('UPDATE shopify_accounts SET is_active = 1 WHERE id = ?').run(row.id);
  }
  return unsealRow(row);
}

export function listShopifyAccounts() {
  return getDb().prepare('SELECT * FROM shopify_accounts ORDER BY id').all().map((r) => ({
    id: r.id,
    shopDomain: r.shop_domain,
    shopName: r.shop_name,
    label: r.label || '',
    airtableName: r.airtable_name || '',
    apiVersion: r.api_version || '2025-10',
    connectedVia: r.connected_via || '',
    isActive: !!r.is_active,
    connectedAt: r.connected_at,
  }));
}

export function setActiveShopifyAccount(id) {
  const db = getDb();
  const row = db.prepare('SELECT id FROM shopify_accounts WHERE id = ?').get(id);
  if (!row) throw notFound(`Store ${id} is not connected.`);
  db.transaction(() => {
    db.prepare('UPDATE shopify_accounts SET is_active = 0').run();
    db.prepare('UPDATE shopify_accounts SET is_active = 1 WHERE id = ?').run(id);
  })();
  log.info(`active Shopify store is now ${id}`);
  return listShopifyAccounts();
}

export function renameShopifyAccount(id, label) {
  getDb().prepare("UPDATE shopify_accounts SET label = ?, updated_at = datetime('now') WHERE id = ?")
    .run(String(label ?? '').slice(0, 80), id);
  return listShopifyAccounts();
}

/** The name this store goes by in Airtable - its own shop domain and the
 *  option in an Airtable select column are often spelled differently. */
export function setShopifyAirtableName(id, name) {
  getDb().prepare("UPDATE shopify_accounts SET airtable_name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(String(name ?? '').slice(0, 120), id);
  return listShopifyAccounts();
}

/** Remove one store. Its mirrored data goes too, so a disconnected store
 *  leaves nothing behind for another store's screens to pick up. */
export function removeShopifyAccount(id, { purgeData = true } = {}) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM shopify_accounts WHERE id = ?').run(id);
    if (purgeData) {
      db.prepare('DELETE FROM shopify_products WHERE shop_id = ?').run(id);
      db.prepare('DELETE FROM shopify_orders WHERE shop_id = ?').run(id);
      db.prepare('DELETE FROM shopify_variant_meta WHERE shop_id = ?').run(id);
    }
    const stillActive = db.prepare('SELECT COUNT(*) AS c FROM shopify_accounts WHERE is_active = 1').get().c;
    if (!stillActive) {
      const next = db.prepare('SELECT id FROM shopify_accounts ORDER BY id LIMIT 1').get();
      if (next) db.prepare('UPDATE shopify_accounts SET is_active = 1 WHERE id = ?').run(next.id);
    }
  })();
  log.info(`disconnected Shopify store ${id}${purgeData ? ' and removed its local data' : ''}`);
  return listShopifyAccounts();
}

/** Upsert one store's connection. Keyed by shop_domain, so reconnecting a
 *  store refreshes it in place instead of creating a duplicate. */
export function saveShopifyToken({ shopDomain, shopName, adminToken, connectedVia, apiVersion } = {}) {
  const domain = cleanDomain(shopDomain);
  if (!domain) throw badRequest('A shop domain is required.');
  if (!adminToken) throw badRequest('An access token is required.');
  const db = getDb();
  const sealedToken = seal(adminToken, config.dataDir);
  const existing = db.prepare('SELECT id FROM shopify_accounts WHERE shop_domain = ?').get(domain);

  if (existing) {
    db.prepare(`
      UPDATE shopify_accounts SET shop_name = COALESCE(?, shop_name), admin_token = ?,
        connected_via = COALESCE(?, connected_via), api_version = COALESCE(?, api_version),
        updated_at = datetime('now')
      WHERE id = ?`)
      .run(shopName ?? null, sealedToken, connectedVia ?? null, apiVersion ?? null, existing.id);
    return getAccountById(existing.id);
  }

  const isFirst = db.prepare('SELECT COUNT(*) AS c FROM shopify_accounts').get().c === 0;
  const info = db.prepare(`
    INSERT INTO shopify_accounts (shop_domain, shop_name, admin_token, connected_via, api_version, is_active)
    VALUES (?,?,?,?,?,?)`)
    .run(domain, shopName ?? null, sealedToken, connectedVia ?? null, apiVersion || '2025-10', isFirst ? 1 : 0);
  return getAccountById(info.lastInsertRowid);
}

// -------------------------------------------------------------- credentials

/**
 * `account` (a specific store's row) takes priority when given; otherwise
 * resolves the currently active store (or withShopifyShop() override).
 */
export function getCredentials(account) {
  const acct = account !== undefined ? account : getStoredShopifyToken();
  return {
    shopDomain: acct?.shop_domain ? cleanDomain(acct.shop_domain) : '',
    apiVersion: acct?.api_version || readSetting('shopify.api_version') || '2025-10',
    clientId: readSetting('shopify.oauth_client_id'),
    clientSecret: readSetting('shopify.oauth_client_secret'),
    adminToken: acct?.admin_token || '',
    connectedVia: acct?.connected_via || '',
  };
}

export const hasToken = () => !!getCredentials().adminToken;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one GraphQL operation. Retries on Shopify's cost-based throttling
 * (THROTTLED) and on a plain 429, since both mean "you asked too fast," not
 * "this request is wrong" - a query-shape error surfaces immediately instead.
 * `account` targets a specific store's credentials directly - used right
 * after an OAuth exchange or a pasted token, before that store even has a row
 * to be "active" yet.
 */
export async function gql(query, variables = {}, { maxRetries = 4, account } = {}) {
  const creds = getCredentials(account);
  if (!creds.shopDomain) throw badRequest('Set the shop domain (….myshopify.com) first.');
  if (!creds.adminToken) throw unauthorized('Not connected to Shopify. Connect a store first.');

  const url = `https://${creds.shopDomain}/admin/api/${creds.apiVersion}/graphql.json`;
  let attempt = 0;
  for (;;) {
    const res = await outboundFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': creds.adminToken },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyApiError(res.status, 'Shopify refused the token. Reconnect this store.');
    }
    if (res.status === 429 && attempt < maxRetries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1);
      await sleep(wait);
      attempt += 1;
      continue;
    }

    const body = await res.json().catch(() => ({}));
    const throttled = Array.isArray(body.errors) && body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < maxRetries) {
      const restore = body.extensions?.cost?.throttleStatus?.restoreRate || 50;
      await sleep(Math.max(500, Math.ceil(1000 / restore) * 200));
      attempt += 1;
      continue;
    }
    // A field the current token's scope doesn't cover comes back as one entry
    // in `errors` (code ACCESS_DENIED) with `data` still present for
    // everything else - Shopify's normal shape for "you asked for more than
    // you're allowed to see," not a broken query. Sinking the whole sync over
    // one such field (as happened when an order query touched customer data
    // before read_customers was granted) throws away every order it could
    // otherwise read; skipping just that field and logging it once is enough.
    if (res.ok && body.data && Array.isArray(body.errors) && body.errors.length
        && body.errors.every((e) => e.extensions?.code === 'ACCESS_DENIED')) {
      log.warn(`field(s) skipped (missing scope): ${body.errors.map((e) => e.message).join('; ')}`);
      return body.data;
    }
    if (!res.ok || body.errors) {
      const message = (Array.isArray(body.errors) ? body.errors.map((e) => e.message).join('; ') : body.errors) || `HTTP ${res.status}`;
      log.warn(`GraphQL error: ${message}`);
      throw new ShopifyApiError(res.ok ? 400 : res.status, message, { errors: body.errors, query });
    }
    return body.data;
  }
}

/**
 * Convenience for mutations that follow Shopify's own `userErrors` shape -
 * throws with the exact field-level complaint instead of a generic failure.
 */
export function checkUserErrors(payload, path) {
  const node = path.split('.').reduce((o, k) => o?.[k], payload);
  const errors = node?.userErrors;
  if (errors?.length) {
    throw new ShopifyApiError(400, errors.map((e) => e.message).join('; '), { userErrors: errors });
  }
  return node;
}

/** Live check: does the token actually work, against the store's own name. */
export async function testConnection(account) {
  const data = await gql(`{ shop { name myshopifyDomain plan { displayName } } }`, {}, { account });
  return data.shop;
}
