/**
 * The supplier side of an order, entered from the Packing page: the Taobao
 * order number it was bought under, and what it cost - and carrying both to
 * Airtable.
 *
 * Both are kept per order, in the places the Orders pages already read them
 * (the "Ord#" supplier reference; the order's supply cost), so nothing is typed
 * twice. An order bought in several Taobao orders takes them all, comma
 * separated, and the total cost.
 *
 * Reflecting them to Airtable updates only the columns the destination maps to
 * those two values (and the currency / USD columns that go with the cost), on
 * the Airtable rows this app already created for the order. An Airtable cell
 * that already holds a different value is never overwritten silently: the
 * caller is told about it first and chooses to change it or keep it.
 */
import { getDb } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { readSetting } from './settings.js';
import * as etsyOrders from './orders.js';
import * as shopifyOrders from './shopify.js';
import * as airtable from './airtable.js';
import * as at from '../airtable/client.js';
import { inOrderShop } from '../lib/ordershop.js';

const log = createLogger('ordersupply');

const SOURCE = {
  taobao: 'flags.supplier_ref',
  cost: 'tracking.supply_cost',
  currency: 'tracking.supply_cost_currency',
  usd: 'tracking.supply_cost_usd',
};
const LABEL = { [SOURCE.taobao]: 'Taobao order number', [SOURCE.cost]: 'Supply cost' };
const CORE = new Set([SOURCE.taobao, SOURCE.cost]);

// What is reflected to Airtable, and how: the supplier side (above), or the hand-over - the package code and the
// YunExpress tracking number given to an order that never came through the warehouse.
const HANDOFF = { code: 'order.code', track: 'tracking.code' };
const SUPPLY_KIND = { id: 'supply', sources: Object.values(SOURCE), core: CORE, label: LABEL, followsCost: true };
const HANDOFF_KIND = {
  id: 'handoff', sources: Object.values(HANDOFF), core: new Set(Object.values(HANDOFF)), followsCost: false,
  label: { [HANDOFF.code]: 'Package code', [HANDOFF.track]: 'Tracking number' },
};

// ------------------------------------------------------------------- reading

/** The supplier order number and cost of many orders at once: Map("channel:orderId" -> { taobaoOrder, cost, currency }). */
export function supplyForOrders(pairs = []) {
  const db = getDb();
  const out = new Map();
  const etsy = [...new Set(pairs.filter((p) => p.channel === 'etsy').map((p) => Number(p.orderId)))];
  const shopify = [...new Set(pairs.filter((p) => p.channel === 'shopify').map((p) => String(p.orderId)))];
  if (etsy.length) {
    for (const r of db.prepare(`SELECT receipt_id AS id, supplier_order_ref AS ref, supply_cost AS cost, supply_cost_currency AS ccy
                                FROM order_flags WHERE receipt_id IN (${etsy.map(() => '?').join(',')})`).all(...etsy)) {
      out.set(`etsy:${r.id}`, { taobaoOrder: r.ref || '', cost: r.cost ?? null, currency: r.ccy || null });
    }
  }
  if (shopify.length) {
    for (const r of db.prepare(`SELECT order_id AS id, supplier_order_ref AS ref, supply_cost AS cost, supply_cost_currency AS ccy
                                FROM shopify_fulfillments WHERE order_id IN (${shopify.map(() => '?').join(',')})`).all(...shopify)) {
      out.set(`shopify:${r.id}`, { taobaoOrder: r.ref || '', cost: r.cost ?? null, currency: r.ccy || null });
    }
  }
  return out;
}

export const supplyFor = (channel, orderId) => supplyForOrders([{ channel, orderId }]).get(`${channel}:${orderId}`)
  ?? { taobaoOrder: '', cost: null, currency: null };

// ------------------------------------------------------------------- saving

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** Save what was typed. A field that is left out (undefined) is not touched; an empty one clears it. */
export function saveSupply(channel, orderId, values = {}) {
  return inOrderShop(channel, orderId, () => saveSupplyHere(channel, orderId, values));
}

function saveSupplyHere(channel, orderId, { taobaoOrder, cost, currency } = {}) {
  if (channel !== 'etsy' && channel !== 'shopify') throw badRequest('channel must be "etsy" or "shopify".');
  const ccy = String(currency || readSetting('orders.supply_cost_currency') || 'CNY').trim().toUpperCase().slice(0, 6) || 'CNY';
  if (taobaoOrder !== undefined) {
    const ref = clean(taobaoOrder);
    if (channel === 'etsy') etsyOrders.setFlags([Number(orderId)], { supplierOrderRef: ref });
    else shopifyOrders.setSupplierInfo(String(orderId), { supplierOrderRef: ref });
  }
  if (cost !== undefined) {
    const amount = cost === null || String(cost).trim() === '' ? null : Number(String(cost).replace(',', '.'));
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw badRequest(`"${cost}" is not a cost.`);
    if (channel === 'etsy') etsyOrders.setOrderSupplyCost(orderId, { cost: amount, currency: ccy });
    else shopifyOrders.setSupplyCost(String(orderId), { cost: amount, currency: ccy });
  }
  return supplyFor(channel, orderId);
}

// ------------------------------------------------------------------- Airtable

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const sameValue = (a, b) => {
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9;
  }
  return String(a ?? '').trim() === String(b ?? '').trim();
};
const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

// The Airtable columns people already keep these in, by name, best first. A destination that has no column mapped for the
// Taobao order number or the cost is given one when a column with one of these names exists (and is free to write to).
const COLUMN_NAMES = {
  [SOURCE.taobao]: ['taoworld sipariş kodu', 'taobao order no', 'taobao order number', 'taobao order', 'taobao sipariş no', 'taobao sipariş',
    'çin order no', 'çin sipariş no', 'supplier order', 'supplier order no', 'tedarik sipariş no'],
  [SOURCE.cost]: ['product cost (¥)', 'product cost (yuan)', 'taobao cost', 'supply cost', 'tedarik maliyeti', 'payment', 'ali payment'],
};
// the columns people keep the package code and the YunExpress number in (never "Çin paket kodu": that one is the Chinese carrier's)
COLUMN_NAMES[HANDOFF.code] = ['kod', 'paket kodu', 'package code', 'paket kod', 'order code'];
COLUMN_NAMES[HANDOFF.track] = ['takip no', 'manuel shipping', 'tracking number', 'tracking no', 'yunexpress takip no', 'yunexpress'];
const TEXT_TYPES = new Set(['singleLineText', 'multilineText']);
const NUMBER_TYPES = new Set(['currency', 'number']);

/**
 * Map the Taobao order number and the supply cost of a destination that lacks them, by the names of its columns, and
 * keep the mapping. Never takes a column that is already mapped to something else. Returns what was added.
 */
async function autoMapSupply(dest, kind = SUPPLY_KIND) {
  const missing = [...kind.core].filter((src) => !dest.fieldMap.some((e) => e.source === src));
  if (!missing.length) return [];
  const table = await at.getTable(dest.baseId, dest.tableId);
  const taken = new Set(dest.fieldMap.map((e) => e.target));
  const added = [];
  for (const src of missing) {
    const okType = src === SOURCE.cost ? NUMBER_TYPES : TEXT_TYPES;
    const field = COLUMN_NAMES[src].map((name) => table.fields.find((f) => f.writable && okType.has(f.type) && !taken.has(f.name)
      && f.name.trim().toLowerCase() === name)).find(Boolean);
    if (!field) continue;
    taken.add(field.name);
    added.push({ target: field.name, source: src, confidence: 1, why: 'matched by the column name when it was first sent' });
  }
  if (added.length) {
    getDb().prepare("UPDATE airtable_destinations SET field_map = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify([...dest.fieldMap, ...added]), dest.id);
    log.info(`mapped ${added.map((a) => `${a.source} -> ${a.target}`).join(', ')} on destination ${dest.id}`);
  }
  return added;
}

/**
 * What would be written to Airtable for this order, per destination, per
 * Airtable row, and what each target cell holds right now.
 */
async function planFor(channel, orderId, kind = SUPPLY_KIND) {
  const key = channel === 'etsy' ? Number(orderId) : String(orderId);
  const destinations = airtable.listDestinations().filter((d) => d.channel === channel);
  const out = [];
  for (let dest of destinations) {
    let autoMapped = [];
    if ([...kind.core].some((src) => !dest.fieldMap.some((e) => e.source === src))) {
      try {
        // eslint-disable-next-line no-await-in-loop
        autoMapped = await autoMapSupply(dest, kind);
        if (autoMapped.length) dest = airtable.getDestination(dest.id);
      } catch (err) { log.warn(`could not look for the Taobao/cost columns of ${dest.label}: ${err.message}`); }
    }
    const mapped = dest.fieldMap.filter((e) => kind.sources.includes(e.source));
    const base = { id: dest.id, label: dest.label, baseId: dest.baseId, tableId: dest.tableId, rows: [], autoMapped };
    if (!mapped.some((e) => kind.core.has(e.source))) { out.push({ ...base, status: 'not_mapped' }); continue; }

    const links = airtable.linksFor(dest.id, [key]);
    if (!links.length) { out.push({ ...base, status: 'not_in_airtable' }); continue; }

    // eslint-disable-next-line no-await-in-loop
    const { records } = await airtable.buildRecords(dest, [key]);
    const recordIdOf = new Map(links.map((l) => [`${String(l.receipt_id)}:${l.transaction_id ?? 0}`, l.record_id]));
    for (const rec of records) {
      const recordId = recordIdOf.get(`${String(rec.receiptId)}:${rec.transactionId ?? 0}`);
      if (!recordId) continue;
      // buildRecords has already left order-level values off every row but the first.
      const writes = mapped.filter((e) => e.target in rec.fields).map((e) => ({ source: e.source, target: e.target, next: rec.fields[e.target] }));
      if (writes.length) base.rows.push({ recordId, transactionId: rec.transactionId ?? null, writes });
    }
    if (!base.rows.length) { out.push({ ...base, status: 'not_in_airtable' }); continue; }

    // What those cells hold now.
    const targets = [...new Set(base.rows.flatMap((r) => r.writes.map((w) => w.target)))];
    const ids = [...new Set(base.rows.map((r) => r.recordId.replace(/[^A-Za-z0-9]/g, '')))];
    // eslint-disable-next-line no-await-in-loop
    const current = await at.listRecords(dest.baseId, dest.tableId, {
      fields: targets, filterByFormula: `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(',')})`, max: ids.length + 10,
    });
    const byId = new Map(current.map((r) => [r.id, r.fields ?? {}]));
    for (const row of base.rows) {
      for (const w of row.writes) {
        const now = byId.get(row.recordId)?.[w.target];
        w.current = isEmpty(now) ? null : now;
        w.state = isEmpty(now) ? 'empty' : sameValue(now, w.next) ? 'same' : 'differs';
      }
    }
    out.push({ ...base, status: 'ready', table: dest.tableName });
  }
  return out;
}

/** Cells that already hold a different value for the Taobao number or the cost - the ones that need a decision. */
function conflictsOf(plan, kind = SUPPLY_KIND) {
  return plan.flatMap((d) => d.rows.flatMap((r) => r.writes
    .filter((w) => kind.core.has(w.source) && w.state === 'differs')
    .map((w) => ({ destination: d.label, column: w.target, field: kind.label[w.source], current: show(w.current), next: show(w.next) }))));
}

/** Write what is empty, what differs only if `overwrite`, and nothing that is already the same. */
async function applyPlan(plan, { overwrite, kind = SUPPLY_KIND }) {
  const summary = [];
  for (const d of plan) {
    if (d.status !== 'ready') { summary.push({ destination: d.label, status: d.status, filled: 0, changed: 0, kept: 0 }); continue; }
    const dest = airtable.getDestination(d.id);
    const updates = [];
    let filled = 0; let changed = 0; let kept = 0;
    for (const row of d.rows) {
      const fields = {};
      const cost = kind.followsCost ? row.writes.find((w) => w.source === SOURCE.cost) : null;
      const costWritten = cost ? (cost.state === 'empty' || (cost.state === 'differs' && overwrite)) : false;
      for (const w of row.writes) {
        const core = kind.core.has(w.source);
        let doWrite;
        if (core) doWrite = w.state === 'empty' || (w.state === 'differs' && overwrite);
        else doWrite = costWritten && w.state !== 'same'; // the currency and USD columns follow the cost
        if (core && w.state === 'empty') filled += 1;
        if (core && w.state === 'differs') { if (overwrite) changed += 1; else kept += 1; }
        if (doWrite) fields[w.target] = w.next;
      }
      if (Object.keys(fields).length) updates.push({ id: row.recordId, fields });
    }
    if (updates.length) {
      // eslint-disable-next-line no-await-in-loop
      await at.updateRecords(d.baseId, d.tableId, updates, { typecast: dest.createOptions });
    }
    summary.push({ destination: d.label, table: d.table, status: updates.length ? 'sent' : 'nothing_to_change', filled, changed, kept });
  }
  return summary;
}

/**
 * Save what was typed and, when asked, carry it to Airtable.
 *   airtable: 'none'   - only save
 *             'check'  - send it if nothing in Airtable would be overwritten, otherwise report the conflicts and send nothing
 *             'change' - send it, overwriting differing cells
 *             'keep'   - send it, leaving differing cells as they are
 */
export function saveAndReflect(channel, orderId, values = {}, opts = {}) {
  // as the order's own shop, so its own Airtable destinations are the ones used
  return inOrderShop(channel, orderId, () => saveAndReflectHere(channel, orderId, values, opts));
}

async function saveAndReflectHere(channel, orderId, values = {}, { airtable: decision = 'none' } = {}) {
  const supply = saveSupply(channel, orderId, values);
  if (decision === 'none') return { supply, airtable: null };

  let plan;
  try { plan = await planFor(channel, orderId); } catch (err) {
    log.warn(`Airtable supply check failed: ${err.message}`);
    return { supply, airtable: { status: 'error', message: err.message } };
  }
  if (!plan.length) return { supply, airtable: { status: 'no_destination' } };
  const autoMapped = plan.flatMap((d) => (d.autoMapped ?? []).map((m) => ({ destination: d.label, column: m.target, field: LABEL[m.source] })));

  const ready = plan.filter((d) => d.status === 'ready');
  if (!ready.length) {
    const status = plan.some((d) => d.status === 'not_in_airtable') ? 'not_in_airtable' : 'not_mapped';
    return { supply, airtable: { status, destinations: plan.map((d) => ({ destination: d.label, status: d.status })), autoMapped } };
  }

  const conflicts = conflictsOf(ready);
  if (decision === 'check' && conflicts.length) return { supply, airtable: { status: 'needs_decision', conflicts, autoMapped } };

  try {
    const summary = await applyPlan(plan, { overwrite: decision === 'change' });
    const sent = summary.some((s) => s.status === 'sent');
    return { supply, airtable: { status: sent ? 'sent' : 'nothing_to_change', destinations: summary, kept: conflicts.length && decision === 'keep' ? conflicts : [], autoMapped } };
  } catch (err) {
    log.warn(`Airtable supply update failed: ${err.message}`);
    return { supply, airtable: { status: 'error', message: err.message } };
  }
}


/**
 * Carry the package code and the tracking number of an order to Airtable (only those two cells, only on the rows this
 * app already put there). Same decision rule as the supply entries: a cell that holds something different is reported
 * ('needs_decision') unless `decision` says change or keep.
 */
export function reflectHandoff(channel, orderId, { decision = 'check' } = {}) {
  return inOrderShop(channel, orderId, () => reflectHandoffHere(channel, orderId, decision));
}

async function reflectHandoffHere(channel, orderId, decision) {
  const kind = HANDOFF_KIND;
  let plan;
  try { plan = await planFor(channel, orderId, kind); } catch (err) {
    log.warn(`Airtable hand-over check failed: ${err.message}`);
    return { status: 'error', message: err.message };
  }
  if (!plan.length) return { status: 'no_destination' };
  const autoMapped = plan.flatMap((d) => (d.autoMapped ?? []).map((m) => ({ destination: d.label, column: m.target, field: kind.label[m.source] })));
  const ready = plan.filter((d) => d.status === 'ready');
  if (!ready.length) {
    const status = plan.some((d) => d.status === 'not_in_airtable') ? 'not_in_airtable' : 'not_mapped';
    return { status, destinations: plan.map((d) => ({ destination: d.label, status: d.status })), autoMapped };
  }
  const conflicts = conflictsOf(ready, kind);
  if (decision === 'check' && conflicts.length) return { status: 'needs_decision', conflicts, autoMapped };
  try {
    const summary = await applyPlan(plan, { overwrite: decision === 'change', kind });
    const sent = summary.some((s) => s.status === 'sent');
    return { status: sent ? 'sent' : 'nothing_to_change', destinations: summary, kept: conflicts.length && decision === 'keep' ? conflicts : [], autoMapped };
  } catch (err) {
    log.warn(`Airtable hand-over update failed: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}
