/**
 * The real-stock page: one row per SKU, whichever shops sell it - its photos, the products and variants it is
 * sold as (with the link to each shop's page), the supplier, what is on the shelf - and, for one SKU, the whole
 * history of that number: every count, every order that took pieces off, every cancellation that put them back.
 */
import { getDb } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import * as catalog from './catalog.js';
import * as stock from './stock.js';

const lc = (s) => String(s ?? '').toLowerCase();
const iso = (t) => (t ? `${String(t).replace(' ', 'T')}Z` : null);

/** Every SKU with what is known about it, filtered, sorted and paged. */
export function list({ search = '', filter = '', sort = 'sku', dir = 'asc', limit = 100, offset = 0 } = {}) {
  const { rows } = catalog.variantRows({ limit: 1_000_000 });
  const real = stock.allReal();
  const lastChange = new Map(getDb().prepare(`
    SELECT l.sku, l.kind, l.at, l.delta, l.note, l.order_label FROM stock_log l
    JOIN (SELECT sku, MAX(id) AS id FROM stock_log GROUP BY sku) m ON m.id = l.id`).all().map((r) => [lc(r.sku), r]));

  const groups = new Map();
  for (const r of rows) {
    if (!r.sku) continue;
    const k = lc(r.sku);
    if (!groups.has(k)) groups.set(k, { sku: r.sku, variants: [] });
    groups.get(k).variants.push(r);
  }
  const out = [];
  const seen = new Set();
  for (const [k, g] of groups) {
    seen.add(k);
    const c = real.get(k);
    const withVariantImage = g.variants.find((v) => v.variantImageUrl);
    const supply = [];
    for (const v of g.variants) {
      for (const link of [v.variantSupplyLink, v.supplyLink]) if (link && !supply.some((s) => s.link === link)) supply.push({ link, name: v.supplierName || '', variant: link === v.variantSupplyLink });
    }
    const lastRow = lastChange.get(k);
    out.push({
      sku: g.sku, orphan: false,
      qty: c ? c.qty : null, countedAt: iso(c?.countedAt),
      coverUrl: g.variants.find((v) => v.coverUrl)?.coverUrl || '', variantImageUrl: withVariantImage?.variantImageUrl || '',
      variants: g.variants.map((v) => ({
        key: v.key, shopKey: v.shopKey, shopName: v.shopName, channel: v.channel, productTitle: v.productTitle, productUrl: v.productUrl,
        variation: v.variation, variantImageUrl: v.variantImageUrl, shopQty: v.shopQty, state: v.state,
      })),
      supply,
      oversell: !!c && c.qty === 0 && g.variants.some((v) => (v.shopQty ?? 0) > 0),
      last: lastRow ? { kind: lastRow.kind, at: iso(lastRow.at), delta: lastRow.delta, note: lastRow.note, order: lastRow.order_label } : null,
    });
  }
  for (const [k, c] of real) {   // counted SKUs no shop sells any more
    if (seen.has(k)) continue;
    const lastRow = lastChange.get(k);
    out.push({
      sku: getDb().prepare('SELECT sku FROM real_stock WHERE sku = ?').get(k)?.sku ?? k, orphan: true,
      qty: c.qty, countedAt: iso(c.countedAt), coverUrl: '', variantImageUrl: '', variants: [], supply: [], oversell: false,
      last: lastRow ? { kind: lastRow.kind, at: iso(lastRow.at), delta: lastRow.delta, note: lastRow.note, order: lastRow.order_label } : null,
    });
  }

  const counts = {
    total: out.length, counted: out.filter((r) => r.qty != null).length, zero: out.filter((r) => r.qty === 0).length,
    none: out.filter((r) => r.qty == null).length, oversell: out.filter((r) => r.oversell).length,
  };
  let list = out;
  const term = lc(search).trim();
  if (term) list = list.filter((r) => lc(r.sku).includes(term) || r.variants.some((v) => lc(v.productTitle).includes(term) || lc(v.variation).includes(term)));
  if (filter === 'counted') list = list.filter((r) => r.qty != null);
  else if (filter === 'none') list = list.filter((r) => r.qty == null);
  else if (filter === 'zero') list = list.filter((r) => r.qty === 0);
  else if (filter === 'oversell') list = list.filter((r) => r.oversell);
  else if (filter === 'orphan') list = list.filter((r) => r.orphan);

  const by = {
    sku: (r) => lc(r.sku),
    qty: (r) => String(r.qty ?? -1).padStart(9, '0'),
    changed: (r) => r.last?.at ?? '',
    title: (r) => lc(r.variants[0]?.productTitle ?? ''),
  }[sort] ?? ((r) => lc(r.sku));
  const sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  list = [...list].sort((a, b) => (by(a) < by(b) ? -sign : by(a) > by(b) ? sign : 0));
  return { total: list.length, counts, limit, offset, rows: list.slice(offset, offset + limit) };
}

/** The history of one SKU, newest first, with a summary of what happened to it. */
export function history(sku, { limit = 500 } = {}) {
  const s = String(sku ?? '').trim();
  if (!s) throw badRequest('Which SKU?');
  const db = getDb();
  const entries = db.prepare('SELECT * FROM stock_log WHERE sku = ? ORDER BY id DESC LIMIT ?').all(s, Math.min(2000, Math.max(1, Number(limit) || 500))).map((r) => ({
    id: r.id, at: iso(r.at), kind: r.kind, before: r.before_qty, after: r.after_qty, delta: r.delta,
    channel: r.channel, orderId: r.order_id, orderLabel: r.order_label, orderCode: r.order_code, buyer: r.buyer, shop: r.shop_name,
    ordered: r.ordered, taken: r.taken, short: r.kind === 'order' && r.ordered != null && r.taken != null ? Math.max(0, r.ordered - r.taken) : 0,
    note: r.note,
  }));
  const sum = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind = 'order' THEN ordered END), 0) AS ordered, COALESCE(SUM(CASE WHEN kind = 'order' THEN taken END), 0) AS taken,
           COALESCE(SUM(CASE WHEN kind = 'cancel' THEN CASE WHEN after_qty > before_qty THEN taken ELSE 0 END END), 0) AS put_back,
           SUM(kind = 'count') AS counts, SUM(kind = 'order') AS orders, SUM(kind = 'cancel') AS cancels
    FROM stock_log WHERE sku = ?`).get(s);
  const lastCount = db.prepare("SELECT at, after_qty FROM stock_log WHERE sku = ? AND kind = 'count' ORDER BY id DESC LIMIT 1").get(s);
  const c = stock.realFor(s);
  const variants = catalog.variantRows({ search: s, limit: 200 }).rows.filter((v) => lc(v.sku) === lc(s))
    .map((v) => ({ shopName: v.shopName, channel: v.channel, productTitle: v.productTitle, productUrl: v.productUrl, variation: v.variation, variantImageUrl: v.variantImageUrl, coverUrl: v.coverUrl, shopQty: v.shopQty }));
  return {
    sku: s, qty: c ? c.qty : null, countedAt: iso(c?.countedAt), variants,
    summary: {
      orders: sum.orders || 0, orderedPieces: sum.ordered, takenPieces: sum.taken, shortPieces: Math.max(0, sum.ordered - sum.taken),
      cancels: sum.cancels || 0, putBackPieces: sum.put_back, counts: sum.counts || 0,
      lastCountAt: iso(lastCount?.at), lastCountQty: lastCount?.after_qty ?? null,
    },
    entries,
  };
}
