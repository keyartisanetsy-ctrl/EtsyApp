/**
 * Holds: what to do with the first parcel of an order that is not all here yet.
 *
 * A parcel cannot be sent on until every other piece of its order has also
 * reached the warehouse. So when a parcel is matched to an order that still
 * lacks something, the order gets a HOLD code - HOLD-1524, the last digits of
 * that parcel's China tracking number - and the warehouse is asked (in
 * Chinese) to keep the parcel for a short while. The hold is remembered: when
 * the next piece is matched to the order it carries the same code, and once
 * the order is complete the hold is released but kept, so both parcels still
 * show the same HOLD code on the packing sheet and the warehouse is told to
 * send them together.
 *
 * Nothing here is incremental. Whether an order is complete, and which parcels
 * belong to it, is worked out from the matched parcels every time
 * (`refreshHold`), so matching, unmatching, editing and deleting a parcel can
 * never leave a hold out of step.
 */
import { getDb, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('holds');

export const HOLD_PREFIX = 'HOLD';

// ------------------------------------------------------------------ messages

/** Asked of the warehouse when a parcel has to wait for the rest of its order. */
export const holdMessageZh = (code) =>
  `您好!为了能够发出这件商品,我们需要等待该订单的另一件商品也到货,因此能否麻烦您先把这件商品在仓库里短暂保管一下?谢谢!(暂存编号:${code})`;

export const holdMessageEn = (code) =>
  `Hello! To be able to send this item we have to wait for the other item of the same order to arrive as well, so could you please keep it in the warehouse for a short while? Thank you! (Hold code: ${code})`;

/** Said when the last piece has arrived and the held parcels can go. */
export const releaseMessageZh = (code) =>
  `您好!该订单的所有商品现已全部到齐,请将暂存编号 ${code} 的商品一起发出。谢谢!`;

export const releaseMessageEn = (code) =>
  `Hello! Every item of this order has arrived now - please send the items with hold code ${code} out together. Thank you!`;

// ----------------------------------------------------------------- progress

function orderItems(db, channel, orderId) {
  if (channel === 'etsy') {
    return db.prepare('SELECT transaction_id AS id, quantity, COALESCE(is_digital,0) AS digital FROM receipt_transactions WHERE receipt_id = ?')
      .all(Number(orderId)).filter((r) => !r.digital).map((r) => ({ id: String(r.id), quantity: r.quantity || 1 }));
  }
  return db.prepare('SELECT line_item_id AS id, quantity FROM shopify_order_line_items WHERE order_id = ?')
    .all(String(orderId)).map((r) => ({ id: String(r.id), quantity: r.quantity || 1 }));
}

/** The parcels matched to an order, what it needs, and how much of that has arrived. */
export function orderProgress(db, channel, orderId) {
  const parcels = db.prepare(`
    SELECT * FROM inbound_parcels WHERE match_channel = ? AND match_order_id = ? AND quantity > 0
    ORDER BY matched_at ASC, id ASC`).all(channel, String(orderId));
  const items = orderItems(db, channel, orderId);
  const got = new Map();
  for (const p of parcels) got.set(String(p.match_item_id), (got.get(String(p.match_item_id)) ?? 0) + p.quantity);
  let needed = 0;
  let received = 0;
  for (const it of items) {
    needed += it.quantity;
    received += Math.min(it.quantity, got.get(it.id) ?? 0);
  }
  return { parcels, items, needed, received, known: items.length > 0, complete: items.length > 0 && received >= needed };
}

// --------------------------------------------------------------------- codes

/** The digits a hold code is made of: the parcel's own last four, else the tail of the order number. */
function holdDigits(db, channel, orderId, parcel) {
  const own = String(parcel?.last4 ?? '').replace(/\D/g, '');
  if (own) return own.slice(-4);
  let number = String(orderId);
  if (channel === 'shopify') {
    number = db.prepare('SELECT name FROM shopify_orders WHERE order_id = ?').get(String(orderId))?.name || number;
  }
  const digits = number.replace(/\D/g, '');
  return (digits || '0000').slice(-4).padStart(4, '0');
}

/** HOLD-1524, or HOLD-1524-2 when another order that is still on hold already has it. */
function uniqueCode(db, channel, orderId, digits) {
  const taken = (code) => !!db.prepare(`
    SELECT 1 FROM order_holds WHERE hold_code = ? AND released_at IS NULL AND NOT (channel = ? AND order_id = ?)`)
    .get(code, channel, String(orderId));
  let code = `${HOLD_PREFIX}-${digits}`;
  for (let n = 2; taken(code); n += 1) code = `${HOLD_PREFIX}-${digits}-${n}`;
  return code;
}

// ------------------------------------------------------------------- refresh

/**
 * Bring an order's hold in line with the parcels matched to it now. Returns
 * the hold row, or null when the order has none.
 */
export function refreshHold(channel, orderId) {
  const db = getDb();
  const id = String(orderId);
  const row = db.prepare('SELECT * FROM order_holds WHERE channel = ? AND order_id = ?').get(channel, id);
  const progress = orderProgress(db, channel, id);

  if (!progress.parcels.length) {
    if (row) db.prepare('DELETE FROM order_holds WHERE channel = ? AND order_id = ?').run(channel, id);
    return null;
  }
  if (!progress.known) return row ?? null; // the order is not in the local mirror (any more): change nothing

  if (!row) {
    if (progress.complete) return null; // everything arrived with its first parcel: nothing to hold
    const anchor = progress.parcels[0];
    const code = uniqueCode(db, channel, id, holdDigits(db, channel, id, anchor));
    db.prepare('INSERT INTO order_holds (channel, order_id, hold_code, anchor_parcel_id) VALUES (?,?,?,?)').run(channel, id, code, anchor.id);
    audit('packing.hold', { entity: 'order', entityId: id, detail: { channel, code, parcel: anchor.id } });
    log.info(`${channel} order ${id} on hold as ${code}`);
    return db.prepare('SELECT * FROM order_holds WHERE channel = ? AND order_id = ?').get(channel, id);
  }

  // The code follows the anchor parcel's tracking digits - if they were corrected, the hold is written again.
  let anchor = progress.parcels.find((p) => p.id === row.anchor_parcel_id);
  if (!anchor) [anchor] = progress.parcels;
  const wanted = holdDigits(db, channel, id, anchor);
  let code = row.hold_code;
  if (!(code === `${HOLD_PREFIX}-${wanted}` || code.startsWith(`${HOLD_PREFIX}-${wanted}-`))) {
    code = uniqueCode(db, channel, id, wanted);
    log.info(`${channel} order ${id}: hold ${row.hold_code} rewritten as ${code}`);
  }
  const releasedNow = progress.complete || row.forced_release === 1;
  db.prepare(`
    UPDATE order_holds SET hold_code = ?, anchor_parcel_id = ?,
      released_at = CASE WHEN ? = 1 THEN COALESCE(released_at, datetime('now')) ELSE NULL END,
      updated_at = datetime('now')
    WHERE channel = ? AND order_id = ?`).run(code, anchor.id, releasedNow ? 1 : 0, channel, id);
  return db.prepare('SELECT * FROM order_holds WHERE channel = ? AND order_id = ?').get(channel, id);
}

/** Refresh the hold of every order that has a parcel matched to it - run once at start-up for data from before holds existed. */
export function backfillHolds() {
  const db = getDb();
  const orders = db.prepare(`SELECT DISTINCT match_channel AS channel, match_order_id AS orderId
                             FROM inbound_parcels WHERE match_channel IS NOT NULL`).all();
  let n = 0;
  for (const o of orders) {
    try { if (refreshHold(o.channel, o.orderId)) n += 1; } catch (err) { log.warn(`hold for ${o.channel} ${o.orderId}: ${err.message}`); }
  }
  if (n) log.info(`${n} order(s) on hold or released from a hold`);
  return n;
}

// -------------------------------------------------------------------- reading

/** What the rest of the app shows about a hold row. */
function describe(db, row) {
  const active = !row.released_at;
  const progress = orderProgress(db, row.channel, row.order_id);
  return {
    code: row.hold_code,
    state: active ? 'active' : 'released',
    forced: row.forced_release === 1,
    received: progress.received,
    needed: progress.needed,
    messageZh: active ? holdMessageZh(row.hold_code) : releaseMessageZh(row.hold_code),
    messageEn: active ? holdMessageEn(row.hold_code) : releaseMessageEn(row.hold_code),
  };
}

/** The hold of one order, described, or null. */
export function holdFor(channel, orderId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM order_holds WHERE channel = ? AND order_id = ?').get(channel, String(orderId));
  return row ? describe(db, row) : null;
}

/** Every hold, keyed "channel:orderId" - for lists, so each parcel row does not ask on its own. */
export function allHolds() {
  const db = getDb();
  const out = new Map();
  for (const row of db.prepare('SELECT * FROM order_holds').all()) out.set(`${row.channel}:${row.order_id}`, describe(db, row));
  return out;
}

/** The code of an order's hold while it is still waiting, for sheets (Airtable); null otherwise. */
export function activeHoldCode(channel, orderId) {
  const row = getDb().prepare('SELECT hold_code, released_at FROM order_holds WHERE channel = ? AND order_id = ?').get(channel, String(orderId));
  return row && !row.released_at ? row.hold_code : null;
}

// ------------------------------------------------------------------ by hand

/**
 * Let the held parcels go even though the order is not complete (the missing
 * piece will not come through the warehouse), or put the hold back.
 */
export function setHoldRelease(channel, orderId, released) {
  const db = getDb();
  const id = String(orderId);
  const row = db.prepare('SELECT * FROM order_holds WHERE channel = ? AND order_id = ?').get(channel, id);
  if (!row) throw notFound('That order has no hold.');
  if (released === false && orderProgress(db, channel, id).complete) throw badRequest('Every piece of this order has arrived, so there is nothing left to hold for.');
  db.prepare('UPDATE order_holds SET forced_release = ? WHERE channel = ? AND order_id = ?').run(released ? 1 : 0, channel, id);
  const fresh = refreshHold(channel, id);
  audit(released ? 'packing.hold_release' : 'packing.hold_again', { entity: 'order', entityId: id, detail: { channel, code: row.hold_code } });
  return fresh ? describe(db, fresh) : null;
}
