import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import * as client from '../airtable/client.js';
import * as service from '../services/airtable.js';
import { SOURCE_FIELDS } from '../airtable/fields.js';
import { readSetting, writeSetting } from '../services/settings.js';
import { maskSecret } from '../lib/crypto.js';
import { currentShop } from '../etsy/shop.js';
import { listAccounts, setAirtableName } from '../etsy/client.js';
import * as fx from '../services/fx.js';
import * as variantImages from '../services/variantimages.js';

const router = Router();

// -------------------------------------------------------------- connection

router.get('/status', asyncRoute(async (req, res) => {
  const token = client.getToken();
  res.json({
    connected: !!token,
    tokenPreview: token ? maskSecret(token) : null,
    autoPush: readSetting('airtable.auto_push') === 'true',
    destinations: service.listDestinations(),
    shop: currentShop(),
  });
}));

router.post('/token', asyncRoute(async (req, res) => {
  writeSetting('airtable.token', String(req.body?.token ?? '').trim());
  res.json({ saved: true, connected: client.hasToken() });
}));

/** Live check: does this token actually work, and what can it see? */
router.get('/test', asyncRoute(async (req, res) => res.json(await client.testToken())));

// ------------------------------------------------------------------ schema

router.get('/bases', asyncRoute(async (req, res) => res.json(await client.listBases())));

router.get('/bases/:baseId/tables', asyncRoute(async (req, res) => {
  res.json(await client.listTables(req.params.baseId));
}));

/** The fields this app can send, for the mapping dropdowns. */
router.get('/source-fields', asyncRoute(async (req, res) => {
  res.json(SOURCE_FIELDS.map(({ key, label, group, hint }) => ({ key, label, group, hint })));
}));

// ------------------------------------------------------------ destinations

router.get('/destinations', asyncRoute(async (req, res) => res.json(service.listDestinations())));
router.get('/destinations/:id', asyncRoute(async (req, res) => res.json(service.getDestination(Number(req.params.id)))));
router.post('/destinations', asyncRoute(async (req, res) => res.json(service.saveDestination(req.body ?? {}))));
router.put('/destinations/:id', asyncRoute(async (req, res) => {
  res.json(service.saveDestination({ ...req.body, id: Number(req.params.id) }));
}));
router.delete('/destinations/:id', asyncRoute(async (req, res) => {
  res.json(service.deleteDestination(Number(req.params.id)));
}));

// ---------------------------------------------------------------- matching

/**
 * Propose a field mapping. `mode=name` matches column names offline;
 * `mode=ai` asks the configured AI provider. Either way the answer comes back
 * as a plain, editable list - nothing is saved until the user says so.
 */
router.post('/match', asyncRoute(async (req, res) => {
  const { baseId, tableId, mode = 'name', provider, rowMode = 'item' } = req.body ?? {};
  res.json(await service.proposeMapping({ baseId, tableId, mode, provider, rowMode }));
}));

// -------------------------------------------------------------------- push

/** What would be sent, without sending it. */
router.post('/preview', asyncRoute(async (req, res) => {
  const { destinationId, receiptIds = [], mode = 'upsert' } = req.body ?? {};
  res.json(await service.push({ destinationId, receiptIds, mode, dryRun: true }));
}));

router.post('/push', asyncRoute(async (req, res) => {
  const { destinationId, receiptIds = [], mode = 'upsert' } = req.body ?? {};
  res.json(await service.push({ destinationId, receiptIds, mode }));
}));

/** Which of these orders are already in Airtable, for the list badges. */
router.post('/synced', asyncRoute(async (req, res) => {
  res.json(service.syncedReceiptIds(req.body?.receiptIds ?? []));
}));

router.get('/runs', asyncRoute(async (req, res) => res.json(service.listRuns(Number(req.query.limit) || 20))));

// ------------------------------------------------------------- shop names

/**
 * What each connected shop is called in Airtable. This is what a shop /
 * MAĞAZA column gets filled with, and it is what decides which per-shop view
 * a row shows up in, so it is worth setting explicitly.
 */
router.get('/shop-names', asyncRoute(async (req, res) => {
  res.json(listAccounts().map((a) => ({
    shopId: a.shopId,
    shopName: a.shopName,
    airtableName: a.airtableName || a.shopName || '',
    isCustom: !!a.airtableName,
    isActive: a.isActive,
  })));
}));

router.put('/shop-names/:shopId', asyncRoute(async (req, res) => {
  setAirtableName(Number(req.params.shopId), req.body?.name ?? '');
  res.json(listAccounts().map((a) => ({
    shopId: a.shopId, shopName: a.shopName, airtableName: a.airtableName || a.shopName || '', isActive: a.isActive,
  })));
}));

/** The options an Airtable select column already offers, to pick a name from. */
router.get('/bases/:baseId/tables/:tableId/choices', asyncRoute(async (req, res) => {
  const table = await client.getTable(req.params.baseId, req.params.tableId);
  res.json(table.fields
    .filter((f) => f.choices?.length)
    .map((f) => ({ name: f.name, type: f.type, choices: f.choices })));
}));

// ----------------------------------------------------------- exchange rates

/** The daily rate table, newest first, plus what is covered. */
router.get('/rates', asyncRoute(async (req, res) => {
  res.json({
    coverage: fx.coverage(),
    rates: fx.listRates({ quote: req.query.quote || 'CNY', limit: Number(req.query.limit) || 120 }),
  });
}));

router.post('/rates/refresh', asyncRoute(async (req, res) => res.json(await fx.refreshRates())));

/** What one currency was worth in another on a given day. */
// Today's rates, for the "≈ $12.40" hints next to prices entered in another
// currency. Cheap enough for any screen to ask for on load.
router.get('/rates/latest', asyncRoute(async (req, res) => {
  try { await fx.ensureRates(); } catch { /* stored rates still answer */ }
  res.json(fx.latest());
}));

router.get('/rates/on/:day', asyncRoute(async (req, res) => {
  const { from = 'CNY', to = 'USD' } = req.query;
  res.json(fx.rateDetail(req.params.day, from, to) ?? { rate: null, note: 'No rate stored for that day yet.' });
}));

// ---------------------------------------------------------- variant images

/** Pull the per-variation photos for the listings behind these orders. */
router.post('/variant-images/sync', asyncRoute(async (req, res) => {
  res.json(await variantImages.syncForReceipts(req.body?.receiptIds ?? []));
}));

router.get('/variant-images/stats', asyncRoute(async (req, res) => res.json(variantImages.stats())));

export default router;
