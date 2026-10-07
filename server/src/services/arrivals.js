/**
 * What the warehouse has already delivered for each order, so the Orders lists
 * can show it next to the order's code without knowing anything about parcels.
 */
import { getDb } from '../db/index.js';
import { allHolds } from './holds.js';

/** Parcels matched to these orders: { received, parcels: [{ id, label }], packed, hold } per order id. */
export function arrivalsFor(channel, orderIds = []) {
  const map = new Map();
  if (!orderIds.length) return map;
  const rows = getDb().prepare(`
    SELECT id, carrier, last4, quantity, match_order_id AS orderId, packed_at
    FROM inbound_parcels
    WHERE match_channel = ? AND match_order_id IN (${orderIds.map(() => '?').join(',')})
    ORDER BY id`).all(channel, ...orderIds.map(String));
  for (const r of rows) {
    const entry = map.get(r.orderId) ?? { received: 0, parcels: [], packed: true };
    entry.received += r.quantity || 1;
    entry.parcels.push({ id: r.id, label: [r.carrier, r.last4].filter(Boolean).join(' ') });
    if (!r.packed_at) entry.packed = false;
    map.set(r.orderId, entry);
  }
  // An order that is waiting for its other pieces carries its HOLD code (and keeps it, released, once complete).
  const onHold = allHolds();
  for (const [orderId, entry] of map) {
    const hold = onHold.get(`${channel}:${orderId}`);
    entry.hold = hold ? { code: hold.code, state: hold.state } : null;
  }
  return map;
}

/** An order's arrival summary with the number of pieces it needs, or null when nothing has arrived. */
export function arrivalFor(arrivals, orderId, items = []) {
  const a = arrivals.get(String(orderId));
  if (!a) return null;
  return { ...a, needed: items.reduce((n, i) => n + (i.quantity || 1), 0) || null };
}
