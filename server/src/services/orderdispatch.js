/**
 * Handing an order over by hand: giving a waiting order its package code and its YunExpress tracking number.
 *
 * Some orders never come through the warehouse photo flow (they are sent another way, or the parcel was matched on
 * paper). Typing the two things here takes the order off the packing queue ("Waiting") and writes the code and the
 * tracking number into the order's Airtable row. Nothing is sent to Etsy or Shopify: no fulfilment, no e-mail to the
 * buyer - the tracking number is kept here (and can be pushed later from the Orders page, if you want it there).
 */
import { getDb, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { inOrderShop, shopOfOrder } from '../lib/ordershop.js';
import { ensureOrderCode, setOrderCode, codeFor, shopifyCodeFor } from './ordercode.js';
import { addTracking } from './tracking/index.js';
import { reflectHandoff } from './ordersupply.js';

const log = createLogger('dispatch');

const DEFAULT_CARRIER = 'YunExpress';
const cleanTracking = (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase();

/** What an order was handed over with, if anything: { code, trackingNumber, carrier, pushed }. */
export function describe(channel, orderId) {
  const db = getDb();
  if (channel === 'etsy') {
    const id = Number(orderId);
    const s = db.prepare(`SELECT tracking_code, carrier_name, pushed_to_etsy FROM shipments WHERE receipt_id = ? AND COALESCE(tracking_code,'') <> '' ORDER BY id DESC LIMIT 1`).get(id);
    return { code: codeFor(id) ?? null, trackingNumber: s?.tracking_code ?? '', carrier: s?.carrier_name ?? '', pushed: !!s?.pushed_to_etsy };
  }
  const f = db.prepare('SELECT tracking_number, tracking_company, pushed_at FROM shopify_fulfillments WHERE order_id = ?').get(String(orderId));
  return { code: shopifyCodeFor(String(orderId)) ?? null, trackingNumber: f?.tracking_number ?? '', carrier: f?.tracking_company ?? '', pushed: !!f?.pushed_at };
}

/**
 * Give the order its package code and tracking number.
 *   code      the package code to use (blank: the order's own, or the next one of the day)
 *   airtable  'check' (write unless a cell holds something else - then report it), 'change', 'keep', 'none'
 */
export async function assign(channel, orderId, { trackingNumber, code, carrier = DEFAULT_CARRIER, airtable = 'check' } = {}) {
  if (channel !== 'etsy' && channel !== 'shopify') throw badRequest('channel must be "etsy" or "shopify".');
  const tracking = cleanTracking(trackingNumber);
  if (!/^[A-Z0-9-]{6,40}$/.test(tracking)) throw badRequest('Type the YunExpress tracking number (letters and digits, like YT2617900709012345).');
  if (shopOfOrder(channel, orderId) == null) throw notFound('That order is not in the app (fetch the orders first).');

  const done = await inOrderShop(channel, orderId, async () => {
    // 1. the package code: the one typed, else the order's own, else the next of the day
    const wanted = String(code ?? '').trim();
    const packageCode = wanted ? setOrderCode(channel, orderId, wanted) : (ensureOrderCode(channel, orderId) ?? null);
    if (!packageCode) throw badRequest('Could not give this order a package code.');

    // 2. the tracking number, kept here only - the buyer is not told and nothing is fulfilled on the shop
    const db = getDb();
    if (channel === 'etsy') {
      const id = Number(orderId);
      // a hand-over typed earlier and never pushed is replaced, not stacked up
      db.prepare("DELETE FROM shipments WHERE receipt_id = ? AND COALESCE(pushed_to_etsy,0) = 0 AND tracking_code <> ?").run(id, tracking);
      const r = await addTracking([{ receiptId: id, trackingCode: tracking, carrierName: carrier }], { pushToEtsy: false });
      if (r.results[0]?.status === 'error') throw badRequest(r.results[0].error);
    } else {
      db.prepare(`INSERT INTO shopify_fulfillments (order_id, tracking_number, tracking_company) VALUES (?,?,?)
                  ON CONFLICT(order_id) DO UPDATE SET tracking_number = excluded.tracking_number, tracking_company = excluded.tracking_company`)
        .run(String(orderId), tracking, carrier || null);
    }
    audit('dispatch.assign', { entity: channel === 'etsy' ? 'receipt' : 'shopify_order', entityId: String(orderId), detail: { code: packageCode, tracking, carrier } });
    return { code: packageCode };
  });

  let air = null;
  if (airtable !== 'none') {
    try { air = await reflectHandoff(channel, orderId, { decision: ['check', 'change', 'keep'].includes(airtable) ? airtable : 'check' }); } catch (err) {
      log.warn(`Airtable hand-over failed: ${err.message}`);
      air = { status: 'error', message: err.message };
    }
  }
  return { channel, orderId: String(orderId), code: done.code, trackingNumber: tracking, carrier, airtable: air };
}

/** Take a hand-over back (the tracking number and a code typed by hand); Airtable cells are not touched. */
export function undo(channel, orderId) {
  const db = getDb();
  if (shopOfOrder(channel, orderId) == null) throw notFound('That order is not in the app.');
  let removed = 0;
  if (channel === 'etsy') {
    removed += db.prepare('DELETE FROM shipments WHERE receipt_id = ? AND COALESCE(pushed_to_etsy,0) = 0').run(Number(orderId)).changes;
    db.prepare("DELETE FROM order_codes WHERE receipt_id = ? AND source = 'manual'").run(Number(orderId));
  } else {
    removed += db.prepare("UPDATE shopify_fulfillments SET tracking_number = NULL, tracking_company = NULL WHERE order_id = ? AND pushed_at IS NULL").run(String(orderId)).changes;
    db.prepare("DELETE FROM shopify_order_codes WHERE order_id = ? AND source = 'manual'").run(String(orderId));
  }
  audit('dispatch.undo', { entity: channel, entityId: String(orderId), detail: { removed } });
  return { channel, orderId: String(orderId), removed };
}
