/**
 * The supply side: Taobao, 1688 and whoever else you buy from.
 *
 * This is the second app folded into this one. The point of merging them is
 * that the two halves were always about the same object - the thing you sell on
 * Etsy is the thing you buy on Taobao - and keeping them apart meant typing the
 * same SKU into two places and reconciling them by eye.
 *
 * What it does NOT do is scrape Taobao. Taobao blocks it, the pages are built
 * by script so there is nothing to read, and an app that quietly fails half the
 * time is worse than one that asks. So the flow is:
 *
 *   - you paste the item link (and the variant link, if the supplier has one);
 *   - the app pulls out the item id, the shop and the variant parameters, which
 *     are all in the URL and need no request at all;
 *   - you fill in the price and the title once, or paste them from the page;
 *   - from then on it is joined to the SKU, converted to dollars at the day's
 *     rate, and shown everywhere the product appears.
 *
 * Everything here is private. It is never sent to Etsy, and it is not part of
 * any Airtable push unless you map it yourself.
 */
import { getDb, json, parse, audit } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { badRequest, notFound } from '../lib/errors.js';
import { convert, latest } from './fx.js';
import * as undo from './undo.js';

const round2 = (n) => (n === null || n === undefined ? null : Math.round((n + Number.EPSILON) * 100) / 100);

/** The suppliers whose links we understand. */
export const SUPPLIERS = [
  { id: 'taobao', label: 'Taobao', hosts: ['item.taobao.com', 'taobao.com'] },
  { id: 'tmall', label: 'Tmall', hosts: ['detail.tmall.com', 'tmall.com'] },
  { id: '1688', label: '1688', hosts: ['detail.1688.com', '1688.com'] },
  { id: 'aliexpress', label: 'AliExpress', hosts: ['aliexpress.com', 'aliexpress.us'] },
  { id: 'alibaba', label: 'Alibaba', hosts: ['alibaba.com'] },
  { id: 'other', label: 'Other', hosts: [] },
];

/**
 * Read what a supplier URL already tells us.
 *
 * A Taobao link carries the item id in `?id=`, and often the shop and the
 * variant in `skuId` or `abbucket`. None of that needs a request, so a pasted
 * link is immediately useful even offline.
 */
export function parseSupplyUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return { ok: false, reason: 'No link given.' };

  let parsed;
  try { parsed = new URL(text.startsWith('http') ? text : `https://${text}`); }
  catch { return { ok: false, reason: 'That is not a link this app can read.' }; }

  const host = parsed.hostname.replace(/^www\./, '');
  const supplier = SUPPLIERS.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)))?.id ?? 'other';

  const q = parsed.searchParams;
  const itemId = q.get('id') || q.get('itemId') || q.get('offerId')
    // AliExpress puts it in the path: /item/1005001234567890.html
    || /\/item\/(\d{6,})/.exec(parsed.pathname)?.[1]
    || null;

  return {
    ok: true,
    supplier,
    supplierLabel: SUPPLIERS.find((s) => s.id === supplier)?.label ?? 'Other',
    host,
    itemId,
    skuId: q.get('skuId') || q.get('sku_id') || null,
    // Taobao's variant bucket, which is what makes two variant links differ.
    bucket: q.get('abbucket') || null,
    // A tidy link without the tracking rubbish, which is what to store.
    cleanUrl: itemId && (supplier === 'taobao' || supplier === 'tmall')
      ? `https://item.taobao.com/item.htm?id=${itemId}`
      : `${parsed.origin}${parsed.pathname}`,
    originalUrl: text,
  };
}

/**
 * Save (or update) a supply item and tie it to a SKU.
 *
 * Keyed by SKU, like the rest of the private supply data, so the two apps land
 * on the same row rather than on two rows that have to be reconciled.
 */
export function saveItem({ sku, url, variantUrl = '', title = '', price = null, currency = 'CNY',
  moq = null, shippingCost = null, notes = '', images = [], variantLabel = '' } = {}) {
  if (!sku) throw badRequest('A SKU is needed - the supply record hangs off it.');
  const db = getDb();
  const shopId = activeShopId();

  const main = url ? parseSupplyUrl(url) : { ok: false };
  const variant = variantUrl ? parseSupplyUrl(variantUrl) : { ok: false };
  if (url && !main.ok) throw badRequest(main.reason);
  if (variantUrl && !variant.ok) throw badRequest(variant.reason);

  const handle = undo.begin({
    label: `Supply item for ${sku}`,
    kind: 'taobao.item',
    targets: [{ table: 'supply_items', where: 'shop_id IS ? AND sku = ?', params: [shopId, sku] }],
  });

  const existing = db.prepare('SELECT * FROM supply_items WHERE shop_id IS ? AND sku = ?').get(shopId, sku) ?? {};
  const row = {
    supplier: main.supplier ?? existing.supplier ?? 'other',
    item_id: main.itemId ?? existing.item_id ?? null,
    url: main.cleanUrl ?? existing.url ?? '',
    variant_url: variant.originalUrl ?? existing.variant_url ?? '',
    variant_label: variantLabel || existing.variant_label || '',
    title: title || existing.title || '',
    price: price === null || price === '' ? existing.price ?? null : Number(price),
    currency: (currency || existing.currency || 'CNY').toUpperCase(),
    moq: moq === null || moq === '' ? existing.moq ?? null : Number(moq),
    shipping_cost: shippingCost === null || shippingCost === '' ? existing.shipping_cost ?? null : Number(shippingCost),
    notes: notes || existing.notes || '',
    images: images.length ? json(images) : existing.images ?? null,
  };

  db.prepare(`
    INSERT INTO supply_items (shop_id, sku, supplier, item_id, url, variant_url, variant_label,
      title, price, currency, moq, shipping_cost, notes, images, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(shop_id, sku) DO UPDATE SET
      supplier=excluded.supplier, item_id=excluded.item_id, url=excluded.url,
      variant_url=excluded.variant_url, variant_label=excluded.variant_label,
      title=excluded.title, price=excluded.price, currency=excluded.currency,
      moq=excluded.moq, shipping_cost=excluded.shipping_cost, notes=excluded.notes,
      images=excluded.images, updated_at=datetime('now')`)
    .run(shopId, sku, row.supplier, row.item_id, row.url, row.variant_url, row.variant_label,
      row.title, row.price, row.currency, row.moq, row.shipping_cost, row.notes, row.images);

  // Keep the SKU's own supply fields in step, so the SKU page and the order
  // desk show the same links without knowing this table exists.
  db.prepare(`
    INSERT INTO sku_meta (shop_id, sku, supply_link, variant_supply_link, supply_cost, supply_currency, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(shop_id, sku) DO UPDATE SET
      supply_link = excluded.supply_link,
      variant_supply_link = excluded.variant_supply_link,
      supply_cost = COALESCE(excluded.supply_cost, sku_meta.supply_cost),
      supply_currency = excluded.supply_currency,
      updated_at = datetime('now')`)
    .run(shopId, sku, row.url, row.variant_url, row.price, row.currency);

  undo.commit(handle, { affected: 1 });
  audit('supply.save', { entity: 'sku', entityId: sku, detail: { supplier: row.supplier, itemId: row.item_id } });
  return getItem(sku);
}

/** One supply record, with the money worked out in dollars. */
export function getItem(sku) {
  const row = getDb().prepare('SELECT * FROM supply_items WHERE shop_id IS ? AND sku = ?')
    .get(activeShopId(), sku);
  if (!row) return null;
  return decorate(row);
}

/**
 * Add the derived figures: the landed cost and what it is in dollars today.
 *
 * Converted at today's rate, and labelled as today's rate, because the yuan
 * price is what you will pay next time you order - unlike an order, which is
 * converted at its own date.
 */
function decorate(row) {
  const landed = (row.price ?? 0) + (row.shipping_cost ?? 0);
  const rateDay = latest().day;
  return {
    sku: row.sku,
    supplier: row.supplier,
    supplierLabel: SUPPLIERS.find((s) => s.id === row.supplier)?.label ?? 'Other',
    itemId: row.item_id,
    url: row.url,
    variantUrl: row.variant_url,
    variantLabel: row.variant_label,
    title: row.title,
    price: row.price,
    currency: row.currency,
    moq: row.moq,
    shippingCost: row.shipping_cost,
    landedCost: row.price == null ? null : round2(landed),
    // Money is shown to the cent. The raw conversion carries six decimals,
    // which reads like a bug on a price tag.
    priceUsd: row.price == null ? null : round2(convert(row.price, row.currency, 'USD', rateDay)),
    landedCostUsd: row.price == null ? null : round2(convert(landed, row.currency, 'USD', rateDay)),
    rateDay,
    notes: row.notes,
    images: parse(row.images, []) ?? [],
    updatedAt: row.updated_at,
  };
}

/** The whole supply book, with what each item makes you. */
export function list({ search = '', supplier = '', missingLink = false, limit = 500 } = {}) {
  const db = getDb();
  const shopId = activeShopId();
  const where = ['s.shop_id IS ?'];
  const params = [shopId];

  if (supplier) { where.push('s.supplier = ?'); params.push(supplier); }
  if (missingLink) where.push("COALESCE(s.url, '') = ''");
  if (search) {
    where.push('(s.sku LIKE ? OR s.title LIKE ? OR s.item_id LIKE ?)');
    const like = `%${search}%`; params.push(like, like, like);
  }

  const rows = db.prepare(`
    SELECT s.* FROM supply_items s
    WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ?`).all(...params, limit);

  // What each SKU sells for, so the margin is visible in the same table.
  const sellPrice = db.prepare(`
    SELECT p.sku, MAX(p.price_amount / COALESCE(p.price_divisor,100)) AS price, p.price_currency
    FROM listing_products p JOIN listings l ON l.listing_id = p.listing_id
    WHERE l.shop_id IS ? AND p.sku IS NOT NULL AND p.sku <> '' GROUP BY p.sku`).all(shopId);
  const priceBySku = new Map(sellPrice.map((r) => [r.sku, r]));

  return rows.map((r) => {
    const item = decorate(r);
    const sale = priceBySku.get(r.sku);
    const saleUsd = sale ? convert(sale.price, sale.price_currency || 'USD', 'USD', item.rateDay) : null;
    return {
      ...item,
      salePrice: sale?.price ?? null,
      saleCurrency: sale?.price_currency ?? null,
      saleUsd: round2(saleUsd),
      marginUsd: saleUsd != null && item.landedCostUsd != null
        ? round2(saleUsd - item.landedCostUsd)
        : null,
      marginPercent: saleUsd && item.landedCostUsd != null && saleUsd > 0
        ? Math.round(((saleUsd - item.landedCostUsd) / saleUsd) * 1000) / 10
        : null,
    };
  });
}

export function removeItem(sku) {
  const shopId = activeShopId();
  const handle = undo.begin({
    label: `Remove supply item for ${sku}`,
    kind: 'taobao.remove',
    targets: [{ table: 'supply_items', where: 'shop_id IS ? AND sku = ?', params: [shopId, sku] }],
  });
  const n = getDb().prepare('DELETE FROM supply_items WHERE shop_id IS ? AND sku = ?').run(shopId, sku).changes;
  undo.commit(handle, { affected: n });
  if (!n) throw notFound(`No supply record for ${sku}.`);
  return { removed: n, sku };
}

/**
 * Bring a whole sheet across in one go.
 *
 * This is the migration path from the old Taobao app: export it to two columns
 * or paste it, and every row lands against its SKU. Rows that cannot be read
 * come back with the reason rather than being dropped.
 */
export function importRows(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const saved = [];
  const errors = [];

  for (const [i, line] of lines.entries()) {
    if (/^(sku|kod|code)\b/i.test(line) && !/https?:/i.test(line)) continue; // header
    const parts = line.split(/[,;\t]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) { errors.push({ line: i + 1, text: line, reason: 'Need at least a SKU and a link' }); continue; }

    const [sku, url, variantUrl = '', price = '', currency = 'CNY'] = parts;
    if (!/^https?:/i.test(url)) { errors.push({ line: i + 1, text: line, reason: `"${url}" is not a link` }); continue; }

    try {
      saved.push(saveItem({
        sku,
        url,
        variantUrl: /^https?:/i.test(variantUrl) ? variantUrl : '',
        price: price === '' ? null : Number(String(price).replace(/[^\d.]/g, '')) || null,
        currency,
      }));
    } catch (err) {
      errors.push({ line: i + 1, text: line, reason: err.message });
    }
  }

  return {
    saved: saved.length,
    failed: errors.length,
    items: saved,
    errors,
    note: saved.length
      ? 'Each row is now joined to its SKU, so the links show on the SKU page and on every order for that product.'
      : null,
  };
}

/** How much of the catalogue has a supplier behind it. */
export function coverage() {
  const db = getDb();
  const shopId = activeShopId();
  const skus = db.prepare(`
    SELECT COUNT(DISTINCT p.sku) AS c FROM listing_products p
    JOIN listings l ON l.listing_id = p.listing_id
    WHERE l.shop_id IS ? AND p.sku IS NOT NULL AND p.sku <> ''`).get(shopId).c;
  const covered = db.prepare(`
    SELECT COUNT(*) AS c FROM supply_items WHERE shop_id IS ? AND COALESCE(url,'') <> ''`).get(shopId).c;
  const priced = db.prepare(`
    SELECT COUNT(*) AS c FROM supply_items WHERE shop_id IS ? AND price IS NOT NULL`).get(shopId).c;
  return {
    skus,
    covered,
    priced,
    missing: Math.max(0, skus - covered),
    percent: skus ? Math.round((covered / skus) * 100) : 0,
  };
}
