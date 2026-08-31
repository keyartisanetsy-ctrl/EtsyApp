import { Router } from 'express';
import { asyncRoute, bool, int } from '../lib/http.js';
import { getDb } from '../db/index.js';
import { orderCounters } from '../services/orders.js';
import { trackingSummary } from '../services/tracking/index.js';
import { currentShop } from '../etsy/shop.js';
import { getStoredToken } from '../etsy/client.js';
import { providerStatus } from '../services/ai/index.js';
import { getDiscountPercent } from '../services/settings.js';
import * as sync from '../services/sync.js';
import { OPERATION_COUNT } from '../etsy/operations.generated.js';

const router = Router();

router.get('/', asyncRoute(async (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();

  const listingsByState = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) AS c FROM listings GROUP BY state').all().map((r) => [r.state, r.c]),
  );

  res.json({
    connected: !!getStoredToken(),
    shop: currentShop(),
    operationCount: OPERATION_COUNT,
    discountPercent: getDiscountPercent(),
    listings: {
      total: one('SELECT COUNT(*) AS c FROM listings').c,
      byState: listingsByState,
      variations: one('SELECT COUNT(*) AS c FROM listing_products WHERE is_deleted = 0').c,
      missingSku: one("SELECT COUNT(*) AS c FROM listing_products WHERE is_deleted = 0 AND (sku IS NULL OR sku = '')").c,
      missingSupplyLink: one(`SELECT COUNT(*) AS c FROM listing_products p
        LEFT JOIN sku_meta m ON m.sku = p.sku WHERE p.is_deleted = 0 AND p.sku <> ''
        AND (m.supply_link IS NULL OR m.supply_link = '')`).c,
      duplicateSkus: one(`SELECT COUNT(*) AS c FROM (SELECT sku FROM listing_products
        WHERE sku <> '' AND is_deleted = 0 GROUP BY sku HAVING COUNT(*) > 1)`).c,
    },
    orders: orderCounters(),
    tracking: trackingSummary(),
    ai: providerStatus(),
    revenue: {
      last30: one(`SELECT COALESCE(SUM(grandtotal_amount),0)/100.0 AS c FROM receipts
        WHERE was_canceled = 0 AND created_ts >= strftime('%s','now','-30 days')`).c,
      last7: one(`SELECT COALESCE(SUM(grandtotal_amount),0)/100.0 AS c FROM receipts
        WHERE was_canceled = 0 AND created_ts >= strftime('%s','now','-7 days')`).c,
      currency: one('SELECT grandtotal_currency AS c FROM receipts WHERE grandtotal_currency IS NOT NULL LIMIT 1')?.c ?? null,
    },
    lastSync: {
      listings: one('SELECT MAX(synced_at) AS c FROM listings')?.c ?? null,
      receipts: one('SELECT MAX(synced_at) AS c FROM receipts')?.c ?? null,
      tracking: one('SELECT MAX(last_checked_at) AS c FROM tracking')?.c ?? null,
    },
    recentJobs: db.prepare('SELECT id, type, label, status, total, succeeded, failed, created_at FROM bulk_jobs ORDER BY created_at DESC LIMIT 5').all(),
  });
}));

/** Full sync. Long-running, so it reports a summary when it finishes. */
router.post('/sync', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await sync.syncAll({
    states: b.states ?? undefined,
    withInventory: b.withInventory !== false,
    withVariationImages: b.withVariationImages !== false,
    full: bool(b.full),
    sinceDays: int(b.sinceDays),
  }));
}));

router.post('/sync/listings', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await sync.syncListings({
    states: b.states ?? undefined,
    withInventory: b.withInventory !== false,
    withVariationImages: b.withVariationImages !== false,
  }));
}));

export default router;
