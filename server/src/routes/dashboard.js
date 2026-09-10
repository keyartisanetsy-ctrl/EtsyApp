import { Router } from 'express';
import { asyncRoute, bool, int } from '../lib/http.js';
import { getDb } from '../db/index.js';
import { orderCounters } from '../services/orders.js';
import { trackingSummary } from '../services/tracking/index.js';
import { currentShop, activeShopId } from '../etsy/shop.js';
import { getStoredToken, listAccounts } from '../etsy/client.js';
import { providerStatus } from '../services/ai/index.js';
import { getDiscountPercent } from '../services/settings.js';
import * as sync from '../services/sync.js';
import { revenueSummary, sumReceipts, monthlyBreakdown, reportingCurrency } from '../services/reporting.js';
import { OPERATION_COUNT } from '../etsy/operations.generated.js';

const router = Router();

router.get('/', asyncRoute(async (req, res) => {
  const db = getDb();
  const shop = activeShopId();
  const one = (sql) => db.prepare(sql).get(shop);

  const listingsByState = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) AS c FROM listings WHERE shop_id IS ? GROUP BY state')
      .all(shop).map((r) => [r.state, r.c]),
  );

  res.json({
    connected: !!getStoredToken(),
    shop: currentShop(),
    accounts: listAccounts(),
    operationCount: OPERATION_COUNT,
    discountPercent: getDiscountPercent(),
    listings: {
      total: one('SELECT COUNT(*) AS c FROM listings WHERE shop_id IS ?').c,
      byState: listingsByState,
      variations: one(`SELECT COUNT(*) AS c FROM listing_products p
        JOIN listings l ON l.listing_id = p.listing_id WHERE l.shop_id IS ? AND p.is_deleted = 0`).c,
      missingSku: one(`SELECT COUNT(*) AS c FROM listing_products p
        JOIN listings l ON l.listing_id = p.listing_id
        WHERE l.shop_id IS ? AND p.is_deleted = 0 AND (p.sku IS NULL OR p.sku = '')`).c,
      missingSupplyLink: one(`SELECT COUNT(*) AS c FROM listing_products p
        JOIN listings l ON l.listing_id = p.listing_id
        LEFT JOIN sku_meta m ON m.sku = p.sku
        WHERE l.shop_id IS ? AND p.is_deleted = 0 AND p.sku <> ''
        AND (m.supply_link IS NULL OR m.supply_link = '')`).c,
      duplicateSkus: one(`SELECT COUNT(*) AS c FROM (SELECT p.sku FROM listing_products p
        JOIN listings l ON l.listing_id = p.listing_id
        WHERE l.shop_id IS ? AND p.sku <> '' AND p.is_deleted = 0 GROUP BY p.sku HAVING COUNT(*) > 1)`).c,
    },
    orders: orderCounters(),
    tracking: trackingSummary(),
    ai: providerStatus(),
    // Converted from each order's own currency at its own date, with refunds
    // and cancellations removed. Summing the raw amounts and labelling them
    // with one arbitrary receipt's currency read lira as dollars.
    revenue: await revenueSummary(),
    lastSync: {
      listings: one('SELECT MAX(synced_at) AS c FROM listings WHERE shop_id IS ?')?.c ?? null,
      receipts: one('SELECT MAX(synced_at) AS c FROM receipts WHERE shop_id IS ?')?.c ?? null,
      tracking: one('SELECT MAX(last_checked_at) AS c FROM tracking WHERE shop_id IS ?')?.c ?? null,
    },
    recentJobs: db.prepare('SELECT id, type, label, status, total, succeeded, failed, created_at FROM bulk_jobs ORDER BY created_at DESC LIMIT 5').all(),
  });
}));

/**
 * Money over a period, in the reporting currency. Date and shop filters make
 * this usable for a month-end close rather than only the headline figure.
 */
router.get('/money', asyncRoute(async (req, res) => {
  const { since, until, sinceDays, currency, includeCanceled } = req.query;
  res.json({
    currency: (currency || reportingCurrency()).toUpperCase(),
    period: sumReceipts({
      since: since || null,
      until: until || null,
      sinceDays: sinceDays ? Number(sinceDays) : null,
      currency: (currency || reportingCurrency()).toUpperCase(),
      includeCanceled: includeCanceled === 'true',
    }),
    months: monthlyBreakdown({ months: Number(req.query.months) || 6,
      currency: (currency || reportingCurrency()).toUpperCase() }),
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
