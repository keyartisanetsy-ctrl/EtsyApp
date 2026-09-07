/**
 * The short human code an order carries on a sheet, e.g. 26-0709-01.
 *
 * Two rules matter:
 *   - it is derived from the order's own day, not from today;
 *   - it is assigned once and stored, so it never changes underneath a row
 *     that is already in Airtable, and every item of the same order carries
 *     the same code.
 *
 * The shape is a template so it can be changed without touching code:
 *   {YY} {YYYY} two/four digit year   {DD} day   {MM} month   {NN} the
 *   order's position within its day (01, 02, ...), width set by how many Ns.
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { readSetting } from './settings.js';

// Matches the codes already in these sheets: 26-0316-25, 25-1216-01,
// 26-0105-40. Those are year-month-day; read as day-month the first would be
// month 16, which cannot happen.
export const DEFAULT_TEMPLATE = '{YY}-{MM}{DD}-{NN}';

const template = () => readSetting('orders.code_template') || DEFAULT_TEMPLATE;

const pad = (n, width) => String(n).padStart(width, '0');

/** Fill the template for a given day and sequence number. */
export function formatCode(day, seq, pattern = template()) {
  const [y, m, d] = String(day).slice(0, 10).split('-');
  return pattern
    .replace(/\{YYYY\}/g, y)
    .replace(/\{YY\}/g, y.slice(2))
    .replace(/\{MM\}/g, m)
    .replace(/\{DD\}/g, d)
    .replace(/\{N+\}/g, (match) => pad(seq, match.length - 2));
}

const dayOf = (createdTs) => new Date((createdTs ?? 0) * 1000).toISOString().slice(0, 10);

/**
 * The code for one order, assigning it on first use.
 *
 * Sequence numbers follow the order's timestamp within its day, so two orders
 * from the same day always compare the way a human would expect, whatever
 * order they happen to be synced in.
 */
export function codeFor(receiptId, { shopId = activeShopId(), createdTs = null } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT code FROM order_codes WHERE shop_id IS ? AND receipt_id = ?')
    .get(shopId, receiptId);
  if (existing) return existing.code;

  const receipt = db.prepare('SELECT created_ts FROM receipts WHERE receipt_id = ? AND shop_id IS ?')
    .get(receiptId, shopId);
  const ts = createdTs ?? receipt?.created_ts;
  if (!ts) return null;
  const day = dayOf(ts);

  // The order's own place in its day, counted over every order of that day
  // whether or not it has a code yet. Deriving the position from the clock
  // rather than from how many codes exist means the numbering comes out the
  // same however the orders happen to be synced.
  const position = db.prepare(`
    SELECT COUNT(*) AS c FROM receipts r
    WHERE r.shop_id IS ? AND date(r.created_ts, 'unixepoch') = ?
      AND (r.created_ts < ? OR (r.created_ts = ? AND r.receipt_id < ?))`)
    .get(shopId, day, ts, ts, receiptId).c + 1;

  // A code already in a sheet must never be reused, so if an older order turns
  // up after its neighbours were numbered, it takes the next free slot instead
  // of colliding.
  const used = new Set(db.prepare('SELECT seq FROM order_codes WHERE shop_id IS ? AND day = ?')
    .all(shopId, day).map((r) => r.seq));
  let seq = position;
  while (used.has(seq)) seq += 1;

  const code = formatCode(day, seq);

  db.prepare(`INSERT INTO order_codes (shop_id, receipt_id, code, day, seq) VALUES (?,?,?,?,?)
              ON CONFLICT(shop_id, receipt_id) DO NOTHING`).run(shopId, receiptId, code, day, seq);

  return db.prepare('SELECT code FROM order_codes WHERE shop_id IS ? AND receipt_id = ?')
    .get(shopId, receiptId)?.code ?? code;
}

/** Codes for many orders at once, assigning any that are missing. */
export function codesFor(receiptIds = [], shopId = activeShopId()) {
  const out = {};
  // Oldest first, so a batch numbers itself in the same order a person would.
  const ordered = getDb().prepare(`
    SELECT receipt_id, created_ts FROM receipts
    WHERE shop_id IS ? AND receipt_id IN (${receiptIds.map(() => '?').join(',') || 'NULL'})
    ORDER BY created_ts ASC`).all(shopId, ...receiptIds);
  for (const r of ordered) out[r.receipt_id] = codeFor(r.receipt_id, { shopId, createdTs: r.created_ts });
  return out;
}

// --------------------------------------------------------------------- month

const TR_MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026 Eylül" - the shape these sheets already use for their Month column. */
export function monthLabelTr(createdTs) {
  if (!createdTs) return null;
  const d = new Date(createdTs * 1000);
  return `${d.getUTCFullYear()} ${TR_MONTHS[d.getUTCMonth()]}`;
}

export function monthLabelEn(createdTs) {
  if (!createdTs) return null;
  const d = new Date(createdTs * 1000);
  return `${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
