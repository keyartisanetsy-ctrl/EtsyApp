/**
 * Shopify Admin GraphQL API transport.
 *
 * One store, one token - unlike Etsy there is no multi-shop switching here.
 * The token can come from either connection path (see oauth.js): a "Dev
 * Dashboard" OAuth app, or a pasted custom-app "Admin API access token".
 * Either way it ends up in the same setting, so the rest of the app never
 * needs to know which path was used.
 */
import { readSetting, writeSetting } from '../services/settings.js';
import { outboundFetch } from '../lib/outbound.js';
import { createLogger } from '../lib/logger.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';

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

export function getCredentials() {
  return {
    shopDomain: cleanDomain(readSetting('shopify.shop_domain')),
    apiVersion: readSetting('shopify.api_version') || '2025-01',
    clientId: readSetting('shopify.oauth_client_id'),
    clientSecret: readSetting('shopify.oauth_client_secret'),
    adminToken: readSetting('shopify.admin_token'),
    connectedVia: readSetting('shopify.connected_via'),
  };
}

export const hasToken = () => !!getCredentials().adminToken;

export function saveAdminToken(token, { via = 'custom' } = {}) {
  writeSetting('shopify.admin_token', String(token ?? '').trim());
  writeSetting('shopify.connected_via', via);
}

export function disconnect() {
  writeSetting('shopify.admin_token', '');
  writeSetting('shopify.connected_via', '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one GraphQL operation. Retries on Shopify's cost-based throttling
 * (THROTTLED) and on a plain 429, since both mean "you asked too fast," not
 * "this request is wrong" - a query-shape error surfaces immediately instead.
 */
export async function gql(query, variables = {}, { maxRetries = 4 } = {}) {
  const creds = getCredentials();
  if (!creds.shopDomain) throw badRequest('Set the shop domain (….myshopify.com) first.');
  if (!creds.adminToken) throw unauthorized('Not connected to Shopify. Connect it in Shop settings.');

  const url = `https://${creds.shopDomain}/admin/api/${creds.apiVersion}/graphql.json`;
  let attempt = 0;
  for (;;) {
    const res = await outboundFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': creds.adminToken },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyApiError(res.status, 'Shopify refused the token. Reconnect it in Shop settings.');
    }
    if (res.status === 429 && attempt < maxRetries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1);
      await sleep(wait);
      attempt += 1;
      continue;
    }

    const body = await res.json().catch(() => ({}));
    const throttled = body.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < maxRetries) {
      const restore = body.extensions?.cost?.throttleStatus?.restoreRate || 50;
      await sleep(Math.max(500, Math.ceil(1000 / restore) * 200));
      attempt += 1;
      continue;
    }
    if (!res.ok || body.errors) {
      const message = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
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

/** Live check: does the token actually work, against the shop's own name. */
export async function testConnection() {
  const data = await gql(`{ shop { name myshopifyDomain plan { displayName } } }`);
  return data.shop;
}
