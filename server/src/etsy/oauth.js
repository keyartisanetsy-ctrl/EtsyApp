/**
 * Etsy OAuth 2.0 Authorization Code flow with PKCE.
 * Reference: https://developers.etsy.com/documentation/essentials/authentication
 */
import crypto from 'node:crypto';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { getCredentials, saveToken, request, call, clientId } from './client.js';
import { ALL_SCOPES } from './operations.generated.js';
import { EtsyApiError, badRequest } from '../lib/errors.js';
import { outboundFetch } from '../lib/outbound.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('oauth');

/** Every scope the reference defines, plus the write scopes Etsy lists but
 *  that no single operation declares (address_w, profile_r/w). */
export const DEFAULT_SCOPES = [...new Set([...ALL_SCOPES, 'address_w', 'profile_r', 'profile_w'])].sort();

const b64url = (buf) => buf.toString('base64url');

export function buildAuthorizationUrl({ scopes = DEFAULT_SCOPES, redirectUri } = {}) {
  const creds = getCredentials();
  if (!creds.keystring) throw badRequest('Set your Etsy keystring in Settings before connecting.');

  const codeVerifier = b64url(crypto.randomBytes(48));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const redirect = redirectUri || creds.redirectUri;
  const scopeStr = scopes.join(' ');

  getDb()
    .prepare('INSERT INTO oauth_state (state, code_verifier, redirect_uri, scopes) VALUES (?,?,?,?)')
    .run(state, codeVerifier, redirect, scopeStr);
  // Stale in-flight authorisations are useless after an hour.
  getDb().prepare("DELETE FROM oauth_state WHERE created_at < datetime('now','-1 hour')").run();

  const url = new URL(config.etsy.connectUrl);
  url.searchParams.set('response_type', 'code');
  // OAuth identifies the app by the bare keystring, not the api-key pair.
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('scope', scopeStr);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state, redirectUri: redirect, scopes };
}

export async function exchangeCode({ code, state }) {
  const row = getDb().prepare('SELECT * FROM oauth_state WHERE state = ?').get(state);
  if (!row) throw badRequest('Unknown or expired OAuth state. Start the connection again.');
  getDb().prepare('DELETE FROM oauth_state WHERE state = ?').run(state);

  const res = await outboundFetch(config.etsy.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId(),
      redirect_uri: row.redirect_uri,
      code,
      code_verifier: row.code_verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EtsyApiError(res.status, `Token exchange failed: ${body.error_description || body.error || res.statusText}`, { body });
  }

  // Etsy encodes the user id as the prefix of the access token: "<user_id>.<token>".
  const userId = Number(String(body.access_token).split('.')[0]) || null;

  // Resolve which shop this token belongs to BEFORE writing anything. Doing
  // this with the freshly-exchanged token directly (accessToken:) rather than
  // saving first and looking it up afterwards means exactly one row is ever
  // written per connection -- the earlier two-step version left a permanent
  // orphan row behind (shop_id NULL) on every single connect, which could
  // also get silently reused by the NEXT shop's connection.
  let shop = null;
  try {
    const me = await call('getMe', {}, { accessToken: body.access_token });
    shop = await call('getShopByOwnerUserId', { user_id: me.user_id ?? userId }, { accessToken: body.access_token });
  } catch (err) {
    log.warn(`connected, but shop lookup failed: ${err.message}`);
  }

  const shopId = shop?.shop_id ?? shop?.results?.[0]?.shop_id ?? null;
  const shopName = shop?.shop_name ?? shop?.results?.[0]?.shop_name ?? null;

  saveToken({ ...body, user_id: userId, shop_id: shopId, shop_name: shopName, scopes: row.scopes });

  log.info(`connected shop ${shopName ?? '(unknown)'} (${shopId ?? 'no id - shop lookup failed, reconnect to retry'})`);
  return { userId, shopId, shopName, scopes: row.scopes };
}

/** Ask Etsy which scopes the stored token actually carries. */
export async function verifyScopes() {
  return request('/v3/application/scopes', { method: 'POST', auth: true, operationId: 'tokenScopes' });
}
