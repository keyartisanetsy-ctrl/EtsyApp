/**
 * Keeping the packing queue and Airtable in step.
 *
 * Airtable holds two views of the orders table: the orders NOT sent yet, and every order of the last month. An order is
 * recognised in Airtable by its order number (the Etsy order id, the Shopify "#2368") - never by a link this app made,
 * because most rows were created by Airtable itself or by an older import.
 *
 *   in the last-month view and NOT in the not-sent view  -> sent        (leaves the queue; nothing is sent to the shops)
 *   in the not-sent view                                 -> not sent    (is in the queue whatever its date)
 *   has a tracking number in Airtable, or a ticked "done" box -> sent
 *   no Airtable row at all                               -> unknown     (stays, the report says so)
 *
 * compareWithAirtable() lists, table by table, every order the two sides disagree about and why; syncShippedFromAirtable()
 * applies the above. Reading Airtable costs nothing. Nothing is ever sent to Etsy or Shopify from here.
 */
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import * as at from '../airtable/client.js';
import { listAllDestinations } from './airtable.js';
import { packingQueue } from './packing.js';
import { recordTracking } from './orderdispatch.js';
import { inOrderShop } from '../lib/ordershop.js';
import { readSetting } from './settings.js';
import { listShopifyAccounts, withShopifyShop } from '../shopify/client.js';
import { syncOrders as syncShopifyOrders } from '../shopify/sync.js';
import { gql } from '../shopify/client.js';

const log = createLogger('airtable-shipped');

/** A column name without case, accents or the Turkish dotted/dotless i: "İşlemler Bitti" is "islemler bitti". */
const norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ç/g, 'c').trim();
const REAL_TRACKING = /^[A-Z0-9][A-Z0-9-]{7,39}$/;
// never "Çin paket kodu" / "Çin Takip No": those belong to the Chinese carrier
const TRACKING_NAMES = ['takip no', 'manuel shipping', 'tracking number', 'tracking no', 'yunexpress takip no', 'yunexpress', 'tracking code',
  'yuntu track l', 'last mile track', 'last mile track (from yunexpress 2)', 'yuntu track l copy'].map(norm);
const DONE_NAMES = ['islemler bitti', 'shipped', 'sent', 'gonderildi', 'kargoya verildi', 'kargolandi'].map(norm);
const KEY_NAMES = ['order id', 'order number', 'siparis no', 'order no'].map(norm);
const TEXT_TYPES = new Set(['singleLineText', 'multilineText', 'number', 'multipleLookupValues', 'formula', 'rollup']);

/** The tracking number a cell holds, or '' when it holds none (blank, "-", a word). */
export function trackingFromCell(cell) {
  const text = Array.isArray(cell) ? cell.map((c) => c?.name ?? c).join(' ') : String(cell ?? '');
  for (const part of text.split(/[\s,;，；]+/)) {
    const t = part.trim().toUpperCase();
    if (REAL_TRACKING.test(t) && /\d{4,}/.test(t)) return t;
  }
  return '';
}

/** "#2368", ["#2368"], {name:"#2368"}, 4198467930 -> "2368" / "4198467930" */
export function orderKey(cell) {
  const one = Array.isArray(cell) ? cell[0] : cell;
  const text = typeof one === 'object' && one ? (one.name ?? one.value ?? '') : one;
  return String(text ?? '').replace(/[^A-Za-z0-9]/g, '').replace(/^0+(?=\d)/, '');
}

const viewsSetting = (key) => { try { return JSON.parse(readSetting(key) || '{}') || {}; } catch { return {}; } };

/** One Airtable table, once however many destinations write to it. */
function tables() {
  const out = new Map();
  for (const d of listAllDestinations()) {
    const id = `${d.baseId}/${d.tableId}`;
    if (!out.has(id)) out.set(id, { id, baseId: d.baseId, tableId: d.tableId, channel: d.channel, label: d.baseName ? `${d.baseName} / ${d.tableName}` : id, dests: [] });
    out.get(id).dests.push(d);
  }
  return [...out.values()];
}

/**
 * What one Airtable table says about its orders: Map(orderKey -> { rows: [{ id, notSent, tracking, done }] }), or null
 * when its views are not set up or could not be read in full.
 */
async function readTable(t) {
  const notSentView = viewsSetting('airtable.unshipped_views')[t.id];
  const recentView = viewsSetting('airtable.recent_views')[t.id];
  if (!notSentView) return null;
  const meta = await at.getTable(t.baseId, t.tableId);
  const named = (names, types) => meta.fields.filter((f) => names.includes(norm(f.name)) && (!types || types.has(f.type))).map((f) => f.name);
  const mappedKey = t.dests.flatMap((d) => (d.fieldMap ?? []).filter((e) => e.source === 'order.id').map((e) => e.target));
  const keyField = [...mappedKey, ...named(KEY_NAMES)][0];
  if (!keyField) return null;
  const tracking = [...new Set([...t.dests.flatMap((d) => (d.fieldMap ?? []).filter((e) => e.source === 'tracking.code').map((e) => e.target)), ...named(TRACKING_NAMES, TEXT_TYPES)])];
  const done = meta.fields.filter((f) => f.type === 'checkbox' && DONE_NAMES.includes(norm(f.name))).map((f) => f.name);
  const statusField = meta.fields.find((f) => f.type === 'multipleSelects' && norm(f.name) === 'siparis durum')?.name || null;
  const fields = [keyField, ...tracking, ...done, ...(statusField ? [statusField] : [])];

  const notSent = await at.listRecords(t.baseId, t.tableId, { view: notSentView, fields, max: 20000 });
  if (!notSent.length) return null;                       // an empty view concludes nothing
  const recent = recentView ? await at.listRecords(t.baseId, t.tableId, { view: recentView, fields, max: 30000 }) : [];
  if (recentView && !recent.length) return null;

  const notSentIds = new Set(notSent.map((r) => r.id));
  const recentIds = new Set(recent.map((r) => r.id));
  const index = new Map();
  for (const r of new Map([...recent, ...notSent].map((x) => [x.id, x])).values()) {
    const key = orderKey(r.fields?.[keyField]);
    if (!key) continue;
    if (!index.has(key)) index.set(key, { rows: [] });
    index.get(key).rows.push({
      id: r.id, notSent: notSentIds.has(r.id), recent: !recentView || recentIds.has(r.id),
      tracking: tracking.map((c) => trackingFromCell(r.fields?.[c])).find(Boolean) || '',
      done: done.some((c) => r.fields?.[c] === true),
      status: statusField ? (r.fields?.[statusField] ?? []).map((x) => x?.name ?? x) : [],
    });
  }
  return { index, keyField, tracking, done, statusField, notSentCount: notSent.length, recentCount: recent.length };
}


/**
 * The status list of a finished order's row with its "in progress" statuses turned into their OK twins
 * (ORDER CN -> ORDER CN OK on Shopify's table, ORDER CN - OK on Etsy's). null when there is nothing to change.
 */
export function finishedStatus(statuses, channel, state) {
  const etsy = channel === 'etsy';
  const twin = { 'order cn': etsy ? 'ORDER CN - OK' : 'ORDER CN OK', 'in warehouse': etsy ? 'IN WAREHOUSE - OK -' : 'IN WAREHOUSE OK', 'out of stock': etsy ? 'ORDER CN - OK' : 'ORDER CN OK' };
  const list = statuses ?? [];
  if (list.some((x) => /ok\s*-?$/i.test(String(x).trim()))) return null;                 // already finished
  if (list.some((x) => /cancel|iptal|refund/i.test(norm(x)))) return null;                 // already closed another way
  let next = [];
  if (state === 'canceled' || state === 'refunded') next = [...new Set([...list.filter((x) => !twin[String(x).trim().toLowerCase()]), etsy ? 'İPTAL + REFUND' : 'CANCELLED'])];
  else {
    const mapped = list.map((x) => twin[String(x).trim().toLowerCase()] ?? x);
    next = [...new Set(mapped)];
    if (!next.some((x) => /ok\s*-?$/i.test(x))) next.push(etsy ? 'ORDER CN - OK' : 'ORDER CN OK');
  }
  return next.join('|') === list.join('|') ? null : next;
}

const queueKey = (o) => (o.channel === 'etsy' ? orderKey(o.orderId) : orderKey(o.orderName || o.ref));

/** Why the app does not list an order that Airtable says is not sent. */
function appReason(channel, key) {
  const db = getDb();
  if (channel === 'etsy') {
    const r = db.prepare('SELECT receipt_id, created_ts, was_shipped, was_canceled, was_paid, shop_id FROM receipts WHERE receipt_id = ?').get(Number(key));
    if (!r) return { state: 'not_in_app', text: 'This order is not in the app (fetch the Etsy orders).' };
    const t = db.prepare("SELECT tracking_code FROM shipments WHERE receipt_id = ? AND COALESCE(tracking_code,'') <> '' LIMIT 1").get(r.receipt_id);
    if (r.was_canceled) return { state: 'canceled', text: 'Canceled in the app.' };
    if (t) return { state: 'tracking_in_app', text: `The app has tracking ${t.tracking_code} - Airtable does not.`, tracking: t.tracking_code };
    if (r.was_shipped) return { state: 'shipped_on_etsy', text: 'Etsy says it is shipped.' };
    return { state: 'other', text: 'Not paid or digital in the app.' };
  }
  const o = db.prepare("SELECT order_id, cancelled_at, fulfillment_status, financial_status FROM shopify_orders WHERE name = ? OR name = ?").get(`#${key}`, key);
  if (!o) return { state: 'not_in_app', text: 'This order is not in the app (sync the Shopify orders).' };
  const f = db.prepare("SELECT tracking_number FROM shopify_fulfillments WHERE order_id = ?").get(o.order_id);
  if (o.cancelled_at) return { state: 'canceled', text: 'Canceled on Shopify.' };
  if (f?.tracking_number) return { state: 'tracking_in_app', text: `The app has tracking ${f.tracking_number} - Airtable does not.`, tracking: f.tracking_number };
  if (/^(FULFILLED|RESTOCKED)$/i.test(o.fulfillment_status || '')) return { state: 'shipped_on_shop', text: 'Shopify says it is fulfilled.' };
  if (/^(VOIDED|REFUNDED)$/i.test(o.financial_status || '')) return { state: 'refunded', text: 'Refunded / voided on Shopify.' };
  return { state: 'other', text: 'Not in the packing queue for another reason.' };
}

/**
 * The two sides side by side. For each Airtable table: orders Airtable lists as not sent that the queue does not
 * (and why), and queue orders Airtable does not list (and why).
 */
export async function compareWithAirtable({ channels, from, to } = {}) {
  const queue = packingQueue({ channels, from, to });
  const report = [];
  for (const t of tables()) {
    let side;
    try { side = await readTable(t); } catch (err) { report.push({ table: t.label, error: err.message }); continue; }
    if (!side) continue;
    const mine = queue.orders.filter((o) => o.channel === t.channel);
    const inQueue = new Map(mine.map((o) => [queueKey(o), o]));
    const airtableOnly = [];
    const queueOnly = [];
    for (const [key, v] of side.index) {
      if (!v.rows.some((r) => r.notSent) || inQueue.has(key)) continue;
      airtableOnly.push({ key, ...appReason(t.channel, key) });
    }
    for (const [key, o] of inQueue) {
      const v = side.index.get(key);
      if (v?.rows.some((r) => r.notSent)) continue;
      queueOnly.push({ key, ref: o.ref, buyer: o.buyer, orderedAt: o.orderedAt,
        text: !v ? 'No row for this order in the last-month Airtable view (not pushed to Airtable, or older than a month).' : 'In Airtable but not in the not-sent view (it counts as sent there).' });
    }
    report.push({ table: t.label, channel: t.channel, airtableNotSent: side.notSentCount, queue: mine.length, airtableOnly, queueOnly });
  }
  return report;
}

/** The tracking number Shopify holds for a fulfilled order (the first fulfillment that has one), or ''. */
async function shopifyTrackingOf(orderId) {
  try {
    const data = await inOrderShop('shopify', orderId, () => gql(`query T($id: ID!) { order(id: $id) { fulfillments { trackingInfo { number company } } } }`, { id: orderId }));
    for (const f of data?.order?.fulfillments ?? []) {
      for (const t of f.trackingInfo ?? []) { const n = trackingFromCell(t.number); if (n) return n; }
    }
  } catch (err) { log.warn(`could not read Shopify's tracking of ${orderId}: ${err.message}`); }
  return '';
}

/**
 * Shopify orders Airtable lists as not sent that the app has never fetched (older than its order sync reaches): fetched by
 * their number, from every connected store, so the queue can show them. Shopify is not rate-limited the way Etsy is.
 */
async function fetchMissingShopifyOrders(names) {
  if (!names.length) return 0;
  const query = names.map((n) => `name:#${n}`).join(' OR ');
  let got = 0;
  for (const acct of listShopifyAccounts()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await withShopifyShop(acct.id, () => syncShopifyOrders({ pages: 2, query }));
      got += r.orders ?? 0;
    } catch (err) { log.warn(`could not fetch Shopify orders ${names.join(', ')}: ${err.message}`); }
  }
  return got;
}

/**
 * Apply what Airtable says: orders it shows as sent leave the queue; orders it lists as not sent are remembered so the queue
 * shows them whatever their date; a tracking number the app has but Airtable lacks is written into the (empty) cell.
 * Returns { found, checked, unsent, filled }.
 */
export async function syncShippedFromAirtable({ channels, from, to } = {}) {
  const db = getDb();
  const queue = packingQueue({ channels, from, to });
  const orders = queue.orders.filter((o) => o.status !== 'packed');

  const found = new Map();
  let checked = 0;
  const unsent = [];
  const filled = [];
  let fetched = 0;
  const settled = [];

  for (const t of tables()) {
    let side;
    try { side = await readTable(t); } catch (err) { log.warn(`could not read ${t.label}: ${err.message}`); continue; }
    if (!side) continue;
    checked += side.recentCount || side.notSentCount;

    // Shopify orders Airtable lists as not sent that the app does not have yet: fetch them by number
    if (t.channel === 'shopify') {
      const missing = [...side.index].filter(([, v]) => v.rows.some((r) => r.notSent)).map(([k]) => k)
        .filter((k) => /^\d+$/.test(k) && !db.prepare('SELECT 1 FROM shopify_orders WHERE name = ?').get(`#${k}`));
      if (missing.length) fetched += await fetchMissingShopifyOrders(missing);
    }

    // not sent in Airtable -> remembered (shown by the queue whatever the date); back in the view -> no longer sent
    const mark = db.prepare("DELETE FROM order_sent_marks WHERE channel = ? AND order_id = ? AND source = 'airtable view'");
    const keep = new Set();
    for (const [key, v] of side.index) if (v.rows.some((r) => r.notSent)) keep.add(key);
    db.prepare('DELETE FROM airtable_unsent WHERE channel = ?').run(t.channel);
    for (const key of keep) {
      const id = t.channel === 'etsy' ? key : db.prepare('SELECT order_id FROM shopify_orders WHERE name = ?').get(`#${key}`)?.order_id;
      if (!id) continue;
      db.prepare('INSERT OR REPLACE INTO airtable_unsent (channel, order_id) VALUES (?,?)').run(t.channel, String(id));
      mark.run(t.channel, String(id));
      unsent.push({ channel: t.channel, orderId: String(id) });
    }

    for (const o of orders.filter((x) => x.channel === t.channel)) {
      const key = queueKey(o);
      const v = side.index.get(key);
      if (!v) continue;
      const k = `${o.channel}:${o.orderId}`;
      const tracking = v.rows.map((r) => r.tracking).find(Boolean);
      const base = { channel: o.channel, orderId: o.orderId, ref: o.ref, buyer: o.buyer, destination: t.label };
      if (tracking) found.set(k, { ...base, tracking });
      else if (v.rows.some((r) => r.done)) found.set(k, { ...base, tracking: '' });
      else if (!v.rows.some((r) => r.notSent) && v.rows.some((r) => r.recent)) found.set(k, { ...base, tracking: '', viaView: true });
    }

    // the app has a tracking number the Airtable row lacks: fill the empty cell (never overwrite)
    const trackingCol = side.tracking.find((c) => /takip no|manuel shipping|tracking/i.test(c) && !/cin|çin/i.test(c));
    if (trackingCol) {
      const updates = [];
      for (const [key, v] of side.index) {
        const row = v.rows.find((r) => r.notSent && !r.tracking);
        if (!row) continue;
        const why = appReason(t.channel, key);
        if (why.state === 'tracking_in_app') updates.push({ id: row.id, fields: { [trackingCol]: why.tracking }, key, tracking: why.tracking });
        else if (why.state === 'shipped_on_shop' && t.channel === 'shopify') {
          // fulfilled on Shopify: its tracking number goes into the Airtable row, which is what takes it off the not-sent view
          const orderId = db.prepare('SELECT order_id FROM shopify_orders WHERE name = ?').get(`#${key}`)?.order_id;
          // eslint-disable-next-line no-await-in-loop
          const number = orderId ? await shopifyTrackingOf(orderId) : '';
          if (number) updates.push({ id: row.id, fields: { [trackingCol]: number }, key, tracking: number });
        }
      }
      if (updates.length) {
        try {
          await at.updateRecords(t.baseId, t.tableId, updates.map((u) => ({ id: u.id, fields: u.fields })));
          for (const u of updates) filled.push({ table: t.label, key: u.key, tracking: u.tracking });
        } catch (err) { log.warn(`could not write tracking into ${t.label}: ${err.message}`); }
      }
    }

    // The shop already finished these orders (canceled, refunded, fulfilled, or the app holds their tracking) but Airtable still
    // lists them as not sent. That view is driven by the row's "SİPARİŞ DURUM": a status that ends in OK ("ORDER CN OK") is out of
    // it. So the status of such a row is moved to its OK twin - the same step the team takes by hand - and nothing else is touched.
    if (side.statusField) {
      const moves = [];
      for (const [key, v] of side.index) {
        for (const row of v.rows.filter((r) => r.notSent)) {
          const why = appReason(t.channel, key);
          const finished = ['canceled', 'refunded', 'shipped_on_shop', 'shipped_on_etsy', 'tracking_in_app'].includes(why.state);
          if (!finished) continue;
          const next = finishedStatus(row.status, t.channel, why.state);
          if (next) moves.push({ id: row.id, fields: { [side.statusField]: next }, key, from: row.status.join(', '), to: next.join(', '), why: why.text });
        }
      }
      if (moves.length) {
        try {
          await at.updateRecords(t.baseId, t.tableId, moves.map((u) => ({ id: u.id, fields: u.fields })));
          for (const u of moves) settled.push({ table: t.label, key: u.key, from: u.from, to: u.to, why: u.why });
        } catch (err) { log.warn(`could not move the status in ${t.label}: ${err.message}`); }
      }
    }
  }

  const done = [];
  for (const f of found.values()) {
    try {
      if (f.tracking) {
        // eslint-disable-next-line no-await-in-loop
        await inOrderShop(f.channel, f.orderId, () => recordTracking(f.channel, f.orderId, f.tracking));
      } else {
        db.prepare('INSERT OR REPLACE INTO order_sent_marks (channel, order_id, source) VALUES (?,?,?)').run(f.channel, String(f.orderId), f.viaView ? 'airtable view' : 'airtable done box');
      }
      audit('airtable.shipped', { entity: f.channel, entityId: String(f.orderId), detail: { tracking: f.tracking, destination: f.destination } });
      done.push(f);
    } catch (err) { log.warn(`could not keep the tracking number of ${f.ref}: ${err.message}`); }
  }
  return { found: done, checked, unsent: unsent.length, filled, fetched, settled };
}
