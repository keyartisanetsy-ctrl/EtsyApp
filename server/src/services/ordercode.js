/**
 * The short human code an order carries on a packing sheet, e.g. 26-1007-01.
 *
 * - It is handed out when the first parcel of an order is matched to it - not
 *   when the order is merely listed or synced - so the day's numbers run
 *   01, 02, 03... over the orders that actually reached the warehouse.
 * - It carries the day it is handed out (today), in a configurable time zone,
 *   and the next free number of that day, shared by Etsy and Shopify so no two
 *   orders of a day have the same code.
 * - It is stored and never changes, and every item of an order carries the
 *   same code. Codes an order already had (Etsy orders sent to Airtable under
 *   the older order-date scheme) are kept and used as they are.
 *
 * `codeFor` and friends only LOOK codes up; `ensureOrderCode` is the one way
 * a new code is born.
 *
 * The shape is a template so it can be changed without touching code (see
 * lib/codeformat.js for the placeholders).
 */
import { getDb } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { activeShopId } from '../etsy/shop.js';
import { activeShopifyShopId } from '../shopify/shop.js';
import { withShop } from '../etsy/client.js';
import { withShopifyShop } from '../shopify/client.js';
import { readSetting } from './settings.js';
import { DEFAULT_TEMPLATE, DEFAULT_TIMEZONE, formatCode as format, todayInZone } from '../lib/codeformat.js';

export { DEFAULT_TEMPLATE };

const template = () => readSetting('orders.code_template') || DEFAULT_TEMPLATE;
const zone = () => readSetting('orders.code_timezone') || DEFAULT_TIMEZONE;

/** Fill the template for a given day and sequence number. */
export const formatCode = (day, seq, pattern = template()) => format(day, seq, pattern);

/** The day a code handed out right now is stamped with. */
export const codeDay = () => todayInZone(zone());

// The numbers of a day that are still in use: the codes of orders that have a parcel in the packing list. A parcel
// taken off the list gives its number back - when the last one of the day leaves, the next order is 01 again.
const usedSeqs = (db, day) => [
  ...db.prepare(`SELECT c.seq FROM order_codes c WHERE c.day = ? AND EXISTS
                   (SELECT 1 FROM inbound_parcels p WHERE p.match_channel = 'etsy' AND p.match_order_id = CAST(c.receipt_id AS TEXT))`)
    .all(day).map((r) => r.seq),
  ...db.prepare(`SELECT c.seq FROM shopify_order_codes c WHERE c.day = ? AND EXISTS
                   (SELECT 1 FROM inbound_parcels p WHERE p.match_channel = 'shopify' AND p.match_order_id = c.order_id)`)
    .all(day).map((r) => r.seq),
];

/**
 * The next number of a day: one after the highest number the packing list is holding (01 for an empty list), over
 * both shops' codes. An order that kept the code of a parcel long gone loses it when its number is handed out again.
 */
const nextSeq = (db, day) => Math.max(0, ...usedSeqs(db, day)) + 1;
const freeSeq = (db, day, seq) => {
  db.prepare("DELETE FROM order_codes WHERE day = ? AND seq = ? AND source = 'packing'").run(day, seq);
  db.prepare("DELETE FROM shopify_order_codes WHERE day = ? AND seq = ? AND source = 'packing'").run(day, seq);
};

/**
 * An order whose last parcel has left the packing list gives its code back (a code the packing list handed out;
 * one an order already had from before is kept). Called after a parcel is deleted, unmatched or moved.
 */
export function releaseIfUnused(channel, orderId) {
  if (!channel || orderId == null) return false;
  const db = getDb();
  if (db.prepare('SELECT 1 FROM inbound_parcels WHERE match_channel = ? AND match_order_id = ?').get(channel, String(orderId))) return false;
  const r = channel === 'etsy'
    ? db.prepare("DELETE FROM order_codes WHERE receipt_id = ? AND source = 'packing'").run(Number(orderId))
    : db.prepare("DELETE FROM shopify_order_codes WHERE order_id = ? AND source = 'packing'").run(String(orderId));
  return r.changes > 0;
}

/**
 * A code stamped on an earlier day is dropped when the order has nothing at the warehouse from that day or before:
 * every parcel of it arrived after the day on its code (or none is on the list), and none is packed yet. The next
 * code it is given carries today's date and the next number of today. An order that already has a parcel from the
 * day of its code keeps it - all its parcels carry one code. Returns { shopId } when a code was dropped.
 */
export function dropStaleCode(channel, orderId, { receivedOn = null } = {}) {
  const db = getDb();
  const today = codeDay();
  const row = channel === 'etsy'
    ? db.prepare('SELECT shop_id, day FROM order_codes WHERE receipt_id = ?').get(Number(orderId))
    : db.prepare('SELECT shop_id, day FROM shopify_order_codes WHERE order_id = ?').get(String(orderId));
  if (!row || !(row.day < today)) return null;
  if (receivedOn && String(receivedOn) <= row.day) return null; // the parcel being matched is itself from the code's day
  const parcels = db.prepare('SELECT received_on, packed_at FROM inbound_parcels WHERE match_channel = ? AND match_order_id = ?').all(channel, String(orderId));
  if (parcels.some((p) => p.packed_at || !(String(p.received_on) > row.day))) return null;
  if (channel === 'etsy') db.prepare('DELETE FROM order_codes WHERE receipt_id = ?').run(Number(orderId));
  else db.prepare('DELETE FROM shopify_order_codes WHERE order_id = ?').run(String(orderId));
  return { shopId: row.shop_id };
}

/**
 * Give the orders on the packing list today's codes when their old ones are from an earlier day (see dropStaleCode),
 * oldest arrival first so the numbers follow the order the parcels came in. Returns how many orders got a new code.
 */
export function restampStaleCodes() {
  const db = getDb();
  let n = 0;
  const orders = db.prepare(`SELECT match_channel AS channel, match_order_id AS orderId FROM inbound_parcels
                             WHERE match_channel IS NOT NULL GROUP BY match_channel, match_order_id ORDER BY MIN(id)`).all();
  for (const o of orders) {
    const dropped = dropStaleCode(o.channel, o.orderId);
    if (!dropped) continue;
    const issue = () => ensureOrderCode(o.channel, o.orderId);
    const code = o.channel === 'etsy' ? withShop(dropped.shopId, issue) : withShopifyShop(dropped.shopId, issue);
    if (code) {
      db.prepare('UPDATE inbound_parcels SET match_code = ? WHERE match_channel = ? AND match_order_id = ?').run(code, o.channel, String(o.orderId));
      n += 1;
    }
  }
  return n;
}

// ------------------------------------------------------------------- lookup

/** An Etsy order's code, or null while it has none (no parcel has been matched to it yet). */
export function codeFor(receiptId, { shopId = activeShopId() } = {}) {
  return getDb().prepare('SELECT code FROM order_codes WHERE shop_id IS ? AND receipt_id = ?').get(shopId, receiptId)?.code ?? null;
}

/** A Shopify order's code, or null while it has none. */
export function shopifyCodeFor(orderId, { shopId = activeShopifyShopId() } = {}) {
  return getDb().prepare('SELECT code FROM shopify_order_codes WHERE shop_id IS ? AND order_id = ?').get(shopId, orderId)?.code ?? null;
}

/** The codes the given Etsy orders already have, as { receiptId: code }. */
export function codesFor(receiptIds = [], shopId = activeShopId()) {
  const out = {};
  if (!receiptIds.length) return out;
  const rows = getDb().prepare(`
    SELECT receipt_id, code FROM order_codes
    WHERE shop_id IS ? AND receipt_id IN (${receiptIds.map(() => '?').join(',')})`).all(shopId, ...receiptIds);
  for (const r of rows) out[r.receipt_id] = r.code;
  return out;
}

/** The codes the given Shopify orders already have, as { orderId: code }. */
export function shopifyCodesFor(orderIds = [], shopId = activeShopifyShopId()) {
  const out = {};
  if (!orderIds.length) return out;
  const rows = getDb().prepare(`
    SELECT order_id, code FROM shopify_order_codes
    WHERE shop_id IS ? AND order_id IN (${orderIds.map(() => '?').join(',')})`).all(shopId, ...orderIds.map(String));
  for (const r of rows) out[r.order_id] = r.code;
  return out;
}

// ---------------------------------------------------------------- handing out

/**
 * The order's code, handing one out if it has none: today's date and the next
 * number of the day. Returns null only when the order is not in the local mirror.
 */
export function ensureOrderCode(channel, orderId, { receivedOn = null } = {}) {
  const db = getDb();
  if (channel === 'etsy') {
    // the order's own shop - the packing list holds the orders of every shop, whichever one is open
    const own = db.prepare('SELECT shop_id FROM receipts WHERE receipt_id = ?').get(Number(orderId));
    if (!own) return null;
    const shopId = own.shop_id;
    const id = Number(orderId);
    const existing = codeFor(id, { shopId });
    if (existing && !dropStaleCode('etsy', id, { receivedOn })) return existing;
    const day = codeDay();
    const seq = nextSeq(db, day);
    const code = formatCode(day, seq);
    freeSeq(db, day, seq);
    db.prepare(`INSERT INTO order_codes (shop_id, receipt_id, code, day, seq, source) VALUES (?,?,?,?,?, 'packing')
                ON CONFLICT(shop_id, receipt_id) DO NOTHING`).run(shopId, id, code, day, seq);
    return codeFor(id, { shopId }) ?? code;
  }
  if (channel === 'shopify') {
    const own = db.prepare('SELECT shop_id FROM shopify_orders WHERE order_id = ?').get(String(orderId));
    if (!own) return null;
    const shopId = own.shop_id;
    const id = String(orderId);
    const existing = shopifyCodeFor(id, { shopId });
    if (existing && !dropStaleCode('shopify', id, { receivedOn })) return existing;
    const day = codeDay();
    const seq = nextSeq(db, day);
    const code = formatCode(day, seq);
    freeSeq(db, day, seq);
    db.prepare(`INSERT INTO shopify_order_codes (shop_id, order_id, code, day, seq, source) VALUES (?,?,?,?,?, 'packing')
                ON CONFLICT(shop_id, order_id) DO NOTHING`).run(shopId, id, code, day, seq);
    return shopifyCodeFor(id, { shopId }) ?? code;
  }
  return null;
}

/**
 * Give an order the package code you typed (instead of the next one of the day). Kept as it is written; one code can
 * belong to one order only, across every shop. An order that already had a code takes the new one in its place.
 */
export function setOrderCode(channel, orderId, code) {
  const db = getDb();
  const text = String(code ?? '').trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,38}$/.test(text)) throw badRequest('A package code is letters, digits, "-", "." or "_" (for example 26-1009-03).');
  const taken = db.prepare('SELECT receipt_id AS id FROM order_codes WHERE lower(code) = ?').get(text.toLowerCase());
  const takenShopify = db.prepare('SELECT order_id AS id FROM shopify_order_codes WHERE lower(code) = ?').get(text.toLowerCase());
  const mine = (channel === 'etsy' ? String(taken?.id ?? '') : String(takenShopify?.id ?? '')) === String(orderId);
  if ((taken || takenShopify) && !mine) throw badRequest(`The code ${text} already belongs to another order.`);
  const m = /^(\d{2})-(\d{2})(\d{2})-(\d{1,3})/.exec(text);
  const day = m ? `20${m[1]}-${m[2]}-${m[3]}` : codeDay();
  const seq = m ? Number(m[4]) : 0;
  if (channel === 'etsy') {
    const own = db.prepare('SELECT shop_id FROM receipts WHERE receipt_id = ?').get(Number(orderId));
    if (!own) throw notFound('That order is not here.');
    db.prepare(`INSERT INTO order_codes (shop_id, receipt_id, code, day, seq, source) VALUES (?,?,?,?,?, 'manual')
                ON CONFLICT(shop_id, receipt_id) DO UPDATE SET code = excluded.code, day = excluded.day, seq = excluded.seq, source = 'manual'`)
      .run(own.shop_id, Number(orderId), text, day, seq);
  } else {
    const own = db.prepare('SELECT shop_id FROM shopify_orders WHERE order_id = ?').get(String(orderId));
    if (!own) throw notFound('That order is not here.');
    db.prepare(`INSERT INTO shopify_order_codes (shop_id, order_id, code, day, seq, source) VALUES (?,?,?,?,?, 'manual')
                ON CONFLICT(shop_id, order_id) DO UPDATE SET code = excluded.code, day = excluded.day, seq = excluded.seq, source = 'manual'`)
      .run(own.shop_id, String(orderId), text, day, seq);
  }
  return text;
}

/**
 * Whichever order of any connected shop this names. Typed by hand, so it is read
 * generously: an order code as written on a sheet (any letter case, stray
 * spaces ignored), or - for an order that has no code yet - its own number:
 * Shopify's "#2419", or an Etsy receipt number. Codes are unique across every shop; a Shopify order
 * number that two stores share goes to the open store's order.
 */
export function findOrderByCode(code) {
  const text = String(code ?? '').trim();
  const wanted = text.replace(/\s+/g, '').toLowerCase();
  if (!wanted) return null;
  const db = getDb();
  const openStore = activeShopifyShopId();

  const etsy = db.prepare('SELECT receipt_id FROM order_codes WHERE lower(code) = ?').get(wanted);
  if (etsy) return { channel: 'etsy', orderId: String(etsy.receipt_id) };
  const shopify = db.prepare('SELECT order_id FROM shopify_order_codes WHERE lower(code) = ?').get(wanted);
  if (shopify) return { channel: 'shopify', orderId: shopify.order_id };

  // Not a code: an order number.
  const digits = wanted.replace(/^#/, '');
  if (!/^\d{1,15}$/.test(digits)) return null;
  const byName = () => db.prepare('SELECT order_id FROM shopify_orders WHERE name = ? ORDER BY (shop_id = ?) DESC, created_at_shopify DESC').get(`#${digits}`, openStore ?? -1);
  if (wanted.startsWith('#')) {
    const o = byName();
    return o ? { channel: 'shopify', orderId: o.order_id } : null;
  }
  const receipt = db.prepare('SELECT receipt_id FROM receipts WHERE receipt_id = ?').get(Number(digits));
  if (receipt) return { channel: 'etsy', orderId: String(receipt.receipt_id) };
  const o = byName();
  return o ? { channel: 'shopify', orderId: o.order_id } : null;
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
