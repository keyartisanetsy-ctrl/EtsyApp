/**
 * Shopify OAuth 2.0 - the "Dev Dashboard" custom-distribution app path.
 * Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 *
 * No PKCE (that is Etsy's flow, not Shopify's); instead the callback carries
 * an HMAC over the query string, signed with the app's client secret, which
 * this verifies before ever exchanging the code. One app (Client ID/Secret,
 * a single global setting) can be installed on any number of different
 * stores - each connection just repeats this same flow with a different
 * shopDomain, and saveShopifyToken() below keys the result by that domain.
 */
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { readSetting } from '../services/settings.js';
import { outboundFetch } from '../lib/outbound.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { gql, saveShopifyToken } from './client.js';

const log = createLogger('shopify-oauth');

// Shopify only grants what is asked for here at OAuth time - the scopes
// listed in the app's own Dashboard config are just what it is ALLOWED to
// request, not what a given install actually gets. Read-only scopes are
// requested for data this app only displays and never writes (customers,
// discounts, order edits, reports); Shopify's own review guidance flags apps
// that request write access, or a scope, they have no real use for, so this
// list stops short of the app's full declared scope set on purpose. Deliberately
// left out: the customer_* / unauthenticated_* scopes, which belong to the
// separate Customer Account / Storefront APIs this app never calls.
export const DEFAULT_SCOPES = [
  'read_products', 'write_products',
  'read_inventory', 'write_inventory',
  'read_orders', 'write_orders',
  'read_fulfillments', 'write_fulfillments',
  // The buyer name shown on an order.
  'read_customers',
  // Discount code + amount shown on an order.
  'read_discounts', 'read_price_rules',
  // Order edits (an order changed after it was placed).
  'read_order_edits',
  // Shop Campaigns ad spend via ShopifyQL - also needs Shopify's separate
  // Level 2 Protected Customer Data approval before it returns real data.
  'read_reports',
];

const cleanDomain = (d) => String(d ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();

function validShopDomain(domain) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);
}

export function buildAuthorizationUrl({ shopDomain, scopes = DEFAULT_SCOPES, redirectUri }) {
  const shop = cleanDomain(shopDomain);
  if (!validShopDomain(shop)) throw badRequest('Enter the shop as "yourshop.myshopify.com".');
  const clientId = readSetting('shopify.oauth_client_id');
  if (!clientId) throw badRequest('Set the Client ID from your Shopify app before connecting.');

  const state = crypto.randomBytes(24).toString('base64url');
  const redirect = redirectUri || readSetting('shopify.redirect_uri');
  const scopeStr = scopes.join(',');

  getDb().prepare('INSERT INTO shopify_oauth_state (state, shop_domain, redirect_uri, scopes) VALUES (?,?,?,?)')
    .run(state, shop, redirect, scopeStr);
  getDb().prepare("DELETE FROM shopify_oauth_state WHERE created_at < datetime('now','-1 hour')").run();

  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', scopeStr);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);

  return { url: url.toString(), state, redirectUri: redirect, scopes };
}

/**
 * Shopify's documented HMAC check: every query param except hmac/signature,
 * sorted by key, joined "k=v" with "&", HMAC-SHA256 hex-digested with the
 * client secret. A mismatch means the callback did not really come from
 * Shopify (or the secret is wrong) - never exchange the code in that case.
 */
export function verifyHmac(query, clientSecret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest).sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmac), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeCode({ shop, code, state, query }) {
  const row = getDb().prepare('SELECT * FROM shopify_oauth_state WHERE state = ?').get(state);
  if (!row) throw badRequest('Unknown or expired connection attempt. Start connecting again.');
  getDb().prepare('DELETE FROM shopify_oauth_state WHERE state = ?').run(state);

  const shopDomain = cleanDomain(shop);
  if (shopDomain !== row.shop_domain) throw badRequest('Shop domain changed mid-connection. Start again.');

  const clientSecret = readSetting('shopify.oauth_client_secret');
  if (!clientSecret) throw badRequest('Set the Client Secret from your Shopify app before connecting.');
  if (!verifyHmac(query, clientSecret)) throw badRequest('Could not verify this came from Shopify (HMAC check failed).');

  const clientId = readSetting('shopify.oauth_client_id');
  const res = await outboundFetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw badRequest(`Token exchange failed: ${body.error_description || body.error || res.statusText}`);
  }

  // The store's own name, straight from the freshly-exchanged token - so the
  // stores list can show something better than a bare domain right away.
  // This connection is not saved yet, so the lookup targets it directly
  // rather than through whichever store happens to be active.
  let shopName = null;
  try {
    const data = await gql('{ shop { name } }', {}, { account: { shop_domain: shopDomain, admin_token: body.access_token } });
    shopName = data.shop?.name ?? null;
  } catch (err) {
    log.warn(`connected ${shopDomain}, but could not read its name: ${err.message}`);
  }

  const account = saveShopifyToken({ shopDomain, shopName, adminToken: body.access_token, connectedVia: 'oauth' });
  log.info(`connected ${shopDomain} (scope: ${body.scope})`);
  return { shopDomain, shopName, scope: body.scope, accountId: account.id };
}
