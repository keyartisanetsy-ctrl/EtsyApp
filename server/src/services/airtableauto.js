/**
 * The Airtable autopilot: keeps Airtable in step with the shops without anyone pressing a button.
 *
 * On a schedule (and whenever "Run now" is pressed) it looks at the not-sent views and at the rows of the orders the app still
 * has open - a handful of requests, not the whole table - and works out what Airtable is missing:
 *
 *   - a tracking number the app or the shop holds, for an order Airtable still lists as not sent  -> the empty tracking cell
 *   - a status still "in progress" on an order the shops finished (canceled, fulfilled, tracked)  -> its "OK" twin, which is
 *     what takes the row out of the not-sent view
 *   - an order the app has but Airtable has no row for                                           -> added, if you allowed it
 *
 * Three modes: Off, Preview (the default: looks and reports exactly what it would write, writes nothing) and On. Every run is
 * logged, every cell it writes is kept with its old value so a run can be undone, and one run never writes more cells than
 * the limit. Nothing here talks to Etsy, and nothing is ever sent to a buyer: the only thing written is Airtable.
 */
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import * as at from '../airtable/client.js';
import { readSetting, writeSetting } from './settings.js';
import { syncShippedFromAirtable } from './airtableshipped.js';
import { push } from './airtable.js';
import { shopOfOrder } from '../lib/ordershop.js';
import { withShop } from '../etsy/client.js';
import { withShopifyShop } from '../shopify/client.js';

const log = createLogger('airtable-auto');

const MODES = ['off', 'preview', 'on'];
const KEEP_RUNS = 300;
const NEW_ORDER_DAYS = 21;          // an order older than this is reported as missing but never added by itself
const LIST_LIMIT = 150;             // lines of one kind kept in a run's detail

export function config() {
  const mode = readSetting('airtable.auto_mode');
  return {
    mode: MODES.includes(mode) ? mode : 'preview',
    minutes: Math.max(10, Number(readSetting('airtable.auto_minutes')) || 30),
    cap: Math.max(1, Number(readSetting('airtable.auto_cap')) || 40),
    addMissing: readSetting('airtable.auto_add_missing') === 'true',
  };
}

export function setConfig({ mode, minutes, cap, addMissing } = {}) {
  if (mode !== undefined) {
    if (!MODES.includes(mode)) throw Object.assign(new Error('Mode must be off, preview or on.'), { status: 400 });
    writeSetting('airtable.auto_mode', mode);
  }
  if (minutes !== undefined) writeSetting('airtable.auto_minutes', String(Math.max(10, Math.min(1440, Math.round(Number(minutes)) || 30))));
  if (cap !== undefined) writeSetting('airtable.auto_cap', String(Math.max(1, Math.min(500, Math.round(Number(cap)) || 40))));
  if (addMissing !== undefined) writeSetting('airtable.auto_add_missing', addMissing ? 'true' : 'false');
  return config();
}

const iso = (sqlite) => (sqlite ? `${String(sqlite).replace(' ', 'T')}Z` : null);
const parse = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const valueText = (v) => (Array.isArray(v) ? v.map((x) => x?.name ?? x).join(', ') : String(v ?? '')).trim();

function shapeRun(r) {
  return {
    id: r.id, at: iso(r.ran_at), trigger: r.trigger, mode: r.mode, deep: !!r.deep, ok: !!r.ok, error: r.error || '',
    checked: r.checked, unsent: r.unsent, planned: r.planned, wrote: r.wrote, added: r.added, missing: r.missing, capped: !!r.capped,
    detail: parse(r.detail, {}),
  };
}

export function listRuns(limit = 15) {
  const db = getDb();
  return db.prepare('SELECT * FROM airtable_auto_runs ORDER BY id DESC LIMIT ?').all(limit).map((r) => {
    const run = shapeRun(r);
    const w = db.prepare('SELECT COUNT(*) AS c, SUM(CASE WHEN undone_at IS NULL THEN 1 ELSE 0 END) AS open FROM airtable_auto_writes WHERE run_id = ?').get(r.id);
    return { ...run, undoable: (w.open ?? 0) > 0, undone: w.c > 0 && !(w.open > 0) };
  });
}

let running = null;

/**
 * One look at Airtable. mode 'preview' only reports; 'on' writes. `trigger` is 'schedule' or 'manual'.
 * Returns the stored run (with its per-order detail).
 */
export async function runOnce({ trigger = 'manual', mode, deep = false } = {}) {
  if (running) return { busy: true };
  const cfg = config();
  const useMode = mode ?? (cfg.mode === 'on' ? 'on' : 'preview');
  const db = getDb();
  const runId = Number(db.prepare('INSERT INTO airtable_auto_runs (trigger, mode, deep, ok) VALUES (?,?,?,0)').run(trigger, useMode, deep ? 1 : 0).lastInsertRowid);
  const finish = async () => {
    const wroteCells = [];
    const stamp = db.prepare(`INSERT INTO airtable_auto_writes (run_id, base_id, table_id, record_id, field, channel, order_key, kind, old_value, new_value)
                              VALUES (?,?,?,?,?,?,?,?,?,?)`);
    try {
      if (!at.hasToken()) throw new Error('Airtable is not connected (no token).');
      const res = await syncShippedFromAirtable({
        write: useMode === 'on', plan: true, light: !deep, maxWrites: cfg.cap,
        onWrite: (w) => { stamp.run(runId, w.baseId, w.tableId, w.recordId, w.field, w.channel, w.key, w.kind, JSON.stringify(w.old ?? null), JSON.stringify(w.value ?? null)); wroteCells.push(w); },
      });

      // orders the app has that this Airtable has no row for
      const fresh = (o) => !o.orderedAt || (Date.now() - Date.parse(o.orderedAt)) / 86_400_000 <= NEW_ORDER_DAYS;
      const missing = res.missing;
      let added = [];
      let addError = '';
      if (useMode === 'on' && cfg.addMissing && missing.length) {
        try { added = await addOrders(missing.filter(fresh)); } catch (err) { addError = err.message; log.warn(`could not add missing orders: ${err.message}`); }
      }

      const planned = res.plan.fills.length + res.plan.moves.length;
      const detail = {
        fills: res.plan.fills.slice(0, LIST_LIMIT).map(({ table, key, tracking, field, old }) => ({ table, key, tracking, field, old: valueText(old), done: wroteCells.some((w) => w.kind === 'tracking' && w.key === key && w.field === field) })),
        moves: res.plan.moves.slice(0, LIST_LIMIT).map(({ table, key, from, to, why, field }) => ({ table, key, from, to, why, field, done: wroteCells.some((w) => w.kind === 'status' && w.key === key && w.field === field) })),
        blocked: res.blocked.slice(0, LIST_LIMIT),
        missing: missing.slice(0, LIST_LIMIT).map(({ channel, orderId, ref, buyer, orderedAt, destination }) => ({ channel, orderId, ref, buyer, orderedAt, destination, old: !fresh({ orderedAt }), added: added.some((a) => a.orderId === orderId) })),
        added: added.length, addError, errors: res.errors, fetched: res.fetched, untouched: res.untouched,
      };
      db.prepare(`UPDATE airtable_auto_runs SET ok = ?, error = ?, checked = ?, unsent = ?, planned = ?, wrote = ?, added = ?, missing = ?, capped = ?, detail = ? WHERE id = ?`)
        .run(res.errors.length && !wroteCells.length && !planned ? 0 : 1, res.errors.join(' | ').slice(0, 500), res.checked, res.unsent, planned, wroteCells.length, added.length, missing.length, res.capped ? 1 : 0, JSON.stringify(detail), runId);
      if (wroteCells.length || added.length) audit('airtable.auto', { entity: 'airtable', detail: { runId, trigger, wrote: wroteCells.length, added: added.length } });
    } catch (err) {
      log.warn(`autopilot run failed: ${err.message}`);
      db.prepare('UPDATE airtable_auto_runs SET ok = 0, error = ? WHERE id = ?').run(String(err.message).slice(0, 500), runId);
    }
    // keep the log short
    db.prepare('DELETE FROM airtable_auto_runs WHERE id NOT IN (SELECT id FROM airtable_auto_runs ORDER BY id DESC LIMIT ?)').run(KEEP_RUNS);
    db.prepare('DELETE FROM airtable_auto_writes WHERE run_id NOT IN (SELECT id FROM airtable_auto_runs)').run();
    return listRuns(1)[0];
  };
  running = finish();
  try { return await running; } finally { running = null; }
}

/** Add these orders (as returned in a run's `missing`) to Airtable through each order's own shop destination. */
export async function addOrders(list) {
  const added = [];
  const groups = new Map();
  for (const o of list) {
    const shopId = shopOfOrder(o.channel, o.orderId);
    const k = `${o.channel}:${shopId}`;
    if (!groups.has(k)) groups.set(k, { channel: o.channel, shopId, orders: [] });
    groups.get(k).orders.push(o);
  }
  for (const g of groups.values()) {
    const ids = g.orders.map((o) => (g.channel === 'etsy' ? Number(o.orderId) : String(o.orderId)));
    const go = () => push({ receiptIds: ids, channel: g.channel, mode: 'upsert' });
    // eslint-disable-next-line no-await-in-loop
    const res = await (g.shopId == null ? go() : g.channel === 'etsy' ? withShop(g.shopId, go) : withShopifyShop(g.shopId, go));
    if ((res.created ?? 0) + (res.updated ?? 0) > 0) added.push(...g.orders);
    if (res.failed) log.warn(`adding orders to Airtable: ${res.failed} failed (${(res.errors ?? []).join('; ').slice(0, 200)})`);
  }
  return added;
}

/** "Add these to Airtable" from the card: looks again (never trusts a stale list) and adds the orders that still have no row. */
export async function addMissingNow({ includeOld = false } = {}) {
  if (!at.hasToken()) throw Object.assign(new Error('Airtable is not connected.'), { status: 400 });
  const res = await syncShippedFromAirtable({ write: false, plan: false, light: true });
  const cutoff = (o) => includeOld || !o.orderedAt || (Date.now() - Date.parse(o.orderedAt)) / 86_400_000 <= NEW_ORDER_DAYS;
  const todo = res.missing.filter(cutoff);
  const added = todo.length ? await addOrders(todo) : [];
  audit('airtable.auto', { entity: 'airtable', detail: { addedByHand: added.length } });
  return { added: added.length, orders: added.map((o) => ({ channel: o.channel, ref: o.ref, buyer: o.buyer })), skippedOld: res.missing.length - todo.length };
}

/**
 * Put a run's cells back. A cell is only restored when it still holds what the run wrote, so nothing typed in Airtable since is
 * lost. Orders the run added are not removed, and tracking numbers the app kept on its own side stay.
 */
export async function undoRun(runId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM airtable_auto_writes WHERE run_id = ? AND undone_at IS NULL').all(runId);
  if (!rows.length) return { reverted: 0, changedSince: 0, nothing: true };
  const groups = new Map();
  for (const w of rows) {
    const k = `${w.base_id}/${w.table_id}`;
    if (!groups.has(k)) groups.set(k, { baseId: w.base_id, tableId: w.table_id, rows: [] });
    groups.get(k).rows.push(w);
  }
  let reverted = 0;
  let changedSince = 0;
  for (const g of groups.values()) {
    const ids = [...new Set(g.rows.map((w) => w.record_id))];
    const fields = [...new Set(g.rows.map((w) => w.field))];
    const now = new Map();
    for (let i = 0; i < ids.length; i += 40) {
      // eslint-disable-next-line no-await-in-loop
      const part = await at.listRecords(g.baseId, g.tableId, { fields, filterByFormula: `OR(${ids.slice(i, i + 40).map((id) => `RECORD_ID()='${String(id).replace(/[^A-Za-z0-9]/g, '')}'`).join(',')})`, max: 100 });
      for (const r of part) now.set(r.id, r.fields ?? {});
    }
    const back = [];
    const touched = [];
    for (const w of g.rows) {
      const current = now.get(w.record_id);
      if (!current) { touched.push(w.id); continue; }                       // the row is gone: nothing to put back
      const written = parse(w.new_value, null);
      if (valueText(current[w.field]) !== valueText(written)) { changedSince += 1; continue; }
      back.push({ id: w.record_id, fields: { [w.field]: parse(w.old_value, null) ?? (w.kind === 'status' ? [] : null) } });
      touched.push(w.id);
    }
    if (back.length) {
      // eslint-disable-next-line no-await-in-loop
      await at.updateRecords(g.baseId, g.tableId, back);
      reverted += back.length;
    }
    for (const id of touched) db.prepare("UPDATE airtable_auto_writes SET undone_at = datetime('now') WHERE id = ?").run(id);
  }
  audit('airtable.auto_undo', { entity: 'airtable', detail: { runId, reverted, changedSince } });
  return { reverted, changedSince };
}

export function status() {
  const cfg = config();
  const runs = listRuns(10);
  const lastScheduled = getDb().prepare("SELECT ran_at FROM airtable_auto_runs WHERE trigger = 'schedule' ORDER BY id DESC LIMIT 1").get();
  const base = lastScheduled ? Date.parse(iso(lastScheduled.ran_at)) : Date.now();
  return {
    ...cfg, connected: at.hasToken(), running: !!running,
    nextAt: cfg.mode === 'off' ? null : new Date((lastScheduled ? base + cfg.minutes * 60_000 : Date.now() + 60_000)).toISOString(),
    last: runs[0] ?? null, runs,
  };
}

/** Once a minute from the scheduler: runs when the interval since the last scheduled look has passed. */
export async function tick() {
  const cfg = config();
  if (cfg.mode === 'off' || running || !at.hasToken()) return null;
  const last = getDb().prepare("SELECT ran_at FROM airtable_auto_runs WHERE trigger = 'schedule' ORDER BY id DESC LIMIT 1").get();
  if (last && Date.now() - Date.parse(iso(last.ran_at)) < cfg.minutes * 60_000) return null;
  return runOnce({ trigger: 'schedule', mode: cfg.mode === 'on' ? 'on' : 'preview' });
}

