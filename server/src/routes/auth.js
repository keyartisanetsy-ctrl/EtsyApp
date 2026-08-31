import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import { buildAuthorizationUrl, exchangeCode, verifyScopes, DEFAULT_SCOPES } from '../etsy/oauth.js';
import { getStoredToken, disconnect, getCredentials, call } from '../etsy/client.js';
import { currentShop } from '../etsy/shop.js';
import { OPERATION_COUNT } from '../etsy/operations.generated.js';

const router = Router();

router.get('/status', asyncRoute(async (req, res) => {
  const token = getStoredToken();
  const creds = getCredentials();
  res.json({
    connected: !!token,
    hasKeystring: !!creds.keystring,
    redirectUri: creds.redirectUri,
    shop: currentShop(),
    scopes: token?.scopes?.split(' ').filter(Boolean) ?? [],
    expiresAt: token?.expires_at ?? null,
    connectedAt: token?.connected_at ?? null,
    availableScopes: DEFAULT_SCOPES,
    operationCount: OPERATION_COUNT,
  });
}));

router.post('/connect', asyncRoute(async (req, res) => {
  const { scopes, redirectUri } = req.body ?? {};
  res.json(buildAuthorizationUrl({
    scopes: Array.isArray(scopes) && scopes.length ? scopes : DEFAULT_SCOPES,
    redirectUri,
  }));
}));

// Etsy redirects the browser here after the seller approves.
router.get('/callback', asyncRoute(async (req, res) => {
  const { code, state, error, error_description: description } = req.query;
  if (error) return res.status(400).send(page('Authorisation refused', `${error}: ${description ?? ''}`, false));
  if (!code || !state) return res.status(400).send(page('Missing code', 'Etsy did not return an authorisation code.', false));

  try {
    const result = await exchangeCode({ code: String(code), state: String(state) });
    res.send(page('Shop connected', `${result.shopName ?? 'Your shop'} is connected. You can close this tab.`, true));
  } catch (err) {
    res.status(err.status ?? 500).send(page('Could not connect', err.message, false));
  }
}));

router.post('/disconnect', asyncRoute(async (req, res) => {
  disconnect();
  res.json({ disconnected: true });
}));

router.get('/scopes', asyncRoute(async (req, res) => res.json(await verifyScopes())));

router.get('/ping', asyncRoute(async (req, res) => {
  res.json(await call('ping', {}, { auth: false }));
}));

const page = (title, message, ok) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
 .card{background:#1e293b;padding:40px 48px;border-radius:14px;text-align:center;max-width:460px;
       border-top:4px solid ${ok ? '#22c55e' : '#ef4444'}}
 h1{margin:0 0 12px;font-size:20px}p{margin:0;color:#94a3b8}
</style>
<div class="card"><h1>${title}</h1><p>${message}</p></div>`;

export default router;
