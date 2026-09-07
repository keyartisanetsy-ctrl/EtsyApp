/**
 * Etsy's Offsite Ads fee, worked out per order.
 *
 * Etsy's rules, and how each one shows up here:
 *   - shops turning over under $10,000 a year pay 15% and may opt out;
 *   - shops at or above $10,000 pay a discounted 12% and cannot opt out;
 *   - the fee never exceeds $100 on a single order, however large it is.
 *
 * The rate is therefore a property of the shop, not of the order, so it is set
 * once per shop (12% here for every shop except CutieGiftsUS, which is on 15%).
 *
 * The cap is $100 **USD**, so on an order billed in lira the cap has to be
 * converted before it is applied - capping 2,603 TRY at "100" would be wrong by
 * a factor of about fifty. It is converted at the order's own date, like every
 * other conversion in this app.
 *
 * Whether an order came from an offsite ad is not something the API tells us,
 * so it is a button you press on the order.
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { readSetting } from './settings.js';
import { convert } from './fx.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../db/index.js';

/** Etsy's two published rates. */
export const RATE_STANDARD = 0.15; // under $10k a year, optional
export const RATE_DISCOUNTED = 0.12; // $10k a year and over, mandatory

/** Etsy never charges more than this on one order, in USD. */
export const CAP_USD = 100;

const round2 = (n) => (n === null || n === undefined ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const isoDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);

/** The rate this shop pays, as a fraction. */
export function rateForShop(shopId = activeShopId()) {
  const row = getDb().prepare('SELECT offsite_ads_rate FROM etsy_accounts WHERE shop_id = ?').get(shopId);
  const stored = row?.offsite_ads_rate;
  if (Number.isFinite(stored) && stored > 0) return stored;
  const fallback = Number(readSetting('offsite_ads.default_rate'));
  return Number.isFinite(fallback) && fallback > 0 ? fallback : RATE_DISCOUNTED;
}

export function setRateForShop(shopId, rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw badRequest('The offsite ads rate is a fraction, e.g. 0.12 for 12% or 0.15 for 15%.');
  }
  getDb().prepare("UPDATE etsy_accounts SET offsite_ads_rate = ?, updated_at = datetime('now') WHERE shop_id = ?")
    .run(value, shopId);
  return { shopId, rate: value };
}

/**
 * The fee for one order.
 *
 * `order` is a receipt row. Returns null when the order is not marked as
 * having come from an offsite ad - there is no fee to speak of then.
 */
export function feeFor(order, { shopId = activeShopId() } = {}) {
  if (!order || !order.offsite_ads) return null;

  const divisor = order.grandtotal_divisor || 100;
  const currency = (order.grandtotal_currency || 'USD').toUpperCase();
  const day = isoDate(order.created_ts);
  const total = (order.grandtotal_amount ?? 0) / divisor;
  const rate = rateForShop(shopId);

  const raw = total * rate;

  // The $100 ceiling is in dollars, so compare in dollars.
  const capInOrderCurrency = currency === 'USD' ? CAP_USD : convert(CAP_USD, 'USD', currency, day);
  const capped = capInOrderCurrency !== null && raw > capInOrderCurrency;
  const fee = capped ? capInOrderCurrency : raw;

  return {
    applies: true,
    rate,
    ratePercent: Math.round(rate * 1000) / 10,
    currency,
    orderTotal: round2(total),
    fee: round2(fee),
    feeUsd: currency === 'USD' ? round2(fee) : round2(convert(fee, currency, 'USD', day)),
    capped,
    capUsd: CAP_USD,
    // Said in words so a number in a sheet can always be explained.
    explanation: capped
      ? `${Math.round(rate * 1000) / 10}% of ${round2(total)} ${currency} would be more than the $${CAP_USD} `
        + `Etsy caps an order at, so the fee is the cap.`
      : `${Math.round(rate * 1000) / 10}% of ${round2(total)} ${currency}.`,
  };
}

/** Turn the offsite-ads flag on or off for orders. */
export function setOffsiteAds(receiptIds, on = true) {
  const db = getDb();
  const ids = (Array.isArray(receiptIds) ? receiptIds : [receiptIds]).map(Number).filter(Boolean);
  if (!ids.length) throw badRequest('No orders selected.');

  db.transaction(() => {
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO order_flags (receipt_id) VALUES (?)').run(id);
      db.prepare(`UPDATE order_flags SET offsite_ads = ?, updated_at = datetime('now') WHERE receipt_id = ?`)
        .run(on ? 1 : 0, id);
    }
  })();
  audit('orders.offsite_ads', { entity: 'receipt', detail: { ids, on: !!on } });
  return { updated: ids.length, ids, offsiteAds: !!on };
}

/**
 * What offsite ads cost over a period, for the month-end sum.
 * Everything is converted to the reporting currency at each order's own date.
 */
export function costSummary({ sinceDays = 30, since = null, until = null, currency = 'USD',
  shopId = activeShopId() } = {}) {
  const db = getDb();
  const where = ['r.shop_id IS ?', 'COALESCE(r.was_canceled, 0) = 0', 'COALESCE(f.offsite_ads,0) = 1'];
  const params = [shopId];
  if (sinceDays) { where.push('r.created_ts >= ?'); params.push(Math.floor(Date.now() / 1000) - sinceDays * 86_400); }
  if (since) { where.push('r.created_ts >= ?'); params.push(Math.floor(Date.parse(since) / 1000)); }
  if (until) { where.push('r.created_ts < ?'); params.push(Math.floor(Date.parse(until) / 1000) + 86_400); }

  const rows = db.prepare(`
    SELECT r.receipt_id, r.created_ts, r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency,
           1 AS offsite_ads
    FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
    WHERE ${where.join(' AND ')}`).all(...params);

  let fees = 0;
  let cappedOrders = 0;
  for (const r of rows) {
    const fee = feeFor(r, { shopId });
    if (!fee) continue;
    if (fee.capped) cappedOrders += 1;
    const inCurrency = fee.currency === currency
      ? fee.fee
      : convert(fee.fee, fee.currency, currency, isoDate(r.created_ts));
    if (inCurrency !== null) fees += inCurrency;
  }

  return {
    currency,
    orders: rows.length,
    fees: round2(fees),
    cappedOrders,
    rate: rateForShop(shopId),
    ratePercent: Math.round(rateForShop(shopId) * 1000) / 10,
  };
}
