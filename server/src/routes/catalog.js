import { Router } from 'express';
import { asyncRoute, int, bool, num, required } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import * as catalog from '../services/catalog.js';
import * as links from '../services/productlinks.js';
import * as supplycheck from '../services/supplycheck.js';

const router = Router();

const shopsOf = (v) => {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  for (const s of list) if (!/^(etsy|shopify):\d+$/.test(s)) throw badRequest(`"${s}" is not a shop key.`);
  return list.length ? list : null;
};

/** Every connected Etsy shop and Shopify store. */
router.get('/shops', asyncRoute(async (req, res) => res.json({ shops: catalog.listShops() })));

/** The variants of the chosen shops (all of them by default). */
router.get('/variants', asyncRoute(async (req, res) => {
  res.json(catalog.variantRows({
    shops: shopsOf(req.query.shops),
    search: req.query.search ?? '',
    missingSku: bool(req.query.missingSku),
    missingSupply: bool(req.query.missingSupply),
    groupId: req.query.group ? int(req.query.group) : null,
    ungrouped: bool(req.query.ungrouped),
    duplicatesOnly: bool(req.query.duplicates),
    state: req.query.state ?? '',
    sort: req.query.sort ?? 'title',
    dir: req.query.dir ?? 'asc',
    limit: Math.min(1000, int(req.query.limit, 200)),
    offset: int(req.query.offset, 0),
  }));
}));

/**
 * SKU and supplier edits: { edits: [{ key, sku?, supplyLink?, variantSupplyLink?, supplierName? }], dryRun }.
 * Each is sent to the shop its key names - and nothing else about a product can be changed here.
 */
router.post('/changes', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['edits']);
  res.json(await catalog.applyChanges(req.body.edits, { dryRun: bool(req.body.dryRun) }));
}));

// ---------------------------------------------------------------- stock

/** What the last stock/picture checks said, for the variants on screen - free. */
router.post('/stock-cache', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['keys']);
  res.json({ checks: supplycheck.cachedFor(req.body.keys.slice(0, 500)) });
}));

/** A live supplier stock check (one paid API call) plus the picture check on its answer. */
router.post('/stock-check', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['key']);
  res.json(await supplycheck.check(req.body.key));
}));

/** The AI's second look at our picture against the supplier's first two. */
router.post('/image-check', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['key']);
  res.json(await supplycheck.checkImageWithAi(req.body.key, { provider: req.body.provider, model: req.body.model }));
}));

// ---------------------------------------------------------------- links

/** Products that look like the same thing in different shops. */
router.get('/suggestions', asyncRoute(async (req, res) => {
  res.json(await links.suggest({
    shops: shopsOf(req.query.shops),
    minScore: num(req.query.minScore) ?? 0.5,
    imageBudget: int(req.query.imageBudget, 40),
  }));
}));

router.get('/groups', asyncRoute(async (req, res) => res.json({ groups: links.listGroups() })));

/** The proposal for these products: paired variants, the SKU each pair would share, and what would change. */
router.post('/matrix', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['productKeys']);
  res.json(await links.matrix(req.body.productKeys, { baseSku: req.body.baseSku ?? '' }));
}));

/** Link the products and write the approved SKUs: { productKeys, slots: [{ sku, memberKeys }], title, dryRun }. */
router.post('/link', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['productKeys', 'slots']);
  res.json(await links.applyLink({
    productKeys: req.body.productKeys, slots: req.body.slots, title: req.body.title ?? '', dryRun: bool(req.body.dryRun),
  }));
}));

/** Only remember that these are the same product - no SKU is written. */
router.post('/groups', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['productKeys']);
  res.status(201).json({ groupId: links.linkProducts(req.body.productKeys, { title: req.body.title ?? '' }) });
}));

router.delete('/groups/:id', asyncRoute(async (req, res) => res.json(links.deleteGroup(int(req.params.id)))));

router.post('/unlink', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['productKey']);
  res.json(links.unlinkProduct(req.body.productKey));
}));

/** "These are not the same product." */
router.post('/reject', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['a', 'b']);
  res.json(links.rejectPair(req.body.a, req.body.b));
}));

export default router;
