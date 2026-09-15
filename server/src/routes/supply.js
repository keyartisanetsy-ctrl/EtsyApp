import { Router } from 'express';
import { asyncRoute, bool, int, required } from '../lib/http.js';
import * as taobao from '../services/taobao.js';
import { readSetting, writeSetting } from '../services/settings.js';
import { maskSecret } from '../lib/crypto.js';

const router = Router();

/** The supply book, with margin worked out against what each SKU sells for. */
router.get('/', asyncRoute(async (req, res) => {
  res.json({
    suppliers: taobao.SUPPLIERS,
    coverage: taobao.coverage(),
    items: taobao.list({
      search: req.query.search ?? '',
      supplier: req.query.supplier ?? '',
      missingLink: bool(req.query.missingLink),
      limit: int(req.query.limit, 500),
    }),
  });
}));

/** Read a pasted link without saving it, so the form can fill itself in. */
router.get('/parse', asyncRoute(async (req, res) => {
  required(req.query, ['url']);
  res.json(taobao.parseSupplyUrl(req.query.url));
}));

// ---------------------------------------------------------- stock settings
//
// These, and every /stock-* and /duplicates route below, must stay ABOVE the
// generic /:sku routes further down - otherwise Express reads "stock-cache"
// etc. as a literal SKU and the real handler never runs.

/** The OneBound key/secret this app checks stock with - editable, with defaults already set. */
router.get('/stock-settings', asyncRoute(async (req, res) => {
  const key = readSetting('taobao.onebound_key');
  const secret = readSetting('taobao.onebound_secret');
  res.json({
    key,
    hasSecret: !!secret,
    secretPreview: secret ? maskSecret(secret) : null,
  });
}));

router.put('/stock-settings', asyncRoute(async (req, res) => {
  if (req.body?.key !== undefined) writeSetting('taobao.onebound_key', req.body.key);
  if (req.body?.secret) writeSetting('taobao.onebound_secret', req.body.secret);
  const key = readSetting('taobao.onebound_key');
  const secret = readSetting('taobao.onebound_secret');
  res.json({ key, hasSecret: !!secret, secretPreview: secret ? maskSecret(secret) : null });
}));

/**
 * A live OneBound check, from any supply URL (Etsy or Shopify - it does not
 * care which). Only ever runs when this is called, since OneBound bills per
 * call regardless of the outcome.
 */
router.post('/stock-check', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['url']);
  res.json(await taobao.checkStockByUrl(req.body.url));
}));

/** The last cached check for whatever supply URL this row has, at no cost. */
router.get('/stock-cache', asyncRoute(async (req, res) => {
  required(req.query, ['url']);
  const parsed = taobao.parseSupplyUrl(req.query.url);
  if (!parsed.ok || !parsed.itemId) return res.json(null);
  res.json(taobao.cachedStock({ supplier: parsed.supplier, itemId: parsed.itemId }));
}));

/** SKUs (Etsy or Shopify) that point at the same supplier product. */
router.get('/duplicates', asyncRoute(async (req, res) => res.json(taobao.findSharedSupplyLinks())));

// ------------------------------------------------------------------ per-SKU

router.get('/:sku', asyncRoute(async (req, res) => {
  res.json(taobao.getItem(req.params.sku) ?? { sku: req.params.sku, missing: true });
}));

router.put('/:sku', asyncRoute(async (req, res) => {
  res.json(taobao.saveItem({ ...req.body, sku: req.params.sku }));
}));

router.delete('/:sku', asyncRoute(async (req, res) => res.json(taobao.removeItem(req.params.sku))));

/** Bring the old Taobao sheet across in one paste. */
router.post('/import', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['text']);
  res.json(taobao.importRows(req.body.text));
}));

export default router;
