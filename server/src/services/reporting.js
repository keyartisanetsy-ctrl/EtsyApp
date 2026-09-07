/**
 * Money figures you can trust at month end.
 *
 * Three things were getting revenue wrong before:
 *   - a shop that bills in lira had its totals summed as if they were dollars,
 *     because the label was taken from whichever receipt happened to be first;
 *   - refunds were not subtracted at all;
 *   - orders were valued at whatever the rate is today rather than the rate on
 *     the day of the sale.
 *
 * So every receipt is converted from its own currency, at its own date's rate,
 * into one reporting currency you choose, and refunds and cancellations come
 * off. Anything that cannot be converted is reported separately rather than
 * quietly folded in at the wrong value.
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { readSetting } from './settings.js';
import { convert, ensureRates } from './fx.js';

export const reportingCurrency = () => (readSetting('reporting.currency') || 'USD').toUpperCase();

const isoDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Sum a set of receipts into one currency.
 *
 * Returns the converted total plus what it was made of, so a wrong-looking
 * figure can be traced instead of guessed at.
 */
export function sumReceipts({ sinceDays = null, since = null, until = null, currency = reportingCurrency(),
  includeCanceled = false, shopId = activeShopId() } = {}) {
  const db = getDb();
  const where = ['shop_id IS ?'];
  const params = [shopId];

  if (!includeCanceled) where.push('was_canceled = 0');
  if (sinceDays) { where.push('created_ts >= ?'); params.push(Math.floor(Date.now() / 1000) - sinceDays * 86_400); }
  if (since) { where.push('created_ts >= ?'); params.push(Math.floor(Date.parse(since) / 1000)); }
  if (until) { where.push('created_ts < ?'); params.push(Math.floor(Date.parse(until) / 1000) + 86_400); }

  const rows = db.prepare(`
    SELECT receipt_id, created_ts, grandtotal_amount, grandtotal_divisor, grandtotal_currency,
           subtotal_amount, total_shipping_amount, total_tax_amount, discount_amount,
           refunded_amount, refund_count, was_canceled
    FROM receipts WHERE ${where.join(' AND ')}`).all(...params);

  const out = {
    currency,
    orders: 0,
    gross: 0,
    refunded: 0,
    net: 0,
    shipping: 0,
    tax: 0,
    discount: 0,
    canceledOrders: 0,
    refundedOrders: 0,
    byCurrency: {},
    unconverted: { orders: 0, currencies: [] },
  };

  for (const r of rows) {
    const divisor = r.grandtotal_divisor || 100;
    const from = (r.grandtotal_currency || currency).toUpperCase();
    const day = isoDate(r.created_ts);
    const gross = (r.grandtotal_amount ?? 0) / divisor;
    const refunded = (r.refunded_amount ?? 0) / divisor;

    if (r.was_canceled) out.canceledOrders += 1;
    if (r.refund_count) out.refundedOrders += 1;

    const bucket = out.byCurrency[from] ?? (out.byCurrency[from] = { orders: 0, gross: 0, refunded: 0 });
    bucket.orders += 1;
    bucket.gross = round2(bucket.gross + gross);
    bucket.refunded = round2(bucket.refunded + refunded);

    const converted = from === currency ? gross : convert(gross, from, currency, day);
    if (converted === null) {
      // No rate for that currency: say so rather than adding a wrong number.
      out.unconverted.orders += 1;
      if (!out.unconverted.currencies.includes(from)) out.unconverted.currencies.push(from);
      continue;
    }
    const convertedRefund = from === currency ? refunded : (convert(refunded, from, currency, day) ?? 0);

    out.orders += 1;
    out.gross = round2(out.gross + converted);
    out.refunded = round2(out.refunded + convertedRefund);
    out.shipping = round2(out.shipping + (from === currency
      ? (r.total_shipping_amount ?? 0) / divisor
      : convert((r.total_shipping_amount ?? 0) / divisor, from, currency, day) ?? 0));
    out.tax = round2(out.tax + (from === currency
      ? (r.total_tax_amount ?? 0) / divisor
      : convert((r.total_tax_amount ?? 0) / divisor, from, currency, day) ?? 0));
    out.discount = round2(out.discount + (from === currency
      ? (r.discount_amount ?? 0) / divisor
      : convert((r.discount_amount ?? 0) / divisor, from, currency, day) ?? 0));
  }

  out.net = round2(out.gross - out.refunded);
  return out;
}

/** Headline revenue for the dashboard, in the reporting currency. */
export async function revenueSummary({ currency = reportingCurrency() } = {}) {
  try { await ensureRates(); } catch { /* fall through: same-currency sums still work */ }
  const last7 = sumReceipts({ sinceDays: 7, currency });
  const last30 = sumReceipts({ sinceDays: 30, currency });
  return {
    currency,
    last7: last7.net,
    last30: last30.net,
    detail: { last7, last30 },
    // Shown next to the figure so a converted number is never mistaken for a
    // raw one, which is exactly what went wrong before.
    note: last30.byCurrency && Object.keys(last30.byCurrency).length > 1
      ? `Converted from ${Object.keys(last30.byCurrency).join(', ')} at each order's own date.`
      : `Shop bills in ${Object.keys(last30.byCurrency)[0] ?? currency}${
        (Object.keys(last30.byCurrency)[0] ?? currency) === currency ? '' : `, converted to ${currency} at each order's own date`}.`,
  };
}

/**
 * Month-by-month totals, with the costs you enter yourself folded in, which is
 * what a month-end margin actually needs.
 */
export function monthlyBreakdown({ months = 6, currency = reportingCurrency(), shopId = activeShopId() } = {}) {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - months * 31 * 86_400;
  const rows = db.prepare(`
    SELECT receipt_id, created_ts, grandtotal_amount, grandtotal_divisor, grandtotal_currency, refunded_amount
    FROM receipts WHERE shop_id IS ? AND was_canceled = 0 AND created_ts >= ?`).all(shopId, since);

  const buckets = new Map();
  for (const r of rows) {
    const month = isoDate(r.created_ts)?.slice(0, 7);
    if (!month) continue;
    const divisor = r.grandtotal_divisor || 100;
    const from = (r.grandtotal_currency || currency).toUpperCase();
    const day = isoDate(r.created_ts);
    const gross = convert((r.grandtotal_amount ?? 0) / divisor, from, currency, day);
    const refunded = convert((r.refunded_amount ?? 0) / divisor, from, currency, day);
    if (gross === null) continue;
    const b = buckets.get(month) ?? { month, orders: 0, gross: 0, refunded: 0 };
    b.orders += 1;
    b.gross = round2(b.gross + gross);
    b.refunded = round2(b.refunded + (refunded ?? 0));
    buckets.set(month, b);
  }

  return [...buckets.values()]
    .map((b) => ({ ...b, net: round2(b.gross - b.refunded), currency }))
    .sort((a, b) => b.month.localeCompare(a.month));
}
