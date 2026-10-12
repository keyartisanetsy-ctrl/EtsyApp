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
import { readSetting } from './settings.js';

const log = createLogger('airtable-shipped');

// never "Çin paket kodu" / "Çin Takip No": those belong to the Chinese carrier
const TRACKING_NAMES = ['takip no', 'manuel shipping', 'tracking number', 'tracking no', 'yunexpress takip no', 'yunexpress', 'tracking code',
  'yuntu track l', 'last mile track', 'last mile track (from yunexpress 2)', 'yuntu track l copy'];
// a ticked box that says the order is done / sent
const DONE_NAMES = ['işlemler bitti', 'islemler bitti', 'shipped', 'sent', 'gönderildi', 'gonderildi', 'kargoya verildi', 'kargolandı', 'kargolandi'];
const TEXT_TYPES = new Set(['singleLineText', 'multilineText', 'number', 'multipleLookupValues', 'formula', 'rollup']);
/** A column name without case, accents or the Turkish dotted/dotless i: "İşlemler Bitti" is "islemler bitti". */
const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ç/g, 'c').trim();
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
    byName = table.fields.filter((f) => TEXT_TYPES.has(f.type) && TRACKING_NAMES.map(norm).includes(norm(f.name))).map((f) => f.name);
  } catch (err) { log.warn(`could not read the columns of ${dest.label}: ${err.message}`); }
  return [...new Set([...mapped, ...byName])];
}

async function doneColumns(dest) {
  try {
    const table = await at.getTable(dest.baseId, dest.tableId);
    return table.fields.filter((f) => f.type === 'checkbox' && DONE_NAMES.map(norm).includes(norm(f.name))).map((f) => f.name);
  } catch { return []; }
}


// ------------------------------------------------------------------ the "not sent" view

const viewsSetting = (key) => { try { return JSON.parse(readSetting(key) || '{}') || {}; } catch { return {}; } };

/** Record ids of one Airtable view (null when it could not be read in full, or is empty - then nothing is concluded from it). */
async function viewRecordIds(dest, viewId) {
  const table = await at.getTable(dest.baseId, dest.tableId);
  const primary = table.fields.find((f) => f.id === table.primaryFieldId)?.name;
  const recs = await at.listRecords(dest.baseId, dest.tableId, { view: viewId, fields: primary ? [primary] : undefined, max: 20000 });
  if (!recs.length) return null;
  return new Set(recs.map((r) => r.id));
}

/**
 * An order is "not sent" when one of its Airtable rows is in the not-sent view. When the order has rows and none of them is
 * in that view (and they still exist), it was sent: marked here so the queue leaves it out. An order that comes back into
 * the view is put back. Returns the orders newly marked.
 */
async function syncFromViews(orders, found) {
  const db = getDb();
  const views = viewsSetting('airtable.unshipped_views');
  const recent = viewsSetting('airtable.recent_views');
  const marked = db.prepare("SELECT channel, order_id FROM order_sent_marks WHERE source = 'airtable view'").all();
  for (const dest of listAllDestinations()) {
    const viewId = views[`${dest.baseId}/${dest.tableId}`];
    if (!viewId) continue;
    let inView;
    try { inView = await viewRecordIds(dest, viewId); } catch (err) { log.warn(`could not read the not-sent view of ${dest.label}: ${err.message}`); continue; }
    if (!inView) continue;
    // every order of the last month: only rows that are in it can be called sent (an old or removed row says nothing)
    let inRecent = null;
    if (recent[`${dest.baseId}/${dest.tableId}`]) {
      try { inRecent = await viewRecordIds(dest, recent[`${dest.baseId}/${dest.tableId}`]); } catch (err) { log.warn(`could not read the last-month view of ${dest.label}: ${err.message}`); continue; }
      if (!inRecent) continue;
    }

    const rowsOf = (channel, orderId) => db.prepare('SELECT record_id FROM airtable_links WHERE destination_id = ? AND CAST(receipt_id AS TEXT) = ?')
      .all(dest.id, String(orderId)).map((r) => r.record_id.replace(/[^A-Za-z0-9]/g, ''));

    // back into the view: no longer sent
    for (const m of marked.filter((x) => x.channel === dest.channel)) {
      if (rowsOf(m.channel, m.order_id).some((id) => inView.has(id))) db.prepare('DELETE FROM order_sent_marks WHERE channel = ? AND order_id = ?').run(m.channel, m.order_id);
    }

    const mine = orders.filter((o) => o.channel === dest.channel && (dest.shopId == null || String(dest.shopId) === String(o.shopId)));
    const candidates = mine.map((o) => ({ o, ids: rowsOf(o.channel, o.orderId) })).filter((c) => c.ids.length && !c.ids.some((id) => inView.has(id)));
    if (!candidates.length) continue;
    let alive = null;
    if (!inRecent) try {
      const table = await at.getTable(dest.baseId, dest.tableId);
      alive = await at.existingRecordIds(dest.baseId, dest.tableId, candidates.flatMap((c) => c.ids), { primaryField: table.primaryFieldId });
    } catch (err) { log.warn(`could not check the rows of ${dest.label}: ${err.message}`); continue; }
    for (const c of candidates) {
      // every row still exists and none is in the not-sent view: sent
      if (!c.ids.every((id) => (inRecent ? inRecent.has(id) : alive.has(id)))) continue;
      const key = `${c.o.channel}:${c.o.orderId}`;
      if (!found.has(key)) found.set(key, { channel: c.o.channel, orderId: c.o.orderId, ref: c.o.ref, buyer: c.o.buyer, tracking: '', destination: dest.label, viaView: true });
    }
  }
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
    // eslint-disable-next-line no-await-in-loop
    const done = await doneColumns(dest);
    if (!columns.length && !done.length) continue;

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
          fields: [...columns, ...done], filterByFormula: `OR(${part.map((id) => `RECORD_ID()='${id}'`).join(',')})`, max: part.length + 10,
        });
        for (const rec of recs) {
          const o = recordsOf.get(rec.id);
          if (!o) continue;
          const tracking = columns.map((c) => trackingFromCell(rec.fields?.[c])).find(Boolean);
          const key = `${o.channel}:${o.orderId}`;
          if (tracking && !found.has(key)) {
            found.set(key, { channel: o.channel, orderId: o.orderId, ref: o.ref, buyer: o.buyer, tracking, destination: dest.label });
          } else if (!tracking && !found.has(key) && done.some((c) => rec.fields?.[c] === true)) {
            found.set(key, { channel: o.channel, orderId: o.orderId, ref: o.ref, buyer: o.buyer, tracking: '', destination: dest.label });
          }
        }
      }
    } catch (err) { log.warn(`could not read the tracking cells of ${dest.label}: ${err.message}`); }
  }

  await syncFromViews(orders, found);

  const done = [];
  for (const f of found.values()) {
    try {
      if (f.viaView && !f.tracking) {
        db.prepare("INSERT OR REPLACE INTO order_sent_marks (channel, order_id, source) VALUES (?,?,'airtable view')").run(f.channel, String(f.orderId));
      } else if (f.tracking) {
        // eslint-disable-next-line no-await-in-loop
        await inOrderShop(f.channel, f.orderId, () => recordTracking(f.channel, f.orderId, f.tracking));
      } else {
        db.prepare("INSERT OR REPLACE INTO order_sent_marks (channel, order_id, source) VALUES (?,?,'airtable done box')").run(f.channel, String(f.orderId));
      }
      audit('airtable.shipped', { entity: f.channel, entityId: String(f.orderId), detail: { tracking: f.tracking, destination: f.destination } });
      done.push(f);
    } catch (err) { log.warn(`could not keep the tracking number of ${f.ref}: ${err.message}`); }
  }
  return { found: done, checked };
}
