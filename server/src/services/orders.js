/**
 * Order desk: the working list with its Done tick column, the detail view,
 * and copy-ready text blocks for pasting into supplier forms.
 */
import { call } from '../etsy/client.js';
import { requireShopId, activeShopId } from '../etsy/shop.js';
import { getDb, parse, audit } from '../db/index.js';
import { trackingUrl } from './settings.js';
import { STATUS_LABELS } from './tracking/status.js';
import { notFound, badRequest } from '../lib/errors.js';
import { statusesFor } from './orderstatus.js';
import { feeFor } from './offsiteads.js';

const asMoney = (amount, divisor, currency) =>
  amount == null ? null : { value: amount / (divisor || 100), currency };

/**
 * The order list.
 * `done` / `seen` drive the tick column and the "new orders" badge.
 */
export function listOrders({
  search = '', done = null, seen = null, shipped = null, paid = null, canceled = null,
  hasTracking = null, alertsOnly = false, country = '', sinceDays = null,
  sort = 'created', dir = 'desc', limit = 100, offset = 0,
} = {}) {
  const db = getDb();
  const where = ['r.shop_id IS ?'];
  const params = [activeShopId()];

  const flag = (col, v) => { if (v !== null && v !== undefined && v !== '') { where.push(`${col} = ?`); params.push(v ? 1 : 0); } };
  flag('COALESCE(f.is_done,0)', done);
  flag('COALESCE(f.is_seen,0)', seen);
  flag('r.was_shipped', shipped);
  flag('r.was_paid', paid);
  flag('r.was_canceled', canceled);

  if (hasTracking !== null && hasTracking !== undefined && hasTracking !== '') {
    where.push(hasTracking ? 's.tracking_code IS NOT NULL' : 's.tracking_code IS NULL');
  }
  if (alertsOnly) where.push("(t.is_stale = 1 OR t.status IN ('exception','not_found','returned')) AND COALESCE(t.alert_ack,0) = 0");
  if (country) { where.push('r.country_iso = ?'); params.push(country); }
  if (sinceDays) { where.push('r.created_ts >= ?'); params.push(Math.floor(Date.now() / 1000) - sinceDays * 86_400); }
  if (search) {
    where.push(`(CAST(r.receipt_id AS TEXT) LIKE ? OR r.name LIKE ? OR r.buyer_email LIKE ?
                 OR r.city LIKE ? OR s.tracking_code LIKE ?
                 OR EXISTS (SELECT 1 FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id
                            AND (x.title LIKE ? OR x.sku LIKE ?)))`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const sortable = { created: 'r.created_ts', updated: 'r.updated_ts', total: 'r.grandtotal_amount', name: 'r.name', status: 'r.status' };
  const orderBy = sortable[sort] || 'r.created_ts';
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const clause = `WHERE ${where.join(' AND ')}`;

  // One shipment/tracking row per receipt (the most recent) keeps the join flat.
  const base = `
    FROM receipts r
    LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
    LEFT JOIN (SELECT receipt_id, MAX(last_pushed_at) AS airtable_pushed_at
               FROM airtable_links GROUP BY receipt_id) al ON al.receipt_id = r.receipt_id
    LEFT JOIN (SELECT receipt_id, MAX(id) AS sid FROM shipments GROUP BY receipt_id) ls ON ls.receipt_id = r.receipt_id
    LEFT JOIN shipments s ON s.id = ls.sid
    LEFT JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS s.shop_id
    ${clause}`;

  const rows = db.prepare(`
    SELECT r.*, COALESCE(f.is_done,0) AS is_done, f.done_at, COALESCE(f.is_seen,0) AS is_seen,
           COALESCE(f.is_flagged,0) AS is_flagged, COALESCE(f.supplier_ordered,0) AS supplier_ordered,
           f.supplier_order_ref, f.notes,
           COALESCE(f.problem_state,'none') AS problem_state, f.problem_note,
           COALESCE(f.offsite_ads,0) AS offsite_ads,
           al.airtable_pushed_at,
           s.tracking_code, s.carrier_name, s.pushed_to_etsy,
           t.status AS tracking_status, t.days_since_move, t.is_stale, t.alert_reason,
           t.last_event_text, t.last_event_at, COALESCE(t.alert_ack,0) AS alert_ack,
           (SELECT COUNT(*) FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id) AS item_count
    ${base} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;

  return {
    total, limit, offset,
    rows: rows.map(orderSummary),
  };
}

function orderSummary(r) {
  return {
    receiptId: r.receipt_id,
    name: r.name,
    buyerEmail: r.buyer_email,
    country: r.country_iso,
    city: r.city,
    status: r.status,
    itemCount: r.item_count,
    total: asMoney(r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency),
    isPaid: !!r.was_paid,
    isShipped: !!r.was_shipped,
    isDelivered: !!r.was_delivered,
    isCanceled: !!r.was_canceled,
    isGift: !!r.is_gift,
    messageFromBuyer: r.message_from_buyer || '',
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
    expectedShipTs: r.expected_ship_ts,
    // What state the order is actually in - several at once when that is the
    // truth, e.g. delivered but with a problem raised afterwards.
    statuses: statusesFor(r),
    problemState: r.problem_state ?? 'none',
    offsiteAds: !!r.offsite_ads,
    offsiteAdsFee: feeFor(r),
    problemNote: r.problem_note ?? '',
    subtotal: asMoney(r.subtotal_amount, r.grandtotal_divisor, r.grandtotal_currency),
    // Small contact line under the buyer, so you can reach them without opening the order.
    email: r.buyer_email || r.payment_email || '',
    addressLine: [r.first_line, r.city, r.state, r.zip].filter(Boolean).join(', '),
    itemCount: r.item_count,
    // the tick column
    isDone: !!r.is_done,
    doneAt: r.done_at,
    isSeen: !!r.is_seen,
    isNew: !r.is_seen,
    isFlagged: !!r.is_flagged,
    supplierOrdered: !!r.supplier_ordered,
    supplierOrderRef: r.supplier_order_ref || '',
    notes: r.notes || '',
    // tracking
    trackingCode: r.tracking_code || null,
    trackingUrl: r.tracking_code ? trackingUrl(r.tracking_code) : null,
    carrier: r.carrier_name,
    pushedToEtsy: !!r.pushed_to_etsy,
    trackingStatus: r.tracking_status || null,
    trackingStatusLabel: r.tracking_status ? (STATUS_LABELS[r.tracking_status] ?? r.tracking_status) : null,
    daysSinceMove: r.days_since_move,
    isStale: !!r.is_stale,
    alert: !!(r.is_stale || ['exception', 'not_found', 'returned'].includes(r.tracking_status)) && !r.alert_ack,
    alertReason: r.alert_reason || '',
    lastEventText: r.last_event_text,
    lastEventAt: r.last_event_at,
  };
}

export function getOrder(receiptId) {
  const db = getDb();
  const r = db.prepare(`
    SELECT r.*, COALESCE(f.is_done,0) AS is_done, f.done_at, COALESCE(f.is_seen,0) AS is_seen,
           COALESCE(f.is_flagged,0) AS is_flagged, COALESCE(f.supplier_ordered,0) AS supplier_ordered,
           f.supplier_order_ref, f.notes, 0 AS item_count,
           COALESCE(f.problem_state,'none') AS problem_state, f.problem_note,
           COALESCE(f.offsite_ads,0) AS offsite_ads,
           al.airtable_pushed_at,
           s.tracking_code, s.carrier_name, t.status AS tracking_status, t.days_since_move
    FROM receipts r
    LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
    LEFT JOIN (SELECT receipt_id, MAX(last_pushed_at) AS airtable_pushed_at
               FROM airtable_links GROUP BY receipt_id) al ON al.receipt_id = r.receipt_id
    LEFT JOIN (SELECT receipt_id, MAX(id) AS sid FROM shipments GROUP BY receipt_id) ls ON ls.receipt_id = r.receipt_id
    LEFT JOIN shipments s ON s.id = ls.sid
    LEFT JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS r.shop_id
    WHERE r.receipt_id = ? AND r.shop_id IS ?`).get(receiptId, activeShopId());
  if (!r) throw notFound(`Order ${receiptId} is not in the active shop's local mirror. Sync orders first.`);

  const items = db.prepare(`
    SELECT x.*, m.supply_link, m.supplier_name, m.supply_cost
    FROM receipt_transactions x LEFT JOIN sku_meta m ON m.sku = x.sku AND x.sku <> ''
    WHERE x.receipt_id = ? ORDER BY x.transaction_id`).all(receiptId);

  const shipments = db.prepare(`
    SELECT s.*, t.status, t.status_detail, t.last_event_at, t.last_event_text, t.days_since_move,
           t.is_stale, t.alert_reason, t.event_count
    FROM shipments s LEFT JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS s.shop_id
    WHERE s.receipt_id = ? ORDER BY s.id DESC`).all(receiptId);

  return {
    ...orderSummary({ ...r, item_count: items.length }),
    address: {
      name: r.name,
      firstLine: r.first_line,
      secondLine: r.second_line,
      city: r.city,
      state: r.state,
      zip: r.zip,
      country: r.country_iso,
      formatted: r.formatted_address,
    },
    messages: {
      fromBuyer: r.message_from_buyer || '',
      fromSeller: r.message_from_seller || '',
      fromPayment: r.message_from_payment || '',
      giftMessage: r.gift_message || '',
    },
    totals: {
      grand: asMoney(r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency),
      subtotal: asMoney(r.subtotal_amount, r.grandtotal_divisor, r.grandtotal_currency),
      shipping: asMoney(r.total_shipping_amount, r.grandtotal_divisor, r.grandtotal_currency),
      tax: asMoney(r.total_tax_amount, r.grandtotal_divisor, r.grandtotal_currency),
      discount: asMoney(r.discount_amount, r.grandtotal_divisor, r.grandtotal_currency),
    },
    paymentMethod: r.payment_method,
    items: items.map((i) => ({
      transactionId: i.transaction_id,
      listingId: i.listing_id,
      productId: i.product_id,
      sku: i.sku || '',
      title: i.title,
      quantity: i.quantity,
      price: asMoney(i.price_amount, i.price_divisor, i.price_currency),
      variations: parse(i.variations, []),
      variationLabel: (parse(i.variations, []) || [])
        .map((v) => `${v.formatted_name ?? v.property_name ?? ''}: ${v.formatted_value ?? v.value ?? ''}`.trim())
        .filter((s) => s !== ':').join(' / '),
      imageUrl: i.image_url,
      isDigital: !!i.is_digital,
      supplyLink: i.supply_link || '',
      supplierName: i.supplier_name || '',
      supplyCost: i.supply_cost ?? null,
    })),
    shipments: shipments.map((s) => ({
      trackingCode: s.tracking_code,
      trackingUrl: trackingUrl(s.tracking_code),
      carrier: s.carrier_name,
      pushedToEtsy: !!s.pushed_to_etsy,
      pushedAt: s.pushed_at,
      pushError: s.push_error,
      status: s.status,
      statusLabel: s.status ? (STATUS_LABELS[s.status] ?? s.status) : null,
      statusDetail: s.status_detail,
      lastEventAt: s.last_event_at,
      lastEventText: s.last_event_text,
      daysSinceMove: s.days_since_move,
      isStale: !!s.is_stale,
      alertReason: s.alert_reason,
      eventCount: s.event_count,
    })),
    raw: parse(r.raw, null),
  };
}

// ------------------------------------------------------------- tick column

const flagColumns = {
  done: 'is_done', seen: 'is_seen', flagged: 'is_flagged', supplierOrdered: 'supplier_ordered',
};

/** Toggle any tick on one or many orders. "Done" also stamps the time. */
export function setFlags(receiptIds, patch = {}) {
  const db = getDb();
  const ids = (Array.isArray(receiptIds) ? receiptIds : [receiptIds]).map(Number).filter(Boolean);
  if (!ids.length) throw badRequest('No orders selected.');

  db.transaction(() => {
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO order_flags (receipt_id) VALUES (?)').run(id);
      for (const [key, column] of Object.entries(flagColumns)) {
        if (patch[key] === undefined) continue;
        const value = patch[key] ? 1 : 0;
        db.prepare(`UPDATE order_flags SET ${column} = ?, updated_at = datetime('now') WHERE receipt_id = ?`).run(value, id);
        if (key === 'done') db.prepare(`UPDATE order_flags SET done_at = ${value ? "datetime('now')" : 'NULL'} WHERE receipt_id = ?`).run(id);
        if (key === 'seen') db.prepare(`UPDATE order_flags SET seen_at = ${value ? "datetime('now')" : 'NULL'} WHERE receipt_id = ?`).run(id);
      }
      if (patch.notes !== undefined) db.prepare('UPDATE order_flags SET notes = ? WHERE receipt_id = ?').run(String(patch.notes), id);
      if (patch.supplierOrderRef !== undefined) db.prepare('UPDATE order_flags SET supplier_order_ref = ? WHERE receipt_id = ?').run(String(patch.supplierOrderRef), id);
    }
  })();

  audit('orders.flags', { entity: 'receipt', detail: { ids, patch } });
  return { updated: ids.length, ids };
}

export const markSeen = (receiptIds) => setFlags(receiptIds, { seen: true });

/**
 * Raise, clear or resolve a problem on orders. Deliberate rather than derived,
 * because only you (or the AI, on your instruction) know whether something is
 * actually wrong - and an order can be delivered and still have one.
 */
export function setProblem(receiptIds, { state = 'warning', note = '' } = {}) {
  const allowed = ['none', 'warning', 'solved', 'out_of_stock'];
  if (!allowed.includes(state)) throw badRequest(`Unknown problem state "${state}". Use one of ${allowed.join(', ')}.`);
  const db = getDb();
  const ids = (Array.isArray(receiptIds) ? receiptIds : [receiptIds]).map(Number).filter(Boolean);
  if (!ids.length) throw badRequest('No orders selected.');

  db.transaction(() => {
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO order_flags (receipt_id) VALUES (?)').run(id);
      db.prepare(`UPDATE order_flags SET problem_state = ?, problem_note = ?, updated_at = datetime('now')
                  WHERE receipt_id = ?`).run(state, String(note ?? '').slice(0, 500), id);
    }
  })();
  audit('orders.problem', { entity: 'receipt', detail: { ids, state, note } });
  return { updated: ids.length, ids, state };
}



export function orderCounters() {
  const db = getDb();
  const shop = activeShopId();
  const one = (sql) => db.prepare(sql).get(shop).c;
  return {
    total: one('SELECT COUNT(*) AS c FROM receipts WHERE shop_id IS ?'),
    newOrders: one(`SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
                    WHERE r.shop_id IS ? AND COALESCE(f.is_seen,0) = 0`),
    notDone: one(`SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
                  WHERE r.shop_id IS ? AND COALESCE(f.is_done,0) = 0 AND COALESCE(r.was_canceled,0) = 0`),
    done: one(`SELECT COUNT(*) AS c FROM order_flags f JOIN receipts r ON r.receipt_id = f.receipt_id
               WHERE r.shop_id IS ? AND f.is_done = 1`),
    unshipped: one('SELECT COUNT(*) AS c FROM receipts WHERE shop_id IS ? AND COALESCE(was_shipped,0) = 0 AND COALESCE(was_canceled,0) = 0'),
    noTracking: one(`SELECT COUNT(*) AS c FROM receipts r WHERE r.shop_id IS ? AND COALESCE(r.was_canceled,0) = 0
                     AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.receipt_id = r.receipt_id)`),
    alerts: one(`SELECT COUNT(*) AS c FROM tracking WHERE shop_id IS ?
                 AND (is_stale = 1 OR status IN ('exception','not_found','returned')) AND alert_ack = 0`),
  };
}

// ------------------------------------------------------------ copy helpers

/** Plain-text blocks the operator copies straight out of the detail panel. */
export function copyBlocks(receiptId) {
  const o = getOrder(receiptId);
  const a = o.address;
  const addressBlock = [a.name, a.firstLine, a.secondLine, [a.city, a.state, a.zip].filter(Boolean).join(' '), a.country]
    .filter(Boolean).join('\n');

  const itemsBlock = o.items
    .map((i) => `${i.quantity} x ${i.title}${i.variationLabel ? ` (${i.variationLabel})` : ''}${i.sku ? ` [SKU ${i.sku}]` : ''}`)
    .join('\n');

  const supplyBlock = o.items.filter((i) => i.supplyLink)
    .map((i) => `${i.sku || i.title}: ${i.supplyLink}`).join('\n');

  const full = [
    `Order #${o.receiptId}`,
    `Placed: ${o.createdTs ? new Date(o.createdTs * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-'}`,
    `Buyer: ${o.name ?? '-'}`,
    '',
    'Ship to:', addressBlock,
    '',
    'Items:', itemsBlock,
    o.messages.fromBuyer ? `\nBuyer note:\n${o.messages.fromBuyer}` : '',
    o.messages.giftMessage ? `\nGift message:\n${o.messages.giftMessage}` : '',
    o.trackingCode ? `\nTracking: ${o.trackingCode}\n${o.trackingUrl}` : '',
    `\nTotal: ${o.total ? `${o.total.currency} ${o.total.value.toFixed(2)}` : '-'}`,
  ].filter((s) => s !== '').join('\n');

  return { address: addressBlock, items: itemsBlock, supplyLinks: supplyBlock, full, tracking: o.trackingCode ?? '', trackingUrl: o.trackingUrl ?? '' };
}

/** Push seller-side receipt changes back to Etsy (updateShopReceipt). */
export async function updateEtsyReceipt(receiptId, { wasPaid, wasShipped }) {
  const shopId = requireShopId();
  const body = {};
  if (wasPaid !== undefined) body.was_paid = !!wasPaid;
  if (wasShipped !== undefined) body.was_shipped = !!wasShipped;
  if (!Object.keys(body).length) throw badRequest('Nothing to update.');

  const res = await call('updateShopReceipt', { shop_id: shopId, receipt_id: receiptId }, { body });
  getDb().prepare('UPDATE receipts SET was_paid = ?, was_shipped = ? WHERE receipt_id = ?')
    .run(res.was_paid ? 1 : 0, res.was_shipped ? 1 : 0, receiptId);
  audit('orders.updateReceipt', { entity: 'receipt', entityId: receiptId, detail: body });
  return res;
}
