import { Router } from 'express';
import { asyncRoute, int, tri, bool, ids, required } from '../lib/http.js';
import * as orders from '../services/orders.js';
import * as offsiteAds from '../services/offsiteads.js';
import { listAccounts } from '../etsy/client.js';
import * as sync from '../services/sync.js';

const router = Router();

router.get('/', asyncRoute(async (req, res) => {
  res.json(orders.listOrders({
    search: req.query.search ?? '',
    done: tri(req.query.done),
    seen: tri(req.query.seen),
    shipped: tri(req.query.shipped),
    paid: tri(req.query.paid),
    canceled: tri(req.query.canceled),
    hasTracking: tri(req.query.hasTracking),
    alertsOnly: bool(req.query.alertsOnly),
    country: req.query.country ?? '',
    sinceDays: int(req.query.sinceDays),
    sort: req.query.sort ?? 'created',
    dir: req.query.dir ?? 'desc',
    limit: int(req.query.limit, 100),
    offset: int(req.query.offset, 0),
  }));
}));

router.get('/counters', asyncRoute(async (req, res) => res.json(orders.orderCounters())));

router.post('/sync', asyncRoute(async (req, res) => {
  res.json(await sync.syncReceipts({ full: bool(req.body?.full), sinceDays: int(req.body?.sinceDays) }));
}));

router.get('/:id', asyncRoute(async (req, res) => res.json(orders.getOrder(Number(req.params.id)))));

router.get('/:id/copy', asyncRoute(async (req, res) => res.json(orders.copyBlocks(Number(req.params.id)))));

/** The tick column. Accepts one id or many: { receiptIds: [...], done: true } */
router.post('/flags', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  required(body, ['receiptIds']);
  res.json(orders.setFlags(ids(body.receiptIds), body));
}));

router.post('/:id/flags', asyncRoute(async (req, res) => {
  res.json(orders.setFlags([Number(req.params.id)], req.body ?? {}));
}));

/** Raise / clear / resolve a problem on one or many orders. */
router.post('/problem', asyncRoute(async (req, res) => {
  const { receiptIds = [], state = 'warning', note = '' } = req.body ?? {};
  res.json(orders.setProblem(receiptIds, { state, note }));
}));

/** Mark orders as having come from an Etsy Offsite Ad (or clear it). */
router.post('/offsite-ads', asyncRoute(async (req, res) => {
  const { receiptIds = [], on = true } = req.body ?? {};
  res.json(offsiteAds.setOffsiteAds(receiptIds, on));
}));

/** The Offsite Ads rate each connected shop is on. */
router.get('/offsite-ads/rates', asyncRoute(async (req, res) => {
  res.json(listAccounts().map((a) => ({
    shopId: a.shopId,
    shopName: a.shopName,
    isActive: a.isActive,
    rate: offsiteAds.rateForShop(a.shopId),
    ratePercent: Math.round(offsiteAds.rateForShop(a.shopId) * 1000) / 10,
  })));
}));

router.put('/offsite-ads/rates/:shopId', asyncRoute(async (req, res) => {
  // Accept either 12 or 0.12, since both readings are natural.
  const raw = Number(req.body?.rate);
  const rate = raw > 1 ? raw / 100 : raw;
  res.json(offsiteAds.setRateForShop(Number(req.params.shopId), rate));
}));

/** What offsite ads cost over a period, and the rate this shop is on. */
router.get('/offsite-ads/cost', asyncRoute(async (req, res) => {
  res.json(offsiteAds.costSummary({
    sinceDays: req.query.sinceDays ? Number(req.query.sinceDays) : 30,
    since: req.query.since || null,
    until: req.query.until || null,
    currency: (req.query.currency || 'USD').toUpperCase(),
  }));
}));

router.post('/seen', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['receiptIds']);
  res.json(orders.markSeen(ids(req.body.receiptIds)));
}));

/** Push was_paid / was_shipped back to Etsy. */
router.post('/:id/etsy', asyncRoute(async (req, res) => {
  res.json(await orders.updateEtsyReceipt(Number(req.params.id), req.body ?? {}));
}));

export default router;
