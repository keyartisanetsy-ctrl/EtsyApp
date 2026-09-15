import { Router } from 'express';
import { asyncRoute, bool, int, required } from '../lib/http.js';
import * as client from '../shopify/client.js';
import * as oauth from '../shopify/oauth.js';
import * as shopify from '../services/shopify.js';
import { readSetting, writeSetting } from '../services/settings.js';
import { maskSecret } from '../lib/crypto.js';

const router = Router();

// ------------------------------------------------------------- connection

router.get('/status', asyncRoute(async (req, res) => {
  const creds = client.getCredentials();
  res.json({
    shopDomain: creds.shopDomain,
    apiVersion: creds.apiVersion,
    hasClientId: !!creds.clientId,
    clientIdPreview: creds.clientId ? maskSecret(creds.clientId) : null,
    hasClientSecret: !!creds.clientSecret,
    connected: !!creds.adminToken,
    tokenPreview: creds.adminToken ? maskSecret(creds.adminToken) : null,
    connectedVia: creds.connectedVia || null,
  });
}));

router.put('/shop-domain', asyncRoute(async (req, res) => {
  writeSetting('shopify.shop_domain', req.body?.domain ?? '');
  res.json(client.getCredentials());
}));

router.put('/api-version', asyncRoute(async (req, res) => {
  writeSetting('shopify.api_version', req.body?.version || '2025-01');
  res.json(client.getCredentials());
}));

router.put('/oauth-app', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['clientId']);
  writeSetting('shopify.oauth_client_id', req.body.clientId);
  if (req.body.clientSecret) writeSetting('shopify.oauth_client_secret', req.body.clientSecret);
  res.json(client.getCredentials());
}));

/** Path A: start the OAuth dance with a Dev Dashboard app. */
router.post('/oauth/connect', asyncRoute(async (req, res) => {
  const shopDomain = req.body?.shopDomain || readSetting('shopify.shop_domain');
  required({ shopDomain }, ['shopDomain']);
  res.json(oauth.buildAuthorizationUrl({ shopDomain }));
}));

// Shopify redirects the browser here once the merchant approves.
router.get('/oauth/callback', asyncRoute(async (req, res) => {
  const { shop, code, state, hmac, host, timestamp } = req.query;
  if (!shop || !code || !state) return res.status(400).send(page('Missing parameters', 'Shopify did not return shop/code/state.', false));
  try {
    const result = await oauth.exchangeCode({ shop: String(shop), code: String(code), state: String(state), query: req.query });
    res.send(page('Shop connected', `${result.shopDomain} is connected. You can close this tab.`, true));
  } catch (err) {
    res.status(err.status ?? 500).send(page('Could not connect', err.message, false));
  }
}));

/** Path B: paste a custom-app "Admin API access token" directly. */
router.post('/token', asyncRoute(async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  if (!token) { client.disconnect(); return res.json({ connected: false }); }
  client.saveAdminToken(token, { via: 'custom' });
  res.json({ connected: true });
}));

router.delete('/token', asyncRoute(async (req, res) => { client.disconnect(); res.json({ disconnected: true }); }));

/** Live check: does the token actually work. */
router.get('/test', asyncRoute(async (req, res) => res.json(await client.testConnection())));

// ---------------------------------------------------------------- sync

router.post('/sync/products', asyncRoute(async (req, res) => res.json(await shopify.syncProducts())));
router.post('/sync/orders', asyncRoute(async (req, res) => res.json(await shopify.syncOrders({ pages: int(req.body?.pages, 5) }))));

// ------------------------------------------------------------- products

router.get('/products', asyncRoute(async (req, res) => {
  res.json(shopify.listProducts({
    search: req.query.search ?? '', status: req.query.status ?? '', missingSku: bool(req.query.missingSku),
    limit: int(req.query.limit, 200), offset: int(req.query.offset, 0),
  }));
}));

router.get('/products/:id', asyncRoute(async (req, res) => res.json(shopify.getProduct(req.params.id))));

router.put('/products/:id', asyncRoute(async (req, res) => res.json(await shopify.updateProduct(req.params.id, req.body ?? {}))));

/** Patch SKU/price/compare-at/cost on several variants of one product: { changes: { [variantId]: {...} } } */
router.put('/products/:id/variants', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['changes']);
  res.json(await shopify.updateVariants(req.params.id, req.body.changes));
}));

router.put('/variants/meta/:sku', asyncRoute(async (req, res) => {
  res.json(shopify.saveVariantMeta(decodeURIComponent(req.params.sku), req.body ?? {}));
}));

// ---------------------------------------------------------------- orders

router.get('/orders', asyncRoute(async (req, res) => {
  res.json(shopify.listOrders({ search: req.query.search ?? '', limit: int(req.query.limit, 100), offset: int(req.query.offset, 0) }));
}));

router.get('/orders/:id', asyncRoute(async (req, res) => res.json(shopify.getOrder(req.params.id))));

router.post('/orders/:id/shipping-cost', asyncRoute(async (req, res) => {
  res.json(shopify.setShippingCost(req.params.id, { cost: req.body?.cost, currency: req.body?.currency }));
}));

/** Add tracking and mark the order fulfilled on Shopify. */
router.post('/orders/:id/fulfill', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['trackingNumber']);
  res.json(await shopify.pushFulfillment(req.params.id, req.body));
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
