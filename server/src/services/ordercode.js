/**
 * The short human code an order carries on a sheet, e.g. 26-0710-01.
 *
 * Two rules matter:
 *   - a new code carries TODAY's date, the day it is handed out, and the next
 *     free number of that day - the 3rd order given a code today is 26-1007-03
 *     whenever the order itself was placed;
 *   - it is assigned once and stored, so it never changes underneath a row
 *     that is already in Airtable or on a packing sheet, and every item of the
 *     same order carries the same code.
 *
 * Etsy and Shopify draw from the same day's numbers, so no two orders of a day
 * share a code whichever shop they came from.
 *
 * The shape is a template so it can be changed without touching code (see
 * lib/codeformat.js for the placeholders).
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { activeShopifyShopId } from '../shopify/shop.js';
import { readSetting } from './settings.js';
import { DEFAULT_TEMPLATE, DEFAULT_TIMEZONE, formatCode as format, todayInZone } from '../lib/codeformat.js';

export { DEFAULT_TEMPLATE };

const template = () => readSetting('orders.code_template') || DEFAULT_TEMPLATE;
const zone = () => readSetting('orders.code_timezone') || DEFAULT_TIMEZONE;

/** Fill the template for a given day and sequence number. */
export const formatCode = (day, seq, pattern = template()) => format(day, seq, pattern);

/** The day a code handed out right now is stamped with. */
export const codeDay = () => todayInZone(zone());

const usedSeqs = (db, day) => [
  ...db.prepare('SELECT seq FROM order_codes WHERE day = ?').all(day).map((r) => r.seq),
  ...db.prepare('SELECT seq FROM shopify_order_codes WHERE day = ?').all(day).map((r) => r.seq),
];

/** The next unused number of a day, over both shops' codes. Numbers are never reused. */
const nextSeq = (db, day) => Math.max(0, ...usedSeqs(db, day)) + 1;

/**
 * The code for one order, assigning it on first use. `createdTs` is only used
 * to tell that the order exists; the code itself is today's.
 */
export function codeFor(receiptId, { shopId = activeShopId(), createdTs = null } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT code FROM order_codes WHERE shop_id IS ? AND receipt_id = ?')
    .get(shopId, receiptId);
  if (existing) return existing.code;

  const receipt = db.prepare('SELECT created_ts FROM receipts WHERE receipt_id = ? AND shop_id IS ?')
    .get(receiptId, shopId);
  if (!(createdTs ?? receipt?.created_ts)) return null;

  const day = codeDay();
  const seq = nextSeq(db, day);
  const code = formatCode(day, seq);
  db.prepare(`INSERT INTO order_codes (shop_id, receipt_id, code, day, seq) VALUES (?,?,?,?,?)
              ON CONFLICT(shop_id, receipt_id) DO NOTHING`).run(shopId, receiptId, code, day, seq);

  return db.prepare('SELECT code FROM order_codes WHERE shop_id IS ? AND receipt_id = ?')
    .get(shopId, receiptId)?.code ?? code;
}

/** The same short code for a Shopify order, from the same day's numbers as Etsy's. */
export function shopifyCodeFor(orderId, { shopId = activeShopifyShopId() } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT code FROM shopify_order_codes WHERE shop_id IS ? AND order_id = ?').get(shopId, orderId);
  if (existing) return existing.code;

  const order = db.prepare('SELECT created_at_shopify AS at FROM shopify_orders WHERE order_id = ?').get(orderId);
  if (!order?.at || !Number.isFinite(Date.parse(order.at))) return null;

  const day = codeDay();
  const seq = nextSeq(db, day);
  const code = formatCode(day, seq);
  db.prepare(`INSERT INTO shopify_order_codes (shop_id, order_id, code, day, seq) VALUES (?,?,?,?,?)
              ON CONFLICT(shop_id, order_id) DO NOTHING`).run(shopId, orderId, code, day, seq);
  return db.prepare('SELECT code FROM shopify_order_codes WHERE shop_id IS ? AND order_id = ?').get(shopId, orderId)?.code ?? code;
}

export function shopifyCodesFor(orderIds = [], shopId = activeShopifyShopId()) {
  const out = {};
  if (!orderIds.length) return out;
  // Oldest first, so a batch numbers itself in the order the orders came in.
  const ordered = getDb().prepare(`
    SELECT order_id FROM shopify_orders
    WHERE shop_id IS ? AND order_id IN (${orderIds.map(() => '?').join(',')})
    ORDER BY created_at_shopify ASC`).all(shopId, ...orderIds);
  for (const o of ordered) out[o.order_id] = shopifyCodeFor(o.order_id, { shopId });
  return out;
}

/**
 * Whichever order of the active shops carries this code, typed by hand from a
 * sheet. Matches the code as written (any letter case, stray spaces ignored).
 */
export function findOrderByCode(code) {
  const wanted = String(code ?? '').replace(/\s+/g, '').toLowerCase();
  if (!wanted) return null;
  const db = getDb();
  const etsy = activeShopId() != null
    ? db.prepare('SELECT receipt_id FROM order_codes WHERE shop_id IS ? AND lower(code) = ?').get(activeShopId(), wanted) : null;
  if (etsy) return { channel: 'etsy', orderId: String(etsy.receipt_id) };
  const shop = activeShopifyShopId();
  const shopify = shop != null
    ? db.prepare('SELECT order_id FROM shopify_order_codes WHERE shop_id IS ? AND lower(code) = ?').get(shop, wanted) : null;
  return shopify ? { channel: 'shopify', orderId: shopify.order_id } : null;
}

/** Codes for many orders at once, assigning any that are missing. */
export function codesFor(receiptIds = [], shopId = activeShopId()) {
  const out = {};
  // Oldest first, so a batch numbers itself in the same order a person would.
  const ordered = getDb().prepare(`
    SELECT receipt_id, created_ts FROM receipts
    WHERE shop_id IS ? AND receipt_id IN (${receiptIds.map(() => '?').join(',') || 'NULL'})
    ORDER BY created_ts ASC`).all(shopId, ...receiptIds);
  for (const r of ordered) out[r.receipt_id] = codeFor(r.receipt_id, { shopId, createdTs: r.created_ts });
  return out;
}

// --------------------------------------------------------------------- month

const TR_MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026 Eylül" - the shape these sheets already use for their Month column. */
export function monthLabelTr(createdTs) {
  if (!createdTs) return null;
  const d = new Date(createdTs * 1000);
  return `${d.getUTCFullYear()} ${TR_MONTHS[d.getUTCMonth()]}`;
}

export function monthLabelEn(createdTs) {
  if (!createdTs) return null;
  const d = new Date(createdTs * 1000);
  return `${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
