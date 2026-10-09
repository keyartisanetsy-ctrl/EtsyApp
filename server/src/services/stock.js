/**
 * Real stock - what is actually on the shelf - next to the number each shop shows.
 *
 * A shop's own quantity is often a made-up one (50, 999) so a listing never
 * shows "sold out"; that number is written to the shop. The real count is kept
 * here, per SKU - one count for a SKU whichever shops sell it, because the same
 * product in Etsy and in Shopify is the same pile on the same shelf.
 *
 * Orders take it down: every order line placed after the count was set takes
 * its quantity off, once, and never below zero - with nothing on the shelf the
 * count stays 0. An order placed before the count was set is already in the
 * count, so it is left alone.
 */
import { getDb, audit } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('stock');

const toInt = (v) => {
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw badRequest('Stock is a whole number, 0 or more.');
  return n;
};

// ------------------------------------------------------------------ the ledger

/** The order behind a line: who bought it, in which shop, under which number and packing code. */
function orderInfo(ref) {
  const db = getDb();
  if (String(ref).startsWith('etsy:')) {
    const r = db.prepare(`
      SELECT r.receipt_id AS id, r.name AS buyer, a.label AS label, a.shop_name AS shop, c.code AS code
      FROM receipt_transactions rt JOIN receipts r ON r.receipt_id = rt.receipt_id
      LEFT JOIN etsy_accounts a ON a.shop_id = r.shop_id LEFT JOIN order_codes c ON c.receipt_id = r.receipt_id
      WHERE rt.transaction_id = ?`).get(Number(String(ref).slice(5)));
    return r ? { channel: 'etsy', orderId: String(r.id), label: `#${r.id}`, code: r.code ?? null, buyer: r.buyer ?? null, shop: r.label || r.shop || null } : {};
  }
  const r = db.prepare(`
    SELECT o.order_id AS id, o.name AS name, o.customer_name AS buyer, a.label AS label, a.shop_name AS shop, c.code AS code
    FROM shopify_order_line_items li JOIN shopify_orders o ON o.order_id = li.order_id
    LEFT JOIN shopify_accounts a ON a.id = o.shop_id LEFT JOIN shopify_order_codes c ON c.order_id = o.order_id
    WHERE li.line_item_id = ?`).get(String(ref).slice(8));
  return r ? { channel: 'shopify', orderId: r.id, label: r.name || r.id, code: r.code ?? null, buyer: r.buyer ?? null, shop: r.label || r.shop || null } : {};
}

/** One line of the history of a SKU. */
function ledger({ sku, kind, before = null, after = null, ref = null, ordered = null, taken = null, note = null }) {
  const o = ref ? orderInfo(ref) : {};
  getDb().prepare(`
    INSERT INTO stock_log (sku, kind, before_qty, after_qty, delta, ref, channel, order_id, order_label, order_code, buyer, shop_name, ordered, taken, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sku, kind, before, after, before != null && after != null ? after - before : null, ref, o.channel ?? null, o.orderId ?? null,
      o.label ?? null, o.code ?? null, o.buyer ?? null, o.shop ?? null, ordered, taken, note);
}

/** Every real count, as Map(lower-case sku -> { qty, countedAt }). */
export function allReal() {
  const out = new Map();
  for (const r of getDb().prepare('SELECT sku, qty, counted_at FROM real_stock').all()) out.set(r.sku.toLowerCase(), { qty: r.qty, countedAt: r.counted_at });
  return out;
}

/** The count of one SKU, or null when nobody counts it - one indexed lookup. */
export function realFor(sku) {
  const s = String(sku ?? '').trim();
  if (!s) return null;
  const r = getDb().prepare('SELECT qty, counted_at FROM real_stock WHERE sku = ?').get(s);
  return r ? { qty: r.qty, countedAt: r.counted_at } : null;
}

/** The counts of several SKUs at once: { sku: { qty, countedAt } } for the ones somebody counts. */
export function realMap(skus = []) {
  const out = {};
  const all = allReal();
  for (const sku of [...new Set((skus ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 2000)) {
    const c = all.get(sku.toLowerCase());
    if (c) out[sku] = c;
  }
  return out;
}

/** Put a count in (the number a person just counted), and take off what has been ordered since. */
export function setReal(sku, qty) {
  const s = String(sku ?? '').trim();
  if (!s) throw badRequest('Real stock belongs to a SKU - give this variant a SKU first.');
  const n = toInt(qty);
  const before = getDb().prepare('SELECT qty FROM real_stock WHERE sku = ?').get(s);
  getDb().prepare(`
    INSERT INTO real_stock (sku, qty, counted_at, updated_at) VALUES (?,?, datetime('now'), datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET qty = excluded.qty, counted_at = datetime('now'), updated_at = datetime('now')`).run(s, n);
  audit('stock.set', { entity: 'sku', entityId: s, detail: { from: before?.qty ?? null, to: n } });
  ledger({ sku: s, kind: 'count', before: before?.qty ?? null, after: n, note: before ? 'Counted by hand' : 'Counting started' });
  return { sku: s, qty: n, from: before?.qty ?? null };
}

/**
 * Pieces that came in at the warehouse go onto the shelf: the count goes up by `qty` (and starts at `qty` when
 * nobody was counting this SKU). The date of the count is left as it was, so orders already taken off stay taken off.
 */
export function receive(sku, qty, { ref = null, note = null } = {}) {
  const s = String(sku ?? '').trim();
  if (!s) throw badRequest('Say which SKU these pieces are.');
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw badRequest('Pieces to put into stock: a whole number, 1 or more.');
  const db = getDb();
  const before = db.prepare('SELECT qty FROM real_stock WHERE sku = ?').get(s);
  if (before) db.prepare("UPDATE real_stock SET qty = qty + ?, updated_at = datetime('now') WHERE sku = ?").run(n, s);
  else db.prepare("INSERT INTO real_stock (sku, qty, counted_at, updated_at) VALUES (?,?, datetime('now'), datetime('now'))").run(s, n);
  const after = (before?.qty ?? 0) + n;
  audit('stock.receive', { entity: 'sku', entityId: s, detail: { qty: n, ref } });
  ledger({ sku: s, kind: 'receive', before: before?.qty ?? 0, after, note: note || 'Pieces received at the warehouse' });
  return { sku: s, qty: after, added: n };
}

/** Take received pieces back off the shelf (the arrival was put back to unmatched, or deleted). Never below zero. */
export function unreceive(sku, qty, { note = null } = {}) {
  const s = String(sku ?? '').trim();
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  const db = getDb();
  const before = db.prepare('SELECT qty FROM real_stock WHERE sku = ?').get(s);
  if (!before || !n) return { sku: s, qty: before?.qty ?? null, removed: 0 };
  const after = Math.max(0, before.qty - n);
  db.prepare("UPDATE real_stock SET qty = ?, updated_at = datetime('now') WHERE sku = ?").run(after, s);
  audit('stock.unreceive', { entity: 'sku', entityId: s, detail: { qty: n } });
  ledger({ sku: s, kind: 'receive', before: before.qty, after, note: note || 'Pieces taken back out (the arrival was unstocked)' });
  return { sku: s, qty: after, removed: before.qty - after };
}

export function clearReal(sku) {
  const s = String(sku ?? '').trim();
  const before = getDb().prepare('SELECT qty FROM real_stock WHERE sku = ?').get(s);
  getDb().prepare('DELETE FROM real_stock WHERE sku = ?').run(s);
  if (before) ledger({ sku: s, kind: 'clear', before: before.qty, after: null, note: 'Stopped counting this SKU' });
}

/**
 * Take new orders off the real stock. Cheap (a few indexed lookups) and safe to
 * run as often as you like: an order line is only ever applied once.
 */
export function applyOrders() {
  const db = getDb();
  const tracked = db.prepare('SELECT sku, qty, counted_at FROM real_stock').all();
  if (!tracked.length) return { lines: 0, taken: 0, restocked: 0, restockedPieces: 0 };
  let lines = 0; let taken = 0;
  const done = db.prepare('SELECT 1 FROM stock_movements WHERE ref = ?');
  const insert = db.prepare('INSERT INTO stock_movements (ref, sku, ordered, taken) VALUES (?,?,?,?)');
  const take = db.prepare("UPDATE real_stock SET qty = qty - ?, updated_at = datetime('now') WHERE sku = ?");

  for (const t of tracked) {
    // Etsy: lines of orders placed after the count that are not cancelled - by Etsy or in this app (created_ts is unix seconds, counted_at is UTC)
    const etsy = db.prepare(`
      SELECT rt.transaction_id AS id, rt.quantity AS qty, r.created_ts AS ts
      FROM receipt_transactions rt JOIN receipts r ON r.receipt_id = rt.receipt_id
      LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
      WHERE rt.sku = ? COLLATE NOCASE AND COALESCE(r.was_canceled, 0) = 0 AND COALESCE(f.is_canceled, 0) = 0
        AND r.created_ts >= CAST(strftime('%s', ?) AS INTEGER)
      ORDER BY r.created_ts, rt.transaction_id`).all(t.sku, t.counted_at).map((r) => ({ ref: `etsy:${r.id}`, qty: r.qty, ts: r.ts }));
    const shopify = db.prepare(`
      SELECT li.line_item_id AS id, li.quantity AS qty, o.created_at_shopify AS at
      FROM shopify_order_line_items li JOIN shopify_orders o ON o.order_id = li.order_id
      LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
      WHERE li.sku = ? COLLATE NOCASE AND o.cancelled_at IS NULL AND COALESCE(f.is_canceled, 0) = 0
        AND strftime('%s', o.created_at_shopify) >= strftime('%s', ?)
      ORDER BY o.created_at_shopify, li.line_item_id`).all(t.sku, t.counted_at).map((r) => ({ ref: `shopify:${r.id}`, qty: r.qty, ts: Date.parse(r.at) / 1000 }));
    // oldest first; orders placed in the same second go in the order of their numbers
    const all = [...etsy, ...shopify].sort((a, b) => a.ts - b.ts || String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }));
    for (const line of all) {
      if (done.get(line.ref)) continue;
      const ordered = Math.max(0, Number(line.qty) || 0);
      const now = db.prepare('SELECT qty FROM real_stock WHERE sku = ?').get(t.sku).qty;
      const n = Math.min(ordered, now);   // with 0 on the shelf it was 0 and stays 0 - never below
      db.transaction(() => {
        if (n > 0) take.run(n, t.sku);
        insert.run(line.ref, t.sku, ordered, n);
        ledger({ sku: t.sku, kind: 'order', before: now, after: now - n, ref: line.ref, ordered, taken: n,
          note: n >= ordered ? 'Taken off the shelf' : n > 0 ? `Only ${n} of ${ordered} were on the shelf - order ${ordered - n} from the supplier` : `Nothing on the shelf - order ${ordered} from the supplier` });
      })();
      lines += 1; taken += n;
    }
  }
  const put = restockCancelled();
  if (lines) log.info(`${lines} new order line(s) taken off the real stock (${taken} pieces)`);
  return { lines, taken, restocked: put.lines, restockedPieces: put.pieces };
}

/**
 * An order that was taken off the real stock and then cancelled (by Etsy / Shopify, or in this app) puts its pieces
 * back - once. Not when the count was set again after the order came in: that count already holds them.
 */
export function restockCancelled() {
  const db = getDb();
  let lines = 0; let pieces = 0;
  const open = db.prepare(`
    SELECT m.ref, m.sku, m.taken,
           CASE WHEN m.ref LIKE 'etsy:%' THEN (SELECT r.created_ts FROM receipt_transactions rt JOIN receipts r ON r.receipt_id = rt.receipt_id WHERE 'etsy:' || rt.transaction_id = m.ref)
                ELSE (SELECT CAST(strftime('%s', o.created_at_shopify) AS INTEGER) FROM shopify_order_line_items li JOIN shopify_orders o ON o.order_id = li.order_id WHERE 'shopify:' || li.line_item_id = m.ref) END AS placed
    FROM stock_movements m
    WHERE m.restocked = 0 AND m.taken > 0 AND (
      EXISTS (SELECT 1 FROM receipt_transactions rt JOIN receipts r ON r.receipt_id = rt.receipt_id LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
              WHERE 'etsy:' || rt.transaction_id = m.ref AND (COALESCE(r.was_canceled, 0) = 1 OR COALESCE(f.is_canceled, 0) = 1))
      OR EXISTS (SELECT 1 FROM shopify_order_line_items li JOIN shopify_orders o ON o.order_id = li.order_id LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
              WHERE 'shopify:' || li.line_item_id = m.ref AND (o.cancelled_at IS NOT NULL OR COALESCE(f.is_canceled, 0) = 1)))`).all();
  for (const m of open) {
    const c = db.prepare('SELECT counted_at FROM real_stock WHERE sku = ?').get(m.sku);
    const counted = c ? Date.parse(`${c.counted_at.replace(' ', 'T')}Z`) / 1000 : null;
    const stillInTheCount = !c || (m.placed != null && counted != null && m.placed < counted);
    db.transaction(() => {
      const now = db.prepare('SELECT qty FROM real_stock WHERE sku = ?').get(m.sku)?.qty ?? null;
      if (!stillInTheCount) db.prepare("UPDATE real_stock SET qty = qty + ?, updated_at = datetime('now') WHERE sku = ?").run(m.taken, m.sku);
      db.prepare('UPDATE stock_movements SET restocked = ? WHERE ref = ?').run(stillInTheCount ? 2 : 1, m.ref);
      if (!stillInTheCount) ledger({ sku: m.sku, kind: 'cancel', before: now, after: (now ?? 0) + m.taken, ref: m.ref, taken: m.taken, note: 'The order was cancelled - its pieces were put back' });
      else ledger({ sku: m.sku, kind: 'cancel', before: now, after: now, ref: m.ref, taken: m.taken, note: 'The order was cancelled, but a newer count already includes its pieces - nothing added' });
    })();
    if (!stillInTheCount) { lines += 1; pieces += m.taken; audit('stock.restock', { entity: 'sku', entityId: m.sku, detail: { ref: m.ref, pieces: m.taken } }); }
  }
  if (lines) log.info(`${lines} cancelled order line(s) put back on the real stock (${pieces} pieces)`);
  return { lines, pieces };
}

/** How the real stock moved for a SKU - the order lines that took pieces off. */
export function movements(sku, limit = 30) {
  return getDb().prepare('SELECT ref, ordered, taken, restocked, at FROM stock_movements WHERE sku = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(String(sku ?? '').trim(), limit);
}

/**
 * What the real stock did for order lines - for the order desk: "from stock" (the pieces were on the shelf),
 * "short by n" (n have to be ordered from the supplier), or just how many are on the shelf now.
 * `lines` is [{ ref, sku }]; the answer is a Map(ref -> info), and a line nobody counts is left out.
 */
export function forLines(lines = []) {
  const out = new Map();
  const wanted = lines.filter((l) => l.ref);
  if (!wanted.length) return out;
  const db = getDb();
  const real = allReal();
  const moved = new Map();
  for (let i = 0; i < wanted.length; i += 400) {
    const chunk = wanted.slice(i, i + 400);
    for (const m of db.prepare(`SELECT ref, ordered, taken, restocked FROM stock_movements WHERE ref IN (${chunk.map(() => '?').join(',')})`).all(...chunk.map((l) => l.ref))) moved.set(m.ref, m);
  }
  for (const l of wanted) {
    const m = moved.get(l.ref);
    const c = l.sku ? real.get(String(l.sku).toLowerCase()) : null;
    if (m) out.set(l.ref, { ordered: m.ordered, taken: m.taken, short: Math.max(0, m.ordered - m.taken), restocked: m.restocked === 1, real: c ? c.qty : null });
    else if (c) out.set(l.ref, { ordered: null, taken: null, short: 0, real: c.qty });
  }
  return out;
}
