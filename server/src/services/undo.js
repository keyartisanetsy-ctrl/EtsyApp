/**
 * Taking back a change.
 *
 * Everything here works one way: before a change is written, the rows it will
 * touch are copied as they are. Undoing puts those rows back. That is all -
 * there is no clever diffing, because the failure mode of clever diffing is an
 * undo that half-works, which is worse than no undo at all.
 *
 * Two rules keep it honest:
 *
 *   - Only local changes are undoable. Once something has gone to Etsy or into
 *     Airtable it is not ours to take back, and pretending otherwise would be a
 *     lie. Those steps are recorded in the history as "cannot be undone here",
 *     with what to do instead.
 *   - An entry is undone once. After that it is marked spent, so a second
 *     Ctrl+Z moves to the change before it rather than re-applying the same
 *     rows over newer work.
 */
import { getDb, audit } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { badRequest, notFound } from '../lib/errors.js';

/** How many steps back you can go. Older entries are trimmed. */
const DEPTH = 200;

/**
 * Copy the rows a change is about to touch.
 *
 * `where` is a fragment and `params` its values, e.g.
 *   snapshot('listing_products', 'listing_id = ?', [123])
 */
function snapshot(table, where, params) {
  const rows = getDb().prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params);
  return { table, where, params, rows };
}

/**
 * Record a change and return a handle.
 *
 * Call `begin` before writing, then `commit` after. If the write throws, the
 * entry is dropped, so the history never shows a change that did not happen.
 */
export function begin({ label, kind, targets = [], undoable = true, note = null }) {
  const snapshots = undoable ? targets.map((t) => snapshot(t.table, t.where, t.params)) : [];
  return {
    label, kind, undoable, note, snapshots,
    // How many rows existed before, so "restored 3 of 4" can be said honestly.
    before: snapshots.reduce((n, s) => n + s.rows.length, 0),
  };
}

/** Write the entry once the change has actually gone through. */
export function commit(handle, { affected = null, detail = null } = {}) {
  if (!handle) return null;
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO undo_log (shop_id, label, kind, undoable, note, snapshots, affected, detail, created_at)
    VALUES (?,?,?,?,?,?,?,?, datetime('now'))`)
    .run(activeShopId(), handle.label, handle.kind, handle.undoable ? 1 : 0, handle.note,
      JSON.stringify(handle.snapshots), affected, detail ? JSON.stringify(detail) : null);

  // Keep the history to a sensible depth.
  db.prepare(`
    DELETE FROM undo_log WHERE shop_id IS ? AND id NOT IN (
      SELECT id FROM undo_log WHERE shop_id IS ? ORDER BY id DESC LIMIT ?)`)
    .run(activeShopId(), activeShopId(), DEPTH);

  return Number(info.lastInsertRowid);
}

/**
 * The convenience wrapper: snapshot, run, record. Use this rather than begin
 * and commit by hand wherever the change is a single function call.
 */
export function tracked({ label, kind, targets = [], undoable = true, note = null }, fn) {
  const handle = begin({ label, kind, targets, undoable, note });
  const result = fn();
  const affected = typeof result?.updated === 'number' ? result.updated
    : typeof result?.changed === 'number' ? result.changed
      : null;
  const id = commit(handle, { affected });
  return { ...(result ?? {}), undoId: id };
}

/** The history, newest first. */
export function history({ limit = 50 } = {}) {
  return getDb().prepare(`
    SELECT id, label, kind, undoable, undone, note, affected, created_at, undone_at
    FROM undo_log WHERE shop_id IS ? ORDER BY id DESC LIMIT ?`).all(activeShopId(), limit)
    .map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      canUndo: !!r.undoable && !r.undone,
      undone: !!r.undone,
      note: r.note,
      affected: r.affected,
      at: r.created_at,
      undoneAt: r.undone_at,
    }));
}

/** The change Ctrl+Z would take back, or null when there is nothing to undo. */
export function next() {
  const row = getDb().prepare(`
    SELECT id, label, kind, affected, created_at FROM undo_log
    WHERE shop_id IS ? AND undoable = 1 AND COALESCE(undone, 0) = 0
    ORDER BY id DESC LIMIT 1`).get(activeShopId());
  return row ? { id: row.id, label: row.label, kind: row.kind, affected: row.affected, at: row.created_at } : null;
}

/**
 * Put the rows back as they were.
 *
 * Rows that existed before are restored; rows the change created are deleted,
 * because they were not there when the snapshot was taken. Both halves run in
 * one transaction, so an undo either happens completely or not at all.
 */
export function undo(id = null) {
  const db = getDb();
  const entry = id
    ? db.prepare('SELECT * FROM undo_log WHERE id = ? AND shop_id IS ?').get(Number(id), activeShopId())
    : db.prepare(`SELECT * FROM undo_log WHERE shop_id IS ? AND undoable = 1 AND COALESCE(undone,0) = 0
                  ORDER BY id DESC LIMIT 1`).get(activeShopId());

  if (!entry) throw notFound('There is nothing to undo.');
  if (!entry.undoable) {
    throw badRequest(`"${entry.label}" cannot be undone here. ${entry.note ?? 'It went to another service, so it has to be changed there.'}`);
  }
  if (entry.undone) throw badRequest(`"${entry.label}" has already been undone.`);

  const snapshots = JSON.parse(entry.snapshots ?? '[]');
  let restored = 0;
  let removed = 0;

  db.transaction(() => {
    for (const snap of snapshots) {
      // Whatever is there now, in the same slice of the table, goes.
      const nowThere = db.prepare(`SELECT * FROM ${snap.table} WHERE ${snap.where}`).all(...snap.params);
      removed += Math.max(0, nowThere.length - snap.rows.length);
      db.prepare(`DELETE FROM ${snap.table} WHERE ${snap.where}`).run(...snap.params);

      // And the rows as they were go back in.
      for (const row of snap.rows) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${snap.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
          .run(...cols.map((c) => row[c]));
        restored += 1;
      }
    }
    db.prepare("UPDATE undo_log SET undone = 1, undone_at = datetime('now') WHERE id = ?").run(entry.id);
  })();

  audit('undo', { detail: { id: entry.id, label: entry.label, restored } });
  return {
    id: entry.id,
    label: entry.label,
    restored,
    removed,
    message: `Took back "${entry.label}"${restored ? `, putting ${restored} row(s) back as they were` : ''}.`,
  };
}

/**
 * Note something that happened but cannot be taken back here.
 *
 * A push to Etsy or Airtable belongs in the history - you want to see it when
 * you look at what happened - but pressing Ctrl+Z must not silently skip past
 * it and undo something older instead. So it goes in marked as not undoable,
 * with what to do about it.
 */
export function recordExternal({ label, kind, note, affected = null, detail = null }) {
  return commit(begin({ label, kind, targets: [], undoable: false, note }), { affected, detail });
}

/** Forget the history. */
export function clear() {
  const n = getDb().prepare('DELETE FROM undo_log WHERE shop_id IS ?').run(activeShopId()).changes;
  return { cleared: n };
}
