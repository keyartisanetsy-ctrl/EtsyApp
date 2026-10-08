import { Router } from 'express';
import { asyncRoute, int, bool, num, required } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import * as catalog from '../services/catalog.js';
import * as links from '../services/productlinks.js';
import * as supplycheck from '../services/supplycheck.js';
import * as autosku from '../services/autosku.js';
import * as skutypes from '../services/skutypes.js';
import * as stockSvc from '../services/stock.js';
import * as stockList from '../services/stocklist.js';

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
    stockFilter: ['oversell', 'zero', 'untracked', 'tracked'].includes(req.query.stock) ? req.query.stock : '',
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

/** Optional AI look at whether pairs of suggested products are the same thing - only when asked for. */
router.post('/ai-compare', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['pairs']);
  res.json(await links.compareWithAi(req.body.pairs, { provider: req.body.provider, model: req.body.model }));
}));

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
  if (Array.isArray(req.body?.keys)) return res.json(links.rejectPairs(req.body.keys));   // every pair among the picked products
  required(req.body ?? {}, ['a', 'b']);
  res.json(links.rejectPair(req.body.a, req.body.b));
}));

// -------------------------------------------------------------- real stock

/** The real-stock page: one row per SKU. */
router.get('/stock/list', asyncRoute(async (req, res) => {
  res.json(stockList.list({
    search: req.query.search ?? '', filter: req.query.filter ?? '', sort: req.query.sort ?? 'sku', dir: req.query.dir ?? 'asc',
    limit: Math.min(500, int(req.query.limit, 100)), offset: int(req.query.offset, 0),
  }));
}));

/** Everything that ever changed the real stock of one SKU. */
router.get('/stock/history', asyncRoute(async (req, res) => {
  required(req.query ?? {}, ['sku']);
  res.json(stockList.history(String(req.query.sku), { limit: int(req.query.limit, 500) }));
}));

/** How the real stock of a SKU moved: the order lines that took pieces off it. */
router.get('/stock/movements', asyncRoute(async (req, res) => {
  required(req.query ?? {}, ['sku']);
  res.json({ movements: stockSvc.movements(String(req.query.sku)) });
}));

/** The real counts of these SKUs: { skus: [...] } -> { real: { sku: { qty, countedAt } } } */
router.post('/stock/real-map', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['skus']);
  res.json({ real: stockSvc.realMap(req.body.skus) });
}));

/** Set (or, with qty null / blank, stop keeping) the real count of one SKU. */
router.post('/stock/real', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['sku']);
  const { sku, qty } = req.body;
  if (qty === null || qty === undefined || String(qty).trim() === '') { stockSvc.clearReal(sku); return res.json({ sku, qty: null }); }
  const r = stockSvc.setReal(sku, qty);
  stockSvc.applyOrders();   // orders that came in after this count take their pieces off at once
  res.json({ sku: r.sku, qty: stockSvc.realFor(r.sku)?.qty ?? r.qty });
}));

/** Take new orders off the real stock now (the scheduler does it every two minutes). */
router.post('/stock/apply-orders', asyncRoute(async (req, res) => res.json(stockSvc.applyOrders())));

// ----------------------------------------------------------- automatic SKUs

/** What automatic SKUs would be handed out (nothing is written): the plan, product by product. */
const planOptions = (b) => ({
    shops: shopsOf(b.shops),
    productKeys: Array.isArray(b.productKeys) ? b.productKeys.slice(0, 5000) : null,
    prefix: String(b.prefix ?? ''),
    numbering: ['1', '01'].includes(String(b.numbering)) ? String(b.numbering) : 'auto',
    includeInactive: bool(b.includeInactive),
    linkMatches: b.linkMatches === undefined ? true : bool(b.linkMatches),
    imageBudget: Math.min(300, int(b.imageBudget, 120)),
    prefixMode: b.prefixMode === 'single' ? 'single' : 'type',
    types: Array.isArray(b.types) ? b.types.slice(0, 60) : null,
    matchSets: Array.isArray(b.matchSets) ? b.matchSets.slice(0, 500).map((set) => (Array.isArray(set) ? set.slice(0, 12).map(String) : [])) : null,
});
router.post('/auto-sku/plan', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  // the page asks for a background job (a whole catalogue takes longer than a web request may); a plain call still answers directly
  if (bool(b.async)) return res.status(202).json(autosku.startPlan(planOptions(b)));
  return res.json(await autosku.plan(planOptions(b)));
}));
router.get('/auto-sku/plan/:jobId', asyncRoute(async (req, res) => res.json(autosku.planJob(req.params.jobId))));

/** The product types (and the SKU letters each gets) the automatic SKUs use. */
router.get('/auto-sku/types', asyncRoute(async (req, res) => res.json({ types: skutypes.loadTypes(), defaults: skutypes.DEFAULT_TYPES })));
router.put('/auto-sku/types', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['types']);
  res.json({ types: skutypes.saveTypes(req.body.types) });
}));
router.delete('/auto-sku/types', asyncRoute(async (req, res) => res.json({ types: skutypes.resetTypes() })));

/** Write the approved part of a plan, a few products at a time: { units: [{ id, edits: [{ key, sku }], link }], dryRun }. */
router.post('/auto-sku/apply', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['units']);
  res.json(await autosku.applyUnits(req.body.units, { dryRun: bool(req.body.dryRun) }));
}));

export default router;
