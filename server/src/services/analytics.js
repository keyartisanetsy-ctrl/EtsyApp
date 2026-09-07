/**
 * The shop's own numbers, filtered the way a month-end review needs them.
 *
 * What this can and cannot show is worth being straight about: Etsy's API has
 * no traffic, visit or advertising endpoint, so there are no visitor counts
 * here. Everything below is derived from the orders themselves, which the API
 * does give in full, plus the costs you enter.
 *
 * Every money figure is converted from each order's own currency at that
 * order's own date, so a lira shop and a dollar shop can sit in one total.
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { convert } from './fx.js';
import { reportingCurrency, sumReceipts } from './reporting.js';
import { costSummary as offsiteCost } from './offsiteads.js';
import { forMonth as adCostsForMonth, listCosts } from './adcosts.js';

const isoDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);
const round2 = (n) => (n === null || n === undefined ? null : Math.round((n + Number.EPSILON) * 100) / 100);

/** Turn the filter arguments into a WHERE clause everything here shares. */
function scope({ since = null, until = null, sinceDays = null, sku = null, listingId = null,
  search = null, shopId = activeShopId() } = {}) {
  const where = ['r.shop_id IS ?', 'COALESCE(r.was_canceled, 0) = 0'];
  const params = [shopId];

  if (sinceDays) { where.push('r.created_ts >= ?'); params.push(Math.floor(Date.now() / 1000) - sinceDays * 86_400); }
  if (since) { where.push('r.created_ts >= ?'); params.push(Math.floor(Date.parse(since) / 1000)); }
  if (until) { where.push('r.created_ts < ?'); params.push(Math.floor(Date.parse(until) / 1000) + 86_400); }

  // Product filters work on the order's lines, so an order counts when any of
  // its items match.
  if (sku) {
    where.push('EXISTS (SELECT 1 FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id AND x.sku = ?)');
    params.push(sku);
  }
  if (listingId) {
    where.push('EXISTS (SELECT 1 FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id AND x.listing_id = ?)');
    params.push(Number(listingId));
  }
  if (search) {
    where.push(`EXISTS (SELECT 1 FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id
                AND (x.title LIKE ? OR x.sku LIKE ?))`);
    params.push(`%${search}%`, `%${search}%`);
  }
  return { where: where.join(' AND '), params };
}

/** Headline numbers for a period, with the costs you know about taken off. */
export function overview(filters = {}) {
  const currency = (filters.currency || reportingCurrency()).toUpperCase();
  const db = getDb();
  const { where, params } = scope(filters);

  const rows = db.prepare(`
    SELECT r.receipt_id, r.created_ts, r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency,
           r.refunded_amount, r.total_shipping_amount,
           (SELECT COUNT(*) FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id) AS items
    FROM receipts r WHERE ${where}`).all(...params);

  let gross = 0;
  let refunded = 0;
  let units = 0;
  const buyersByDay = new Map();

  for (const r of rows) {
    const divisor = r.grandtotal_divisor || 100;
    const from = (r.grandtotal_currency || currency).toUpperCase();
    const day = isoDate(r.created_ts);
    const g = convert((r.grandtotal_amount ?? 0) / divisor, from, currency, day);
    if (g === null) continue;
    gross += g;
    refunded += convert((r.refunded_amount ?? 0) / divisor, from, currency, day) ?? 0;
    units += r.items ?? 0;
    buyersByDay.set(day, (buyersByDay.get(day) ?? 0) + 1);
  }

  const net = gross - refunded;
  const offsite = offsiteCost({ ...filters, currency });

  return {
    currency,
    orders: rows.length,
    units,
    gross: round2(gross),
    refunded: round2(refunded),
    net: round2(net),
    averageOrder: rows.length ? round2(net / rows.length) : 0,
    offsiteAds: { fees: offsite.fees, orders: offsite.orders, ratePercent: offsite.ratePercent },
    // After the advertising fee that is tied to specific orders. Monthly ad
    // spend you enter separately is applied in monthlyProfit().
    afterOffsiteAds: round2(net - (offsite.fees ?? 0)),
    days: [...buyersByDay.entries()].map(([day, orders]) => ({ day, orders })).sort((a, b) => a.day.localeCompare(b.day)),
    note: 'Etsy exposes no traffic or visit data through its API, so these are order figures only.',
  };
}

/** Best sellers over the period, by units and by money. */
export function topProducts(filters = {}) {
  const currency = (filters.currency || reportingCurrency()).toUpperCase();
  const db = getDb();
  const { where, params } = scope(filters);

  const rows = db.prepare(`
    SELECT x.sku, x.listing_id, x.title,
           x.quantity, x.price_amount, x.price_divisor, x.price_currency,
           r.created_ts, r.grandtotal_currency
    FROM receipt_transactions x
    JOIN receipts r ON r.receipt_id = x.receipt_id
    WHERE ${where}`).all(...params);

  const byKey = new Map();
  for (const r of rows) {
    const key = r.sku || `listing:${r.listing_id}`;
    const day = isoDate(r.created_ts);
    const from = (r.price_currency || r.grandtotal_currency || currency).toUpperCase();
    const line = convert(((r.price_amount ?? 0) / (r.price_divisor || 100)) * (r.quantity ?? 0),
      from, currency, day) ?? 0;

    const b = byKey.get(key) ?? { sku: r.sku || '', listingId: r.listing_id, title: r.title, units: 0, revenue: 0, orders: 0 };
    b.units += r.quantity ?? 0;
    b.revenue = round2(b.revenue + line);
    b.orders += 1;
    byKey.set(key, b);
  }

  return [...byKey.values()]
    .map((b) => ({ ...b, currency }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, Number(filters.limit) || 50);
}

/** Where the orders went, which is the closest thing to an audience view. */
export function byCountry(filters = {}) {
  const db = getDb();
  const { where, params } = scope(filters);
  return db.prepare(`
    SELECT COALESCE(r.country_iso,'??') AS country, COUNT(*) AS orders
    FROM receipts r WHERE ${where} GROUP BY country ORDER BY orders DESC`).all(...params);
}

/**
 * Month by month: what came in, what the ads cost, what is left.
 * This is the month-end view - it folds in both the per-order offsite fee and
 * the monthly ad spend you typed in.
 */
export function monthlyProfit({ months = 6, currency = reportingCurrency(), shopId = activeShopId() } = {}) {
  const out = [];
  const now = new Date();

  for (let i = 0; i < months; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const month = d.toISOString().slice(0, 7);
    const start = `${month}-01`;
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

    const sales = sumReceipts({ since: start, until: end, currency, shopId });
    const offsite = offsiteCost({ sinceDays: null, since: start, until: end, currency, shopId });
    const ads = adCostsForMonth({ month, currency, shopId });

    const adsTotal = round2((offsite.fees ?? 0) + (ads.total ?? 0));
    out.push({
      month,
      currency,
      orders: sales.orders,
      gross: sales.gross,
      refunded: sales.refunded,
      net: sales.net,
      offsiteAdsFees: offsite.fees ?? 0,
      enteredAdSpend: ads.total ?? 0,
      adsTotal,
      afterAds: round2((sales.net ?? 0) - adsTotal),
    });
  }
  return out;
}

/** Everything the analytics screen needs in one call. */
export function dashboard(filters = {}) {
  const currency = (filters.currency || reportingCurrency()).toUpperCase();
  return {
    filters: { ...filters, currency },
    overview: overview({ ...filters, currency }),
    topProducts: topProducts({ ...filters, currency, limit: 20 }),
    countries: byCountry(filters).slice(0, 15),
    months: monthlyProfit({ months: Number(filters.months) || 6, currency }),
    adCosts: listCosts({ months: 12, currency }),
  };
}
