import { Router } from 'express';
import { asyncRoute } from '../lib/http.js';
import * as analytics from '../services/analytics.js';
import * as adCosts from '../services/adcosts.js';
import { ensureRates } from '../services/fx.js';

const router = Router();

/** Shared filter parsing: dates, product, and the currency to report in. */
const filtersFrom = (q = {}) => ({
  since: q.since || null,
  until: q.until || null,
  sinceDays: q.sinceDays ? Number(q.sinceDays) : null,
  sku: q.sku || null,
  listingId: q.listingId ? Number(q.listingId) : null,
  search: q.search || null,
  currency: q.currency ? String(q.currency).toUpperCase() : undefined,
  months: q.months ? Number(q.months) : undefined,
});

/** Everything the analytics screen shows, in one call. */
router.get('/', asyncRoute(async (req, res) => {
  // Converting needs rates; a missing one would silently drop orders.
  try { await ensureRates(); } catch { /* same-currency figures still work */ }
  res.json(analytics.dashboard(filtersFrom(req.query)));
}));

router.get('/overview', asyncRoute(async (req, res) => res.json(analytics.overview(filtersFrom(req.query)))));
router.get('/products', asyncRoute(async (req, res) => res.json(analytics.topProducts(filtersFrom(req.query)))));
router.get('/countries', asyncRoute(async (req, res) => res.json(analytics.byCountry(filtersFrom(req.query)))));
router.get('/months', asyncRoute(async (req, res) => {
  res.json(analytics.monthlyProfit({
    months: Number(req.query.months) || 6,
    currency: req.query.currency ? String(req.query.currency).toUpperCase() : undefined,
  }));
}));

// ------------------------------------------------------- advertising spend
// Etsy's API has no advertising endpoint, so these figures are entered by hand
// from the seller dashboard.

router.get('/ad-costs', asyncRoute(async (req, res) => {
  res.json({
    kinds: adCosts.KINDS.map((k) => ({ value: k, label: adCosts.KIND_LABELS[k] })),
    costs: adCosts.listCosts({
      months: Number(req.query.months) || 12,
      currency: (req.query.currency || 'USD').toUpperCase(),
    }),
  });
}));

router.post('/ad-costs', asyncRoute(async (req, res) => {
  const { month, kind = 'etsy_ads', amount, currency = 'USD', note = '' } = req.body ?? {};
  res.json(adCosts.setCost({ month, kind, amount, currency, note }));
}));

router.delete('/ad-costs', asyncRoute(async (req, res) => {
  // Accept either shape: some clients put it in the query, ours sends a body.
  const month = req.body?.month ?? req.query.month;
  const kind = req.body?.kind ?? req.query.kind;
  res.json(adCosts.removeCost({ month, kind }));
}));

export default router;
