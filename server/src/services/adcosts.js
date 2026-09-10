/**
 * Advertising costs you enter yourself.
 *
 * Etsy's public API has no advertising, ads-fee or traffic endpoint at all -
 * the whole spec is 76 endpoints and none of them touch it - so what Etsy Ads
 * cost, and what the shop's traffic was, cannot be fetched. They can only be
 * read off the seller dashboard and entered here.
 *
 * Offsite Ads are different and live in offsiteads.js, because those are a
 * percentage of a specific order and can be worked out once you say which
 * orders came from an ad.
 *
 * An entry is one shop, one month, one kind of cost. Re-entering a month
 * replaces it rather than adding a second row, so pasting a corrected figure
 * does the obvious thing.
 */
import { getDb, audit } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { badRequest } from '../lib/errors.js';
import { convert } from './fx.js';

export const KINDS = ['etsy_ads', 'google_ads', 'meta_ads', 'other'];

export const KIND_LABELS = {
  etsy_ads: 'Etsy Ads',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  other: 'Other advertising',
};

const round2 = (n) => (n === null || n === undefined ? null : Math.round((n + Number.EPSILON) * 100) / 100);

/** YYYY-MM, or throw with something readable. */
function normaliseMonth(month) {
  const m = String(month ?? '').trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw badRequest(`"${month}" is not a month. Use YYYY-MM, e.g. 2026-09.`);
  return m;
}

/** Record (or correct) one month's spend. */
export function setCost({ month, kind = 'etsy_ads', amount, currency = 'USD', note = '',
  shopId = activeShopId() } = {}) {
  if (!KINDS.includes(kind)) throw badRequest(`Unknown cost type "${kind}". One of: ${KINDS.join(', ')}.`);
  const m = normaliseMonth(month);
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw badRequest(`"${amount}" is not an amount.`);

  getDb().prepare(`
    INSERT INTO ad_costs (shop_id, month, kind, amount, currency, note, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(shop_id, month, kind) DO UPDATE SET
      amount = excluded.amount, currency = excluded.currency,
      note = excluded.note, updated_at = datetime('now')`)
    .run(shopId, m, kind, value, String(currency ?? 'USD').toUpperCase(), String(note ?? '').slice(0, 300));

  audit('adcosts.set', { detail: { month: m, kind, amount: value, currency } });
  return { month: m, kind, amount: value, currency: String(currency).toUpperCase() };
}

export function removeCost({ month, kind, shopId = activeShopId() } = {}) {
  const m = normaliseMonth(month);
  getDb().prepare('DELETE FROM ad_costs WHERE shop_id IS ? AND month = ? AND kind = ?').run(shopId, m, kind);
  return { removed: true, month: m, kind };
}

/**
 * The months you have entered, converted into one currency.
 * A month's spend is converted at the last day of that month.
 */
export function listCosts({ months = 12, currency = 'USD', shopId = activeShopId() } = {}) {
  const rows = getDb().prepare(`
    SELECT month, kind, amount, currency, note, updated_at FROM ad_costs
    WHERE shop_id IS ? ORDER BY month DESC, kind`).all(shopId);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const floor = cutoff.toISOString().slice(0, 7);

  return rows
    .filter((r) => r.month >= floor)
    .map((r) => {
      const endOfMonth = `${r.month}-28`; // safely inside every month
      const converted = r.currency === currency
        ? r.amount
        : convert(r.amount, r.currency, currency, endOfMonth);
      return {
        month: r.month,
        kind: r.kind,
        kindLabel: KIND_LABELS[r.kind] ?? r.kind,
        amount: round2(r.amount),
        currency: r.currency,
        converted: round2(converted),
        convertedCurrency: currency,
        note: r.note || '',
        updatedAt: r.updated_at,
      };
    });
}

/** Everything you entered for one month, plus the total. */
export function forMonth({ month, currency = 'USD', shopId = activeShopId() } = {}) {
  const m = normaliseMonth(month);
  const rows = listCosts({ months: 600, currency, shopId }).filter((r) => r.month === m);
  return {
    month: m,
    currency,
    entries: rows,
    total: round2(rows.reduce((n, r) => n + (r.converted ?? 0), 0)),
  };
}
