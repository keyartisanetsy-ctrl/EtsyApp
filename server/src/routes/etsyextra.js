import { Router } from 'express';
import { asyncRoute, int, bool, list } from '../lib/http.js';
import * as batch from '../services/batchapi.js';

const router = Router();

/** Which permissions the saved token actually carries. */
router.get('/scopes', asyncRoute(async (req, res) => res.json(await batch.scopes())));

/** What Etsy is featuring on the shop front. */
router.get('/featured', asyncRoute(async (req, res) => {
  res.json(await batch.featured({ limit: int(req.query.limit, 25), offset: int(req.query.offset, 0) }));
}));

/** Many listings in one request instead of one each. */
router.get('/listings/batch', asyncRoute(async (req, res) => {
  res.json({ listings: await batch.listingsByIds(list(req.query.ids) ?? [], {
    includes: list(req.query.includes) ?? ['Images'],
  }) });
}));

router.get('/listings/batch/inventory', asyncRoute(async (req, res) => {
  res.json({ inventory: await batch.inventoryByIds(list(req.query.ids) ?? []) });
}));

router.get('/listings/batch/shipping', asyncRoute(async (req, res) => {
  res.json({ shipping: await batch.shippingByIds(list(req.query.ids) ?? []) });
}));

/** Refresh a set of listings using the batch endpoints. */
router.post('/listings/refresh', asyncRoute(async (req, res) => {
  res.json(await batch.refreshMany(list(req.body?.ids) ?? [], {
    withInventory: req.body?.withInventory !== false,
    withShipping: bool(req.body?.withShipping),
  }));
}));

/** Everything Etsy holds about one listing, in one view. */
router.get('/listings/:id/everything', asyncRoute(async (req, res) => {
  res.json(await batch.fullListing(Number(req.params.id)));
}));

router.get('/listings/:id/products/:productId', asyncRoute(async (req, res) => {
  res.json(await batch.product(req.params.id, req.params.productId));
}));

router.get('/listings/:id/products/:productId/offerings/:offeringId', asyncRoute(async (req, res) => {
  res.json(await batch.offering(req.params.id, req.params.productId, req.params.offeringId));
}));

router.get('/listings/:id/images/:imageId', asyncRoute(async (req, res) => {
  res.json(await batch.image(req.params.id, req.params.imageId));
}));

router.get('/listings/:id/videos/:videoId', asyncRoute(async (req, res) => {
  res.json(await batch.video(req.params.id, req.params.videoId));
}));

router.get('/listings/:id/files/:fileId', asyncRoute(async (req, res) => {
  res.json(await batch.file(req.params.id, req.params.fileId));
}));

router.get('/listings/:id/properties/:propertyId', asyncRoute(async (req, res) => {
  res.json(await batch.property(req.params.id, req.params.propertyId));
}));

/** The listings behind one order, even ones since deleted. */
router.get('/receipts/:receiptId/listings', asyncRoute(async (req, res) => {
  res.json(await batch.listingsForReceipt(req.params.receiptId));
}));

router.get('/sections/:sectionId', asyncRoute(async (req, res) => res.json(await batch.section(req.params.sectionId))));

router.get('/users/:userId', asyncRoute(async (req, res) => res.json(await batch.user(req.params.userId))));

/** A competitor's active listings, and a buyer category's attributes. */
router.get('/shops/:shopId/active-listings', asyncRoute(async (req, res) => {
  res.json(await batch.activeListingsOfShop(req.params.shopId, {
    limit: int(req.query.limit, 100), offset: int(req.query.offset, 0),
    sortOn: req.query.sortOn ?? 'created',
  }));
}));

router.get('/buyer-taxonomy/:id/properties', asyncRoute(async (req, res) => {
  res.json(await batch.buyerTaxonomyProperties(req.params.id));
}));

export default router;
