/**
 * Order desk: the working list with its Done tick column, the detail view,
 * and copy-ready text blocks for pasting into supplier forms.
 */
import { call } from '../etsy/client.js';
import { requireShopId, activeShopId } from '../etsy/shop.js';
import { getDb, parse, audit } from '../db/index.js';
import { trackingUrl, readSetting } from './settings.js';
import { STATUS_LABELS } from './tracking/status.js';
import { notFound, badRequest } from '../lib/errors.js';
import { statusesFor } from './orderstatus.js';
import { feeFor } from './offsiteads.js';
import { reportingCurrency } from './reporting.js';
import { resolveForTransaction } from './productimages.js';
import { convert } from './fx.js';

const asMoney = (amount, divisor, currency) =>
  amount == null ? null : { value: amount / (divisor || 100), currency };
const round2 = (n) => (n === null || n === undefined ? null : Math.round((n + Number.EPSILON) * 100) / 100);

/**
 * "Ships in 2-5 business days" - the promise made on the listing.
 *
 * Counted in business days, because that is how the promise is worded and
 * because a Friday order that says "2 days" means Tuesday, not Sunday. Etsy's
 * own expected-ship date, when it sends one, is the authority; this is what to
 * show when it does not.
 */
export function shipWindow(fromTs) {
  const min = Math.max(0, Number(readSetting('orders.ship_days_min')) || 2);
  const max = Math.max(min, Number(readSetting('orders.ship_days_max')) || 5);
  if (!fromTs) return { minDays: min, maxDays: max, from: null, to: null };

  const addBusinessDays = (ts, days) => {
    const d = new Date(ts * 1000);
    let left = days;
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) left -= 1;
    }
    return Math.floor(d.getTime() / 1000);
  };

  return {
    minDays: min,
    maxDays: max,
    from: addBusinessDays(fromTs, min),
    to: addBusinessDays(fromTs, max),
  };
}

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
  // Canceled here means either side: Etsy's own was_canceled, or a cancel you
  // applied yourself in the app (order_flags.is_canceled - Etsy has no cancel
  // endpoint, so that one never reaches Etsy). Left unset, canceled orders of
  // either kind are hidden by default, so a working queue does not fill up
  // with orders nobody is going to fulfill; pass canceled=false explicitly to
  // get the same result, or canceled=true to see only the canceled ones.
  const canceledExpr = '(COALESCE(r.was_canceled,0) = 1 OR COALESCE(f.is_canceled,0) = 1)';
  if (canceled === true || canceled === 'true') where.push(canceledExpr);
  else where.push(`NOT ${canceledExpr}`);

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
           f.supplier_order_ref, f.supply_tracking_number, f.notes,
           COALESCE(f.problem_state,'none') AS problem_state, f.problem_note,
           COALESCE(f.offsite_ads,0) AS offsite_ads,
           COALESCE(f.is_canceled,0) AS locally_canceled, f.canceled_at,
           f.manual_cost, f.manual_cost_note,
           al.airtable_pushed_at,
           s.tracking_code, s.carrier_name, s.pushed_to_etsy,
           t.status AS tracking_status, t.days_since_move, t.is_stale, t.alert_reason,
           t.last_event_text, t.last_event_at, COALESCE(t.alert_ack,0) AS alert_ack,
           (SELECT COUNT(*) FROM receipt_transactions x WHERE x.receipt_id = r.receipt_id) AS item_count
    ${base} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
  const supplyPreview = loadSupplyPreview(db, activeShopId(), rows.map((r) => r.receipt_id));
  const ledgerSummaries = loadLedgerSummaries(db, activeShopId(), rows.map((r) => r.receipt_id));
  const orderCosts = loadOrderCosts(db, activeShopId(), rows.map((r) => r.receipt_id));

  return {
    total, limit, offset,
    // The currency the shop reports in, so the list can put a converted figure
    // under a lira total without every row asking the server what it is.
    reportingCurrency: reportingCurrency(),
    rows: rows.map((r) => orderSummary(r, supplyPreview.get(r.receipt_id), ledgerSummaries.get(r.receipt_id), orderCosts.get(r.receipt_id))),
  };
}

/**
 * Per-order preview of the supply chain side of an order, for the list: which
 * item to show (and edit) a supply link and a warehouse photo against, plus
 * how many of the order's items actually have one so a multi-item order does
 * not silently claim coverage it does not have.
 *
 * The item shown is the first one (by transaction id) that actually has a
 * link/photo, so the preview never shows a value that came from some other
 * item than the one the inline editor then targets. When nothing is set yet,
 * the very first item of the order is the edit target, so "add" always has
 * somewhere to go.
 */
function loadSupplyPreview(db, shopId, receiptIds) {
  const map = new Map();
  if (!receiptIds.length) return map;
  const holes = receiptIds.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT x.receipt_id, x.transaction_id, x.sku, x.warehouse_photo_id, x.image_url,
           x.listing_id, x.product_id, x.variations, m.variant_image_url,
           COALESCE(NULLIF(m.variant_supply_link,''), NULLIF(m.supply_link,'')) AS supply_link
    FROM receipt_transactions x
    LEFT JOIN sku_meta m ON m.sku = x.sku AND m.shop_id IS ? AND x.sku <> ''
    WHERE x.receipt_id IN (${holes})
    ORDER BY x.transaction_id`).all(shopId, ...receiptIds);

  for (const it of items) {
    if (!map.has(it.receipt_id)) map.set(it.receipt_id, { firstItem: it, linkItem: null, linkCount: 0, photoItem: null, photoCount: 0 });
    const entry = map.get(it.receipt_id);
    if (it.supply_link) { entry.linkCount += 1; if (!entry.linkItem) entry.linkItem = it; }
    if (it.warehouse_photo_id) { entry.photoCount += 1; if (!entry.photoItem) entry.photoItem = it; }
  }
  return map;
}

function orderSummary(r, preview, ledger, costs) {
  const linkItem = preview?.linkItem ?? preview?.firstItem ?? null;
  const photoItem = preview?.photoItem ?? preview?.firstItem ?? null;
  return {
    receiptId: r.receipt_id,
    name: r.name,
    buyerEmail: r.buyer_email,
    country: r.country_iso,
    city: r.city,
    status: r.status,
    itemCount: r.item_count,
    // The order's real value, untouched - Excel, Airtable and Analytics all
    // read this one, so a cancel or refund never quietly changes what they
    // report. `displayTotal`/`refundedAmount` below are for the list and
    // detail screens only, to show what a cancel or refund actually leaves.
    total: asMoney(r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency),
    isPaid: !!r.was_paid,
    isShipped: !!r.was_shipped,
    isDelivered: !!r.was_delivered,
    isCanceled: !!r.was_canceled,
    // Etsy's own cancel is above and is always true to what Etsy reports.
    // This one is ours: set by the "Cancel" button in this app, and the only
    // kind Etsy has no API to let a seller trigger.
    isLocallyCanceled: !!r.locally_canceled,
    canceledAt: r.canceled_at ?? null,
    // What Etsy actually refunded on this order (already synced onto the
    // receipt), and what is left once a cancel or a refund is accounted for -
    // a cancelled order shows as 0 outright; a merely-refunded one shows the
    // remainder, with the refunded amount called out separately.
    refundedAmount: r.refunded_amount
      ? asMoney(r.refunded_amount, r.grandtotal_divisor, r.grandtotal_currency) : null,
    displayTotal: (r.was_canceled || r.locally_canceled)
      ? { value: 0, currency: r.grandtotal_currency }
      : r.refunded_amount
        ? { value: Math.max(0, (r.grandtotal_amount - r.refunded_amount) / (r.grandtotal_divisor || 100)), currency: r.grandtotal_currency }
        : asMoney(r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency),
    // What Etsy's own ledger says actually landed after every fee, tax
    // pass-through and ad charge it booked against this order - null until
    // "Sync ledger" has run at least once for this order's date range.
    ledgerNet: ledger ? { value: ledger.netAmount, currency: ledger.currency } : null,
    ledgerLineCount: ledger?.lineCount ?? 0,
    // A cost typed in by hand - Etsy Ads/Offsite Ads spend the ledger never
    // ties to one order. Kept apart from ledgerNet (which is Etsy's own
    // numbers, untouched); `netAfterManualCost` is the two combined, shown
    // only once there is a ledger net to combine it with.
    manualCost: r.manual_cost != null
      ? { value: r.manual_cost, currency: r.grandtotal_currency, note: r.manual_cost_note || '' }
      : null,
    netAfterManualCost: (ledger && r.manual_cost != null)
      ? { value: ledger.netAmount - r.manual_cost, currency: ledger.currency }
      : null,
    // The full picture: what shipping and the goods themselves actually cost
    // (real figures typed in on the Tracking page when there are any, else a
    // clearly-flagged per-SKU estimate), and what is left of the ledger net
    // once those and the manual cost above all come off.
    costBreakdown: orderCostBreakdown(r, ledger, costs),
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
    supplyTrackingNumber: r.supply_tracking_number || '',
    notes: r.notes || '',
    // The same item's own listing photo and (when one is saved) its
    // variant-specific photo, so the list can show them right next to the
    // warehouse photo above - a mix-up between two similar products is
    // meant to be caught by eye (or the AI compare button) without opening
    // the order first.
    //
    // Etsy's receipt/transaction sync leaves image_url blank on plenty of
    // orders even though the listing itself already has synced photos, so
    // this falls through to the same resolver Airtable's image columns use
    // (listing photo, then variant photo when this line's variation has
    // one) before finally giving up.
    imageUrl: resolveForTransaction(photoItem)?.best?.url || photoItem?.image_url || null,
    variantImageUrl: photoItem?.variant_image_url || null,
    // Preview of what the Items tab holds, so the list does not need opening
    // just to see - or change - whether the supply chain side of an order is
    // covered. Each carries the item (transaction id + sku) the value belongs
    // to, so an inline edit on the list writes to exactly the item shown.
    supplyLink: linkItem?.supply_link || null,
    supplyLinkTransactionId: linkItem?.transaction_id ?? null,
    supplyLinkSku: linkItem?.sku || null,
    itemsWithSupplyLink: preview?.linkCount || 0,
    warehousePhotoUrl: photoItem?.warehouse_photo_id ? `/api/ai/attachments/${photoItem.warehouse_photo_id}` : null,
    warehousePhotoTransactionId: photoItem?.transaction_id ?? null,
    itemsWithPhoto: preview?.photoCount || 0,
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
    airtablePushedAt: r.airtable_pushed_at || null,
  };
}

export function getOrder(receiptId) {
  const db = getDb();
  const r = db.prepare(`
    SELECT r.*, COALESCE(f.is_done,0) AS is_done, f.done_at, COALESCE(f.is_seen,0) AS is_seen,
           COALESCE(f.is_flagged,0) AS is_flagged, COALESCE(f.supplier_ordered,0) AS supplier_ordered,
           f.supplier_order_ref, f.supply_tracking_number, f.notes, 0 AS item_count,
           COALESCE(f.problem_state,'none') AS problem_state, f.problem_note,
           COALESCE(f.offsite_ads,0) AS offsite_ads,
           COALESCE(f.is_canceled,0) AS locally_canceled, f.canceled_at,
           f.manual_cost, f.manual_cost_note,
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
    SELECT x.*, m.supply_link, m.variant_supply_link, m.supplier_name,
           m.supply_cost, m.supply_currency, m.variant_image_url, m.lead_time_days
    FROM receipt_transactions x LEFT JOIN sku_meta m ON m.sku = x.sku AND x.sku <> ''
    WHERE x.receipt_id = ? ORDER BY x.transaction_id`).all(receiptId);

  const shipments = db.prepare(`
    SELECT s.*, t.status, t.status_detail, t.last_event_at, t.last_event_text, t.days_since_move,
           t.is_stale, t.alert_reason, t.event_count,
           t.shipping_cost, t.shipping_cost_currency, t.supply_cost, t.supply_cost_currency
    FROM shipments s LEFT JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS s.shop_id
    WHERE s.receipt_id = ? ORDER BY s.id DESC`).all(receiptId);

  const ledger = ledgerForReceipt(receiptId);
  const costs = loadOrderCosts(db, activeShopId(), [receiptId]).get(receiptId);
  return {
    ...orderSummary({ ...r, item_count: items.length }, null,
      ledger ? { netAmount: ledger.netAmount, currency: ledger.currency, lineCount: ledger.lines.length } : null, costs),
    ledgerLines: ledger?.lines ?? [],
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
      // What the order came to before any discount came off, which is the
      // figure the listing prices add up to and the one worth seeing next to
      // what was actually paid.
      beforeDiscount: r.discount_amount
        ? asMoney((r.grandtotal_amount ?? 0) + (r.discount_amount ?? 0),
          r.grandtotal_divisor, r.grandtotal_currency)
        : null,
    },
    shipWindow: shipWindow(r.created_ts),
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
      // Same resolver as the list view: fall through to the listing's own
      // synced photos when Etsy left this transaction's own image_url blank.
      imageUrl: resolveForTransaction(i)?.best?.url || i.image_url || null,
      isDigital: !!i.is_digital,
      // The supply record follows the product everywhere it appears, so the
      // order desk can reorder from the same links the SKU page holds.
      supplyLink: i.supply_link || '',
      variantSupplyLink: i.variant_supply_link || '',
      supplierName: i.supplier_name || '',
      supplyCost: i.supply_cost ?? null,
      supplyCurrency: i.supply_currency || null,
      leadTimeDays: i.lead_time_days ?? null,
      // Honest, not a copy of the main photo: blank when this variant has no
      // photo of its own, same principle as the SKU page.
      variantImageUrl: i.variant_image_url || null,
      // A photo taken at the warehouse, held next to this same item's own
      // picture so a mix-up between two similar products is caught before
      // the parcel ships - compared by eye, or by the AI check below.
      warehousePhotoId: i.warehouse_photo_id || null,
      warehousePhotoUrl: i.warehouse_photo_id ? `/api/ai/attachments/${i.warehouse_photo_id}` : null,
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
      // What this parcel cost to send, and what the goods in it cost - typed
      // in on the Tracking page, next to this same tracking number.
      shippingCost: s.shipping_cost ?? null,
      shippingCostCurrency: s.shipping_cost_currency ?? null,
      supplyCost: s.supply_cost ?? null,
      supplyCostCurrency: s.supply_cost_currency ?? null,
    })),
    raw: parse(r.raw, null),
  };
}

// ------------------------------------------------------------- tick column

const flagColumns = {
  done: 'is_done', seen: 'is_seen', flagged: 'is_flagged', supplierOrdered: 'supplier_ordered',
  canceled: 'is_canceled',
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
        if (key === 'canceled') db.prepare(`UPDATE order_flags SET canceled_at = ${value ? "datetime('now')" : 'NULL'} WHERE receipt_id = ?`).run(id);
      }
      if (patch.notes !== undefined) db.prepare('UPDATE order_flags SET notes = ? WHERE receipt_id = ?').run(String(patch.notes), id);
      if (patch.supplierOrderRef !== undefined) db.prepare('UPDATE order_flags SET supplier_order_ref = ? WHERE receipt_id = ?').run(String(patch.supplierOrderRef), id);
      if (patch.supplyTrackingNumber !== undefined) db.prepare('UPDATE order_flags SET supply_tracking_number = ? WHERE receipt_id = ?').run(String(patch.supplyTrackingNumber), id);
    }
  })();

  audit('orders.flags', { entity: 'receipt', detail: { ids, patch } });
  return { updated: ids.length, ids };
}

export const markSeen = (receiptIds) => setFlags(receiptIds, { seen: true });

/**
 * The hand-typed cost field: Etsy Ads/Offsite Ads spend, or anything else the
 * ledger sync does not tie to this specific order. `amount: null` clears it.
 */
export function setManualCost(receiptId, { amount, note } = {}) {
  const db = getDb();
  const owns = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ? AND shop_id IS ?').get(receiptId, activeShopId());
  if (!owns) throw notFound(`Order ${receiptId} is not in the active shop's local mirror.`);
  const value = amount === null || amount === undefined || amount === '' ? null : Number(amount);
  if (value !== null && !Number.isFinite(value)) throw badRequest(`"${amount}" is not a number.`);
  db.prepare('INSERT OR IGNORE INTO order_flags (receipt_id) VALUES (?)').run(receiptId);
  db.prepare(`UPDATE order_flags SET manual_cost = ?, manual_cost_note = ?, updated_at = datetime('now') WHERE receipt_id = ?`)
    .run(value, note !== undefined ? String(note ?? '') : '', receiptId);
  audit('orders.manual_cost', { entity: 'receipt', entityId: receiptId, detail: { amount: value, note } });
  return getOrder(receiptId);
}

/**
 * Attach (or remove, with attachmentId = null) a warehouse photo to one line
 * item. Ownership is checked through the receipt so a transaction id from
 * another shop's order - or one made up - can never be written to.
 */
export function setWarehousePhoto(receiptId, transactionId, attachmentId) {
  const db = getDb();
  const owns = db.prepare(`
    SELECT 1 FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
    WHERE x.transaction_id = ? AND x.receipt_id = ? AND r.shop_id IS ?`)
    .get(transactionId, receiptId, activeShopId());
  if (!owns) throw notFound(`Item ${transactionId} is not on order ${receiptId}.`);
  db.prepare('UPDATE receipt_transactions SET warehouse_photo_id = ? WHERE transaction_id = ?').run(attachmentId, transactionId);
  audit('orders.warehouse_photo', { entity: 'receipt', entityId: receiptId, detail: { transactionId, attachmentId } });
  return { receiptId, transactionId, warehousePhotoId: attachmentId };
}

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
  // Neither kind of cancellation - Etsy's own, or the local one this app's
  // Cancel button sets - belongs in a "still to do" count, since neither is
  // going to be fulfilled.
  const notCanceled = 'COALESCE(r.was_canceled,0) = 0 AND COALESCE(f.is_canceled,0) = 0';
  return {
    total: one('SELECT COUNT(*) AS c FROM receipts WHERE shop_id IS ?'),
    newOrders: one(`SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
                    WHERE r.shop_id IS ? AND COALESCE(f.is_seen,0) = 0 AND ${notCanceled}`),
    notDone: one(`SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
                  WHERE r.shop_id IS ? AND COALESCE(f.is_done,0) = 0 AND ${notCanceled}`),
    done: one(`SELECT COUNT(*) AS c FROM order_flags f JOIN receipts r ON r.receipt_id = f.receipt_id
               WHERE r.shop_id IS ? AND f.is_done = 1`),
    unshipped: one(`SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
                    WHERE r.shop_id IS ? AND COALESCE(r.was_shipped,0) = 0 AND ${notCanceled}`),
    noTracking: one(`SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
                     WHERE r.shop_id IS ? AND ${notCanceled}
                     AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.receipt_id = r.receipt_id)`),
    alerts: one(`SELECT COUNT(*) AS c FROM tracking WHERE shop_id IS ?
                 AND (is_stale = 1 OR status IN ('exception','not_found','returned')) AND alert_ack = 0`),
  };
}

// ------------------------------------------------------------------- ledger

/**
 * What Etsy's own ledger says this order actually nets, and the individual
 * fee/tax/ad lines that make it up - in Etsy's own words, not re-derived.
 * Matched by reference_id against either the receipt itself or one of its
 * transactions, since a per-item fee (Etsy's "6.5% of item total" lines)
 * references the transaction/listing it was charged against rather than the
 * receipt as a whole.
 *
 * Returns null when nothing has synced yet for this order - "Sync ledger"
 * needs pressing at least once, or this order is older than the sync window.
 */
export function ledgerForReceipt(receiptId) {
  const db = getDb();
  const shopId = activeShopId();
  const txnIds = db.prepare('SELECT transaction_id FROM receipt_transactions WHERE receipt_id = ?')
    .all(receiptId).map((r) => String(r.transaction_id));
  const refs = [String(receiptId), ...txnIds];
  const holes = refs.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT entry_id, amount, currency, description, ledger_type, reference_type, reference_id, parent_entry_id, create_date
    FROM etsy_ledger_entries WHERE shop_id IS ? AND reference_id IN (${holes})
    ORDER BY create_date, entry_id`).all(shopId, ...refs);
  if (!rows.length) return null;

  const currency = rows[0].currency;
  return {
    // The actual money left once every fee, tax pass-through and ad charge
    // synced for this order is accounted for - summing every line nets to
    // exactly what landed, with no need to know which lines mean what.
    netAmount: rows.reduce((sum, r) => sum + (r.amount || 0), 0) / 100,
    currency,
    lines: rows.map((r) => ({
      entryId: r.entry_id,
      amount: (r.amount || 0) / 100,
      currency: r.currency,
      description: r.description,
      ledgerType: r.ledger_type,
      // A readable version of Etsy's own type string ("vat_seller_services" ->
      // "VAT seller services"), never a re-guessed meaning - just formatting.
      label: prettyLedgerLabel(r.ledger_type, r.description),
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      // Links e.g. a VAT-on-fee line back to the fee it taxed, so the
      // detail view can nest it under that line instead of listing it flat -
      // present only on shops Etsy actually charges VAT on.
      parentEntryId: r.parent_entry_id,
      createdTs: r.create_date,
    })),
  };
}

/**
 * Etsy's own ledger_type/description strings formatted for reading
 * ("vat_seller_services" -> "VAT seller services", "transaction_fee" ->
 * "Transaction fee") - a plain format pass, never a re-guessed label, so a
 * type this hasn't seen before still reads as words instead of raw snake_case.
 */
function prettyLedgerLabel(ledgerType, description) {
  const raw = (ledgerType || description || '').trim();
  if (!raw) return 'Other';
  const words = raw.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  const pretty = words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
  return pretty.replace(/\bvat\b/i, 'VAT');
}

/** Same thing, batched for the list - one query instead of one per row. */
function loadLedgerSummaries(db, shopId, receiptIds) {
  const map = new Map();
  if (!receiptIds.length) return map;
  const txnRows = db.prepare(`
    SELECT receipt_id, transaction_id FROM receipt_transactions WHERE receipt_id IN (${receiptIds.map(() => '?').join(',')})`)
    .all(...receiptIds);
  const refToReceipt = new Map(receiptIds.map((id) => [String(id), id]));
  for (const t of txnRows) refToReceipt.set(String(t.transaction_id), t.receipt_id);
  if (!refToReceipt.size) return map;

  const refs = [...refToReceipt.keys()];
  const rows = db.prepare(`
    SELECT amount, currency, reference_id FROM etsy_ledger_entries
    WHERE shop_id IS ? AND reference_id IN (${refs.map(() => '?').join(',')})`).all(shopId, ...refs);

  for (const r of rows) {
    const receiptId = refToReceipt.get(r.reference_id);
    if (receiptId == null) continue;
    if (!map.has(receiptId)) map.set(receiptId, { netAmount: 0, currency: r.currency, lineCount: 0 });
    const entry = map.get(receiptId);
    entry.netAmount += (r.amount || 0) / 100;
    entry.lineCount += 1;
  }
  return map;
}

/**
 * What this order actually cost to fulfil: shipping and the goods themselves.
 * Shipping and a REAL (invoiced) supply cost come from the shipment(s) this
 * order's tracking numbers carry - typed in on the Tracking page, next to the
 * tracking number, the same tracking table it already writes to. With no real
 * figure typed in yet, this falls back to the per-SKU estimate (sku_meta.supply_cost),
 * clearly marked so an estimate is never shown as if it were the real figure.
 */
function loadOrderCosts(db, shopId, receiptIds) {
  const map = new Map();
  if (!receiptIds.length) return map;
  const holes = receiptIds.map(() => '?').join(',');

  const shipRows = db.prepare(`
    SELECT s.receipt_id, t.shipping_cost, t.shipping_cost_currency, t.supply_cost, t.supply_cost_currency
    FROM shipments s JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS s.shop_id
    WHERE s.receipt_id IN (${holes})`).all(...receiptIds);
  for (const r of shipRows) {
    const e = map.get(r.receipt_id) ?? { shipping: null, shippingCcy: null, supply: null, supplyCcy: null, supplyIsEstimate: false };
    if (r.shipping_cost != null) { e.shipping = (e.shipping ?? 0) + r.shipping_cost; e.shippingCcy = r.shipping_cost_currency || e.shippingCcy; }
    if (r.supply_cost != null) { e.supply = (e.supply ?? 0) + r.supply_cost; e.supplyCcy = r.supply_cost_currency || e.supplyCcy; }
    map.set(r.receipt_id, e);
  }

  const needEstimate = receiptIds.filter((id) => map.get(id)?.supply == null);
  if (needEstimate.length) {
    const estHoles = needEstimate.map(() => '?').join(',');
    const items = db.prepare(`
      SELECT x.receipt_id, x.quantity, m.supply_cost, m.supply_currency
      FROM receipt_transactions x
      LEFT JOIN sku_meta m ON m.sku = x.sku AND m.shop_id IS ? AND x.sku <> ''
      WHERE x.receipt_id IN (${estHoles}) AND m.supply_cost IS NOT NULL`).all(shopId, ...needEstimate);
    for (const it of items) {
      const e = map.get(it.receipt_id) ?? { shipping: null, shippingCcy: null, supply: null, supplyCcy: null, supplyIsEstimate: false };
      e.supply = (e.supply ?? 0) + (it.supply_cost || 0) * (it.quantity || 1);
      e.supplyCcy = e.supplyCcy || it.supply_currency;
      e.supplyIsEstimate = true;
      map.set(it.receipt_id, e);
    }
  }
  return map;
}

/**
 * Shipping + supply cost, converted into the order's own currency, plus the
 * profit left once they and any manual cost come off the ledger net. Null
 * fields (rather than a wrong number) whenever a currency has no FX rate to
 * convert with - same rule reporting.js and analytics.js already follow.
 */
function orderCostBreakdown(r, ledger, costs) {
  if (!costs) return { shipping: null, supply: null, profit: null };
  const shipping = costs.shipping != null ? convert(costs.shipping, costs.shippingCcy, r.grandtotal_currency, r.created_ts) : null;
  const supply = costs.supply != null ? convert(costs.supply, costs.supplyCcy, r.grandtotal_currency, r.created_ts) : null;
  const shippingFailed = costs.shipping != null && shipping == null;
  const supplyFailed = costs.supply != null && supply == null;

  let profit = null;
  if (ledger && !shippingFailed && !supplyFailed) {
    profit = { value: round2(ledger.netAmount - (shipping || 0) - (supply || 0) - (r.manual_cost || 0)), currency: ledger.currency };
  }
  return {
    shipping: shipping != null ? { value: round2(shipping), currency: r.grandtotal_currency } : null,
    supply: supply != null ? { value: round2(supply), currency: r.grandtotal_currency, isEstimate: !!costs.supplyIsEstimate } : null,
    profit,
  };
}

/**
 * Shop-level ledger items no single order owns: a standalone Etsy Ads bill,
 * a listing's auto-renew fee, and the like. Grouped by Etsy's own
 * description/ledger_type so nothing here is re-categorised or guessed.
 */
export function shopLedgerSummary({ sinceDays = 30 } = {}) {
  const db = getDb();
  const shopId = activeShopId();
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86_400;
  const receiptIds = db.prepare('SELECT receipt_id FROM receipts WHERE shop_id IS ?').all(shopId).map((r) => String(r.receipt_id));
  const txnIds = db.prepare(`
    SELECT transaction_id FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
    WHERE r.shop_id IS ?`).all(shopId).map((r) => String(r.transaction_id));
  const orderRefs = new Set([...receiptIds, ...txnIds]);

  const rows = db.prepare(`
    SELECT amount, currency, description, ledger_type, reference_id, create_date
    FROM etsy_ledger_entries WHERE shop_id IS ? AND create_date >= ?`).all(shopId, since);

  const shopLevel = rows.filter((r) => !orderRefs.has(r.reference_id));
  const groups = new Map();
  for (const r of shopLevel) {
    const label = r.ledger_type || r.description || 'Other';
    if (!groups.has(label)) groups.set(label, { label, total: 0, count: 0, currency: r.currency });
    const g = groups.get(label);
    g.total += (r.amount || 0) / 100;
    g.count += 1;
  }
  return {
    sinceDays,
    total: shopLevel.reduce((sum, r) => sum + (r.amount || 0), 0) / 100,
    currency: rows[0]?.currency ?? null,
    groups: [...groups.values()].sort((a, b) => a.total - b.total),
  };
}

/**
 * Listings this shop's orders actually reference that have zero photos
 * synced yet - the genuine residual case the image resolver above cannot
 * help with. Feeds the same 'listing.refresh_images' bulk job the Listings
 * page already uses for its "Fetch missing images" button.
 */
export function listingIdsMissingImages() {
  const db = getDb();
  const shopId = activeShopId();
  return db.prepare(`
    SELECT DISTINCT x.listing_id
    FROM receipt_transactions x
    JOIN receipts r ON r.receipt_id = x.receipt_id
    WHERE r.shop_id IS ? AND x.listing_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM listing_images li WHERE li.listing_id = x.listing_id)
  `).all(shopId).map((row) => row.listing_id);
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
