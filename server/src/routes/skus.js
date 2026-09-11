import { Router } from 'express';
import * as skugen from '../services/skugen.js';
import { asyncRoute, int, bool, num, required, ids } from '../lib/http.js';
import * as inventory from '../services/inventory.js';
import { syncVariationImages, syncAllVariationImages } from '../services/sync.js';

const router = Router();

/** The SKU grid: one row per variation with pricing, images and supply link. */
router.get('/', asyncRoute(async (req, res) => {
  res.json(inventory.skuGrid({
    search: req.query.search ?? '',
    state: req.query.state ?? '',
    listingId: int(req.query.listingId),
    sectionId: int(req.query.sectionId),
    missingSku: bool(req.query.missingSku),
    missingSupply: bool(req.query.missingSupply),
    discountPercent: num(req.query.discountPercent),
    sort: req.query.sort ?? 'title',
    dir: req.query.dir ?? 'asc',
    limit: int(req.query.limit, 500),
    offset: int(req.query.offset, 0),
  }));
}));

router.get('/duplicates', asyncRoute(async (req, res) => res.json(inventory.duplicateSkus())));

router.get('/price-for-target', asyncRoute(async (req, res) => {
  res.json({ listPrice: inventory.priceForTarget(num(req.query.target), num(req.query.percent) ?? undefined) });
}));

router.get('/inventory/:listingId', asyncRoute(async (req, res) => {
  res.json(await inventory.fetchInventory(Number(req.params.listingId)));
}));

/** Patch variations on one listing: { changes: { [productId]: {...} } } */
router.put('/inventory/:listingId', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['changes']);
  res.json(await inventory.updateVariations(Number(req.params.listingId), req.body.changes, { dryRun: bool(req.query.dryRun) }));
}));

router.post('/inventory/:listingId/clear-skus', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['productIds']);
  res.json(await inventory.clearSkus(Number(req.params.listingId), ids(req.body.productIds), { dryRun: bool(req.query.dryRun) }));
}));

router.delete('/inventory/:listingId/variations', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['productIds']);
  res.json(await inventory.deleteVariations(Number(req.params.listingId), ids(req.body.productIds), { dryRun: bool(req.query.dryRun) }));
}));

router.post('/inventory/:listingId/variation-images/sync', asyncRoute(async (req, res) => {
  res.json({ mapped: await syncVariationImages(Number(req.params.listingId)) });
}));

/** The same "ask Etsy again" for every listing in the shop, not just one. */
router.post('/variation-images/sync-all', asyncRoute(async (req, res) => {
  res.json(await syncAllVariationImages());
}));

// -------------------------------------------------------- supply metadata

router.get('/:sku/meta', asyncRoute(async (req, res) => res.json(inventory.getSkuMeta(req.params.sku))));

router.put('/:sku/meta', asyncRoute(async (req, res) => res.json(inventory.setSkuMeta(req.params.sku, req.body ?? {}))));

router.delete('/:sku/meta', asyncRoute(async (req, res) => {
  inventory.deleteSkuMeta(req.params.sku);
  res.json({ deleted: req.params.sku });
}));

/** Bulk-attach supply links: { items: [{sku, supplyLink, supplyCost, ...}] } */
router.put('/meta/bulk', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['items']);
  const saved = req.body.items.map((item) => inventory.setSkuMeta(item.sku, item));
  res.json({ saved: saved.length, items: saved });
}));

// ------------------------------------------------------------ SKU generator

/** Propose SKUs. Nothing is written until the plan is applied. */
router.post('/generate/plan', asyncRoute(async (req, res) => {
  const { listingIds = [], mode = 'rule', prefix, pattern, overwrite = false, startAt, provider } = req.body ?? {};
  res.json(mode === 'ai'
    ? await skugen.planByAi({ listingIds, provider })
    : skugen.planByRule({ listingIds, prefix, pattern, overwrite, startAt: Number(startAt) || null }));
}));

/** Write an approved plan into the local mirror. */
router.post('/generate/apply', asyncRoute(async (req, res) => {
  res.json(skugen.applyPlan(req.body?.plan ?? {}));
}));

export default router;
