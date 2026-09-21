import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import config from '../config.js';
import { asyncRoute, bool, int, required } from '../lib/http.js';
import * as client from '../shopify/client.js';
import * as oauth from '../shopify/oauth.js';
import * as shopify from '../services/shopify.js';
import * as shopcampaigns from '../services/shopcampaigns.js';
import * as warehouse from '../services/warehousecheck.js';
import { currentShopifyShop } from '../shopify/shop.js';
import { readSetting, writeSetting } from '../services/settings.js';
import { maskSecret, sha256 } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { getDb } from '../db/index.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ------------------------------------------------------------- accounts

router.get('/accounts', asyncRoute(async (req, res) => res.json(client.listShopifyAccounts())));

/** Switch which connected store the screens work with. */
router.post('/accounts/:id/activate', asyncRoute(async (req, res) => {
  res.json(client.setActiveShopifyAccount(Number(req.params.id)));
}));

router.put('/accounts/:id', asyncRoute(async (req, res) => {
  const { label, airtableName } = req.body ?? {};
  const id = Number(req.params.id);
  if (label !== undefined) client.renameShopifyAccount(id, label);
  if (airtableName !== undefined) client.setShopifyAirtableName(id, airtableName);
  res.json(client.listShopifyAccounts());
}));

/** Disconnect one store. Its mirrored data is removed with it unless asked otherwise. */
router.delete('/accounts/:id', asyncRoute(async (req, res) => {
  res.json(client.removeShopifyAccount(Number(req.params.id), { purgeData: req.body?.keepData !== true }));
}));

// ------------------------------------------------------------- connection

router.get('/status', asyncRoute(async (req, res) => {
  const creds = client.getCredentials();
  const accounts = client.listShopifyAccounts();
  res.json({
    shop: currentShopifyShop(),
    accounts,
    accountCount: accounts.length,
    apiVersion: creds.apiVersion,
    hasClientId: !!creds.clientId,
    clientIdPreview: creds.clientId ? maskSecret(creds.clientId) : null,
    hasClientSecret: !!creds.clientSecret,
    connected: !!creds.adminToken,
    tokenPreview: creds.adminToken ? maskSecret(creds.adminToken) : null,
    connectedVia: creds.connectedVia || null,
  });
}));

router.put('/oauth-app', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['clientId']);
  writeSetting('shopify.oauth_client_id', req.body.clientId);
  if (req.body.clientSecret) writeSetting('shopify.oauth_client_secret', req.body.clientSecret);
  res.json({ hasClientId: !!readSetting('shopify.oauth_client_id'), hasClientSecret: !!readSetting('shopify.oauth_client_secret') });
}));

/** Path A: start the OAuth dance with a Dev Dashboard app, for a specific store. */
router.post('/oauth/connect', asyncRoute(async (req, res) => {
  const shopDomain = req.body?.shopDomain;
  required({ shopDomain }, ['shopDomain']);
  res.json(oauth.buildAuthorizationUrl({ shopDomain }));
}));

// Shopify redirects the browser here once the merchant approves.
router.get('/oauth/callback', asyncRoute(async (req, res) => {
  const { shop, code, state } = req.query;
  if (!shop || !code || !state) return res.status(400).send(page('Missing parameters', 'Shopify did not return shop/code/state.', false));
  try {
    const result = await oauth.exchangeCode({ shop: String(shop), code: String(code), state: String(state), query: req.query });
    res.send(page('Store connected', `${result.shopName || result.shopDomain} is connected. You can close this tab.`, true));
  } catch (err) {
    res.status(err.status ?? 500).send(page('Could not connect', err.message, false));
  }
}));

/** Path B: paste a custom-app "Admin API access token" directly, for a specific store. */
router.post('/token', asyncRoute(async (req, res) => {
  const shopDomain = req.body?.shopDomain;
  const token = String(req.body?.token ?? '').trim();
  required({ shopDomain }, ['shopDomain']);
  if (!token) throw badRequest('Paste the Admin API access token.');
  const account = client.saveShopifyToken({ shopDomain, adminToken: token, connectedVia: 'custom' });
  res.json({ connected: true, accountId: account.id });
}));

/** Live check: does the active store's token actually work. */
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

/** The supplier's own order reference and the inbound supplier-to-warehouse tracking number. */
router.post('/orders/:id/supplier-info', asyncRoute(async (req, res) => {
  res.json(shopify.setSupplierInfo(req.params.id, req.body ?? {}));
}));

// ------------------------------------------- warehouse photo + AI check

/** A photo taken at the warehouse, held next to this item's own listing image. */
router.post('/orders/:id/items/:lineItemId/warehouse-photo', upload.single('photo'), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('Attach the photo as "photo".');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const id = `att_${crypto.randomBytes(8).toString('hex')}`;
  const ext = path.extname(req.file.originalname) || '.jpg';
  const dest = path.join(config.uploadDir, `${id}${ext}`);
  fs.writeFileSync(dest, req.file.buffer);
  getDb().prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.file.originalname, req.file.mimetype, req.file.size, dest, sha256(req.file.buffer), 'warehouse-photo');
  res.status(201).json(shopify.setWarehousePhoto(req.params.id, req.params.lineItemId, id));
}));

router.delete('/orders/:id/items/:lineItemId/warehouse-photo', asyncRoute(async (req, res) => {
  res.json(shopify.setWarehousePhoto(req.params.id, req.params.lineItemId, null));
}));

/** Compare the warehouse photo against the item's own listing image. */
router.post('/orders/:id/items/:lineItemId/warehouse-check', asyncRoute(async (req, res) => {
  res.json(await warehouse.checkItem({
    channel: 'shopify',
    itemId: req.params.lineItemId,
    provider: req.body?.provider,
    model: req.body?.model,
  }));
}));

router.get('/orders/:id/items/:lineItemId/warehouse-check', asyncRoute(async (req, res) => {
  res.json(warehouse.getCheck('shopify', req.params.lineItemId) ?? { checked: false });
}));

// ------------------------------------------------------- shop campaigns ads

/** What Shopify's own Shop Campaigns ads have cost lately, per campaign. */
router.get('/campaigns/ad-spend', asyncRoute(async (req, res) => {
  res.json(await shopcampaigns.campaignAdSpend({ sinceDays: int(req.query.sinceDays, 30) }));
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
