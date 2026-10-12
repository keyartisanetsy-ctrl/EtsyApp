/**
 * Orders that were already sent, according to Airtable.
 *
 * Orders are often shipped outside the app: the tracking number is typed straight into the order's Airtable row. Such an
 * order must not sit in the packing queue as "Waiting". For every order of the queue that has an Airtable row, the
 * tracking-number cell of that row is read (the column mapped to the tracking number, or one named like it - Takip No,
 * Manuel Shipping, ...); when it holds a real number the order is marked shipped here: the number is kept on the order,
 * exactly as a hand-over keeps it - nothing is sent to Etsy or Shopify, the buyer is told nothing - and it leaves the queue.
 *
 * An order that has no Airtable row, or whose tracking cell is empty, is left alone. Reading Airtable costs nothing.
 */
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import * as at from '../airtable/client.js';
import { listAllDestinations } from './airtable.js';
import { packingQueue } from './packing.js';
import { recordTracking } from './orderdispatch.js';
import { inOrderShop } from '../lib/ordershop.js';

const log = createLogger('airtable-shipped');

// never "Çin paket kodu" / "Çin Takip No": those belong to the Chinese carrier
const TRACKING_NAMES = ['takip no', 'manuel shipping', 'tracking number', 'tracking no', 'yunexpress takip no', 'yunexpress', 'tracking code'];
const TEXT_TYPES = new Set(['singleLineText', 'multilineText', 'number']);
const REAL_TRACKING = /^[A-Z0-9][A-Z0-9-]{7,39}$/;

/** The tracking number a cell holds, or '' when it holds none (blank, "-", a word, a Chinese-carrier number is not asked for). */
export function trackingFromCell(cell) {
  const text = Array.isArray(cell) ? cell.map((c) => c?.name ?? c).join(' ') : String(cell ?? '');
  for (const part of text.split(/[\s,;，；]+/)) {
    const t = part.trim().toUpperCase();
    if (REAL_TRACKING.test(t) && /\d{4,}/.test(t)) return t;
  }
  return '';
}

async function trackingColumns(dest) {
  const mapped = (dest.fieldMap ?? []).filter((e) => e.source === 'tracking.code').map((e) => e.target);
  let byName = [];
  try {
    const table = await at.getTable(dest.baseId, dest.tableId);
    byName = table.fields.filter((f) => TEXT_TYPES.has(f.type) && TRACKING_NAMES.includes(f.name.trim().toLowerCase())).map((f) => f.name);
  } catch (err) { log.warn(`could not read the columns of ${dest.label}: ${err.message}`); }
  return [...new Set([...mapped, ...byName])];
}

/**
 * Look at the queue's orders in Airtable and take the ones with a tracking number off it.
 * Returns what was found: [{ channel, orderId, ref, buyer, tracking, destination }].
 */
export async function syncShippedFromAirtable({ channels, from, to } = {}) {
  const db = getDb();
  const queue = packingQueue({ channels, from, to });
  const orders = queue.orders.filter((o) => o.status !== 'packed');
  if (!orders.length) return { found: [], checked: 0 };

  const found = new Map();
  let checked = 0;
  for (const dest of listAllDestinations().filter((d) => d.rowMode === 'item' || d.rowMode === 'order')) {
    const mine = orders.filter((o) => o.channel === dest.channel && (dest.shopId == null || String(dest.shopId) === String(o.shopId)));
    if (!mine.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const columns = await trackingColumns(dest);
    if (!columns.length) continue;

    const recordsOf = new Map();                       // record id -> order
    for (const o of mine) {
      const rows = db.prepare('SELECT record_id FROM airtable_links WHERE destination_id = ? AND CAST(receipt_id AS TEXT) = ?').all(dest.id, String(o.orderId));
      for (const r of rows) recordsOf.set(r.record_id.replace(/[^A-Za-z0-9]/g, ''), o);
    }
    if (!recordsOf.size) continue;
    checked += recordsOf.size;

    const ids = [...recordsOf.keys()];
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const part = ids.slice(i, i + 40);
        // eslint-disable-next-line no-await-in-loop
        const recs = await at.listRecords(dest.baseId, dest.tableId, {
          fields: columns, filterByFormula: `OR(${part.map((id) => `RECORD_ID()='${id}'`).join(',')})`, max: part.length + 10,
        });
        for (const rec of recs) {
          const o = recordsOf.get(rec.id);
          if (!o) continue;
          const tracking = columns.map((c) => trackingFromCell(rec.fields?.[c])).find(Boolean);
          if (tracking && !found.has(`${o.channel}:${o.orderId}`)) {
            found.set(`${o.channel}:${o.orderId}`, { channel: o.channel, orderId: o.orderId, ref: o.ref, buyer: o.buyer, tracking, destination: dest.label });
          }
        }
      }
    } catch (err) { log.warn(`could not read the tracking cells of ${dest.label}: ${err.message}`); }
  }

  const done = [];
  for (const f of found.values()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await inOrderShop(f.channel, f.orderId, () => recordTracking(f.channel, f.orderId, f.tracking));
      audit('airtable.shipped', { entity: f.channel, entityId: String(f.orderId), detail: { tracking: f.tracking, destination: f.destination } });
      done.push(f);
    } catch (err) { log.warn(`could not keep the tracking number of ${f.ref}: ${err.message}`); }
  }
  return { found: done, checked };
}
