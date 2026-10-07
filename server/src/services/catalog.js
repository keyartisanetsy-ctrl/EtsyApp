/**
 * The catalogue of every store at once: each variant of every Etsy shop and
 * every Shopify store in one list, so a SKU or a supplier can be written for
 * all of them from one place.
 *
 * What may be changed here is deliberately small:
 *   - a variant's SKU, which is written to the store it belongs to (and the
 *     supply records kept under the old SKU follow it to the new one);
 *   - its supplier link and supplier name, which stay in this app.
 * Nothing else about a product - price, stock level, title, state - is touched
 * from here. Checking the supplier's stock is a read.
 *
 * The one thing that must never go wrong is a change landing on the wrong
 * shop. So a variant is always addressed by a key that carries its shop
 * ("etsy:111:4521", "shopify:3:gid://..."), every key is looked up and checked
 * against the shop it names before anything is sent, each write runs inside
 * that shop's own context (never "whichever shop happens to be active"), and a
 * SKU is refused if it would end up on two variants of the same shop.
 */
import { getDb, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { withShop } from '../etsy/client.js';
import { withShopifyShop } from '../shopify/client.js';
import * as stock from './stock.js';
import * as inventory from './inventory.js';
import * as shopify from './shopify.js';

const log = createLogger('catalog');

// ------------------------------------------------------------------- keys

export const variantKey = (channel, shopId, id) => `${channel}:${shopId}:${id}`;
export const shopKey = (channel, shopId) => `${channel}:${shopId}`;

/** "etsy:111:4521" -> { channel, shopId, id }. Throws on anything that is not one. */
export function parseKey(key) {
  const m = /^(etsy|shopify):(\d+):(.+)$/.exec(String(key ?? ''));
  if (!m) throw badRequest(`"${key}" is not a variant key.`);
  return { channel: m[1], shopId: Number(m[2]), id: m[3] };
}

// ------------------------------------------------------------------ shops

/** Every connected shop and store, with how many variants each has. */
export function listShops() {
  const db = getDb();
  const etsy = db.prepare('SELECT shop_id, shop_name, label, is_active FROM etsy_accounts ORDER BY id').all().map((a) => ({
    key: shopKey('etsy', a.shop_id), channel: 'etsy', shopId: a.shop_id, name: a.label || a.shop_name || `Etsy ${a.shop_id}`,
    active: !!a.is_active,
    variants: db.prepare(`SELECT COUNT(*) c FROM listing_products p JOIN listings l ON l.listing_id = p.listing_id
                          WHERE p.is_deleted = 0 AND l.shop_id = ?`).get(a.shop_id).c,
  }));
  const stores = db.prepare('SELECT id, shop_name, shop_domain, label, is_active FROM shopify_accounts ORDER BY id').all().map((a) => ({
    key: shopKey('shopify', a.id), channel: 'shopify', shopId: a.id, name: a.label || a.shop_name || a.shop_domain,
    domain: a.shop_domain, active: !!a.is_active,
    variants: db.prepare(`SELECT COUNT(*) c FROM shopify_variants v JOIN shopify_products p ON p.product_id = v.product_id
                          WHERE p.shop_id = ?`).get(a.id).c,
  }));
  return [...etsy, ...stores];
}

// -------------------------------------------------------------- the list

const norm = (s) => String(s ?? '').trim();
const isPlaceholderTitle = (t) => /^default title$/i.test(norm(t));
const shopifyNumericId = (gid) => String(gid ?? '').split('/').pop();

function etsyRows(where, params) {
  return getDb().prepare(`
    SELECT p.rowid AS ord, p.product_id, p.listing_id, p.sku, p.variation_label, p.variation_image_url, p.is_enabled, p.quantity,
           l.shop_id, l.title, l.state, l.url, l.first_image_url,
           a.shop_name, a.label,
           m.supply_link, m.variant_supply_link, m.supplier_name, m.variant_image_url
    FROM listing_products p
    JOIN listings l ON l.listing_id = p.listing_id
    LEFT JOIN etsy_accounts a ON a.shop_id = l.shop_id
    LEFT JOIN sku_meta m ON m.sku = p.sku AND m.shop_id IS l.shop_id AND p.sku <> ''
    WHERE p.is_deleted = 0 ${where}`).all(...params).map((r) => ({
    key: variantKey('etsy', r.shop_id, r.product_id),
    channel: 'etsy', shopKey: shopKey('etsy', r.shop_id), shopId: r.shop_id, shopName: r.label || r.shop_name || `Etsy ${r.shop_id}`,
    productRef: String(r.listing_id), productKey: variantKey('etsy', r.shop_id, `p${r.listing_id}`), variantRef: String(r.product_id),
    productTitle: r.title || '', productUrl: r.url || '', state: r.state || '',
    variation: norm(r.variation_label), sku: norm(r.sku), ord: r.ord, shopQty: r.quantity ?? null,
    variantImageUrl: r.variant_image_url || r.variation_image_url || '', coverUrl: r.first_image_url || '',
    supplyLink: r.supply_link || '', variantSupplyLink: r.variant_supply_link || '', supplierName: r.supplier_name || '',
  }));
}

function shopifyRows(where, params) {
  return getDb().prepare(`
    SELECT v.position AS ord, v.variant_id, v.product_id, v.title AS variant_title, v.sku, v.image_url, v.inventory_quantity,
           p.shop_id, p.title, p.status, p.first_image_url,
           a.shop_name, a.label, a.shop_domain,
           m.supply_link, m.supplier_name
    FROM shopify_variants v
    JOIN shopify_products p ON p.product_id = v.product_id
    LEFT JOIN shopify_accounts a ON a.id = p.shop_id
    LEFT JOIN shopify_variant_meta m ON m.sku = v.sku AND v.sku <> '' AND m.shop_id = p.shop_id
    WHERE 1 = 1 ${where}`).all(...params).map((r) => ({
    key: variantKey('shopify', r.shop_id, r.variant_id),
    channel: 'shopify', shopKey: shopKey('shopify', r.shop_id), shopId: r.shop_id, shopName: r.label || r.shop_name || r.shop_domain || `Shopify ${r.shop_id}`,
    productRef: r.product_id, productKey: variantKey('shopify', r.shop_id, `p${r.product_id}`), variantRef: r.variant_id,
    productTitle: r.title || '',
    productUrl: r.shop_domain ? `https://${r.shop_domain}/admin/products/${shopifyNumericId(r.product_id)}` : '',
    state: String(r.status || '').toLowerCase(),
    variation: isPlaceholderTitle(r.variant_title) ? '' : norm(r.variant_title), sku: norm(r.sku), ord: r.ord, shopQty: r.inventory_quantity ?? null,
    variantImageUrl: r.image_url || '', coverUrl: r.first_image_url || '',
    supplyLink: r.supply_link || '', variantSupplyLink: '', supplierName: r.supplier_name || '',
  }));
}

/** The groups products have been linked into, as Map("channel:shop:p<ref>" -> groupId). */
function groupIndex() {
  const out = new Map();
  for (const m of getDb().prepare('SELECT channel, shop_id, product_ref, group_id FROM product_group_members').all()) {
    out.set(variantKey(m.channel, m.shop_id, `p${m.product_ref}`), m.group_id);
  }
  return out;
}

const likeAny = (cols, term) => `(${cols.map((c) => `${c} LIKE ?`).join(' OR ')})`;

/**
 * Every variant of the chosen shops, filtered and paged. `shops` is a list of
 * shop keys ("etsy:111"); leave it out for all of them.
 */
export function variantRows({
  shops = null, search = '', missingSku = false, missingSupply = false, groupId = null, ungrouped = false,
  duplicatesOnly = false, state = '', stockFilter = '', sort = 'title', dir = 'asc', limit = 200, offset = 0,
} = {}) {
  const wanted = Array.isArray(shops) && shops.length ? new Set(shops) : null;
  const term = norm(search);
  const like = `%${term}%`;

  const eWhere = []; const eParams = [];
  const sWhere = []; const sParams = [];
  if (term) {
    eWhere.push(likeAny(['p.sku', 'l.title', 'p.variation_label', 'CAST(p.listing_id AS TEXT)'], term)); eParams.push(like, like, like, like);
    sWhere.push(likeAny(['v.sku', 'p.title', 'v.title'], term)); sParams.push(like, like, like);
  }
  if (missingSku) { eWhere.push("(p.sku IS NULL OR p.sku = '')"); sWhere.push("(v.sku IS NULL OR v.sku = '')"); }
  if (state) { eWhere.push('l.state = ?'); eParams.push(state); sWhere.push('LOWER(p.status) = ?'); sParams.push(state.toLowerCase()); }

  const wantEtsy = !wanted || [...wanted].some((k) => k.startsWith('etsy:'));
  const wantShopify = !wanted || [...wanted].some((k) => k.startsWith('shopify:'));
  let rows = [
    ...(wantEtsy ? etsyRows(eWhere.length ? `AND ${eWhere.join(' AND ')}` : '', eParams) : []),
    ...(wantShopify ? shopifyRows(sWhere.length ? `AND ${sWhere.join(' AND ')}` : '', sParams) : []),
  ];
  if (wanted) rows = rows.filter((r) => wanted.has(r.shopKey));

  const groups = groupIndex();
  for (const r of rows) r.groupId = groups.get(r.productKey) ?? null;
  // the real stock of the SKU (one count for a SKU, whichever shop sells it), and what the shop shows next to it
  const real = stock.allReal();
  for (const r of rows) {
    const c = r.sku ? real.get(r.sku.toLowerCase()) : null;
    r.realStock = c ? c.qty : null;
    r.realCountedAt = c ? c.countedAt : null;
    r.oversellRisk = !!c && c.qty === 0 && (r.shopQty ?? 0) > 0;   // the shop will sell what is not on the shelf
  }

  // Facts about the set before the finer filters, for the counters.
  const lc = (s) => s.toLowerCase();
  const counts = {
    total: rows.length,
    missingSku: rows.filter((r) => !r.sku).length,
    missingSupply: rows.filter((r) => !r.supplyLink && !r.variantSupplyLink).length,
    grouped: rows.filter((r) => r.groupId != null).length,
    realTracked: rows.filter((r) => r.realStock != null).length,
    realZero: rows.filter((r) => r.realStock === 0).length,
    oversell: rows.filter((r) => r.oversellRisk).length,
  };
  // The same SKU on two variants of one shop is nearly always a slip.
  const seen = new Map();
  for (const r of rows) if (r.sku) { const k = `${r.shopKey}|${lc(r.sku)}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  for (const r of rows) r.duplicateSku = !!r.sku && seen.get(`${r.shopKey}|${lc(r.sku)}`) > 1;
  counts.duplicates = rows.filter((r) => r.duplicateSku).length;

  if (missingSupply) rows = rows.filter((r) => !r.supplyLink && !r.variantSupplyLink);
  if (groupId != null) rows = rows.filter((r) => r.groupId === Number(groupId));
  if (ungrouped) rows = rows.filter((r) => r.groupId == null);
  if (duplicatesOnly) rows = rows.filter((r) => r.duplicateSku);
  if (stockFilter === 'oversell') rows = rows.filter((r) => r.oversellRisk);
  else if (stockFilter === 'zero') rows = rows.filter((r) => r.realStock === 0);
  else if (stockFilter === 'untracked') rows = rows.filter((r) => r.realStock == null);
  else if (stockFilter === 'tracked') rows = rows.filter((r) => r.realStock != null);

  const by = {
    title: (r) => `${lc(r.productTitle)}|${r.shopKey}|${lc(r.variation)}`,
    sku: (r) => lc(r.sku) || '￿',
    stock: (r) => String(r.realStock ?? -1).padStart(9, '0'),
    shopqty: (r) => String(r.shopQty ?? -1).padStart(9, '0'),
    shop: (r) => `${r.shopKey}|${lc(r.productTitle)}|${lc(r.variation)}`,
  }[sort] ?? ((r) => lc(r.productTitle));
  const sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  rows.sort((a, b) => (by(a) < by(b) ? -sign : by(a) > by(b) ? sign : 0));

  return { total: rows.length, counts, limit, offset, rows: rows.slice(offset, offset + limit) };
}

/** One variant by key, from the local mirror - and only if it really belongs to the shop its key names. */
export function getRow(key) {
  const { channel, shopId, id } = parseKey(key);
  const rows = channel === 'etsy'
    ? etsyRows('AND p.product_id = ? AND l.shop_id = ?', [Number(id), shopId])
    : shopifyRows('AND v.variant_id = ? AND p.shop_id = ?', [id, shopId]);
  if (!rows.length) throw notFound(`That variant is not in ${channel === 'etsy' ? 'Etsy shop' : 'Shopify store'} ${shopId}. Sync the shop first.`);
  const row = rows[0];
  row.groupId = groupIndex().get(row.productKey) ?? null;
  const c = row.sku ? stock.allReal().get(row.sku.toLowerCase()) : null;
  row.realStock = c ? c.qty : null; row.realCountedAt = c ? c.countedAt : null;
  return row;
}

/** Every product (not variant) of the chosen shops with its variants, for matching. */
export function productsOf(shops = null) {
  const { rows } = variantRows({ shops, limit: 1_000_000 });
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.productKey)) {
      byProduct.set(r.productKey, {
        key: r.productKey, channel: r.channel, shopKey: r.shopKey, shopId: r.shopId, shopName: r.shopName, ref: r.productRef,
        title: r.productTitle, url: r.productUrl, state: r.state, coverUrl: r.coverUrl, groupId: r.groupId, variants: [],
      });
    }
    byProduct.get(r.productKey).variants.push(r);
  }
  // a product's variants in the order its shop lists them (not alphabetically) - the order SKUs are numbered in
  for (const p of byProduct.values()) p.variants.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  return [...byProduct.values()];
}

// ------------------------------------------------------------ SKU rules

const MAX_SKU = { etsy: 32, shopify: 255 };

/** Why this SKU cannot be used on that channel, or null when it can. */
export function skuProblem(channel, sku) {
  const s = norm(sku);
  if (!s) return 'A SKU cannot be empty here. (To remove one, use Store products.)';
  if (s.length > (MAX_SKU[channel] ?? 255)) return `A ${channel === 'etsy' ? 'Etsy' : 'Shopify'} SKU can be at most ${MAX_SKU[channel]} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) return 'A SKU cannot contain control characters.';
  return null;
}

/** Every SKU in use anywhere, lower-cased, so a made-up SKU never repeats one. */
export function allSkus() {
  const out = new Set();
  for (const r of getDb().prepare("SELECT DISTINCT sku FROM listing_products WHERE sku IS NOT NULL AND sku <> '' AND is_deleted = 0").all()) out.add(r.sku.toLowerCase());
  for (const r of getDb().prepare("SELECT DISTINCT sku FROM shopify_variants WHERE sku IS NOT NULL AND sku <> ''").all()) out.add(r.sku.toLowerCase());
  return out;
}

// ----------------------------------------------------------- applying

/** Supply records that hang off a SKU follow it to its new name, in the shop the SKU belongs to. */
function rekeySupply(channel, shopId, oldSku, newSku) {
  if (!oldSku || !newSku || oldSku === newSku) return;
  const db = getDb();
  const move = (table, shopCol) => {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${shopCol} IS ? AND sku = ?`).get(shopId, oldSku)) return;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${shopCol} IS ? AND sku = ?`).get(shopId, newSku)) {
      db.prepare(`DELETE FROM ${table} WHERE ${shopCol} IS ? AND sku = ?`).run(shopId, oldSku); // the record already on the new SKU wins
    } else {
      db.prepare(`UPDATE ${table} SET sku = ? WHERE ${shopCol} IS ? AND sku = ?`).run(newSku, shopId, oldSku);
    }
  };
  if (channel === 'etsy') { move('sku_meta', 'shop_id'); move('supply_items', 'shop_id'); } else move('shopify_variant_meta', 'shop_id');
  // the real count belongs to the SKU, not to a shop: it follows a rename unless the new name already has one
  const count = db.prepare('SELECT 1 FROM real_stock WHERE sku = ?');
  if (count.get(oldSku) && !count.get(newSku)) db.prepare('UPDATE real_stock SET sku = ? WHERE sku = ?').run(newSku, oldSku);
}

/** The real writers: each runs inside the context of the shop it is for. */
export const liveWriters = {
  etsy: (shopId, listingId, changes) => withShop(shopId, () => inventory.updateVariations(Number(listingId), changes)),
  shopify: (storeId, productId, changes) => withShopifyShop(storeId, async () => {
    const skus = Object.fromEntries(Object.entries(changes).filter(([, c]) => c.sku !== undefined).map(([v, c]) => [v, { sku: c.sku }]));
    const quantities = Object.fromEntries(Object.entries(changes).filter(([, c]) => c.quantity !== undefined).map(([v, c]) => [v, c.quantity]));
    let res = null;
    if (Object.keys(skus).length) res = await shopify.updateVariants(productId, skus);
    if (Object.keys(quantities).length) await shopify.setQuantities(quantities);
    return res ?? { productId };
  }),
  supplier: (channel, shopId, sku, meta) => (channel === 'etsy'
    ? withShop(shopId, () => inventory.setSkuMeta(sku, meta))
    : withShopifyShop(shopId, () => shopify.saveVariantMeta(sku, meta))),
};

/**
 * Apply a list of edits. Each is { key, sku?, supplyLink?, variantSupplyLink?, supplierName? }.
 * Returns, per edit, what happened - an error on one never stops the others,
 * and a variant is only ever written to the shop its key names.
 *
 *   dryRun - work out and check everything, send nothing
 */
export async function applyChanges(edits = [], { dryRun = false, writers = liveWriters } = {}) {
  if (!Array.isArray(edits) || !edits.length) throw badRequest('Nothing to change.');
  const results = new Map();
  const fail = (key, message) => results.set(key, { key, ok: false, error: message });

  // 1. who is being changed, and is each change allowed
  const plan = [];
  for (const edit of edits) {
    let row;
    try { row = getRow(edit.key); } catch (err) { fail(edit.key, err.message); continue; }
    const item = { edit, row, newSku: null, supplier: null, newQty: null, real: undefined };

    if (edit.sku !== undefined) {
      const sku = norm(edit.sku);
      const problem = skuProblem(row.channel, sku);
      if (problem) { fail(edit.key, problem); continue; }
      if (sku !== row.sku) item.newSku = sku;
    }
    // what the shop shows (written to the shop) and what is really on the shelf (kept here, per SKU)
    if (edit.quantity !== undefined && String(edit.quantity).trim() !== '') {
      const q = Number(String(edit.quantity).trim());
      const max = row.channel === 'etsy' ? 999 : 1_000_000;
      if (!Number.isInteger(q) || q < 0 || q > max) { fail(edit.key, `The quantity a ${row.channel === 'etsy' ? 'Etsy listing' : 'Shopify store'} shows is a whole number from 0 to ${max.toLocaleString('en-US')}.`); continue; }
      if (q !== row.shopQty) item.newQty = q;
    }
    if (edit.realStock !== undefined) {
      const raw = String(edit.realStock ?? '').trim();
      if (!(item.newSku || row.sku)) { fail(edit.key, 'Give this variant a SKU first - the real stock is kept per SKU.'); continue; }
      if (raw === '') { if (row.realStock != null) item.real = null; } // blank: stop counting this SKU
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000) { fail(edit.key, 'Real stock is a whole number, 0 or more.'); continue; }
        if (n !== row.realStock) item.real = n;
      }
    }
    const meta = {};
    for (const [from, to] of [['supplyLink', 'supplyLink'], ['variantSupplyLink', 'variantSupplyLink'], ['supplierName', 'supplierName']]) {
      if (edit[from] === undefined) continue;
      if (row.channel === 'shopify' && from === 'variantSupplyLink') continue; // Shopify keeps one link per SKU
      const value = norm(edit[from]);
      if (from !== 'supplierName' && value && !/^(https?:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(value)) {
        fail(edit.key, `"${value}" does not look like a link.`); item.bad = true; break;
      }
      if (value !== norm({ supplyLink: row.supplyLink, variantSupplyLink: row.variantSupplyLink, supplierName: row.supplierName }[from])) meta[to] = value;
    }
    if (item.bad) continue;
    if (Object.keys(meta).length) {
      if (!(item.newSku || row.sku)) { fail(edit.key, 'Give this variant a SKU first - the supplier is saved against it.'); continue; }
      item.supplier = meta;
    }
    if (!item.newSku && !item.supplier && item.newQty == null && item.real === undefined) { results.set(edit.key, { key: edit.key, ok: true, unchanged: true }); continue; }
    plan.push(item);
  }

  // 2. a SKU may not end up on two variants of the same shop
  const finalSku = new Map(); // variant key -> sku after this batch
  const touchedShops = new Set(plan.filter((p) => p.newSku).map((p) => p.row.shopKey));
  const db = getDb();
  for (const shop of touchedShops) {
    const { rows } = variantRows({ shops: [shop], limit: 1_000_000 });
    const planned = new Map(plan.filter((p) => p.newSku && p.row.shopKey === shop).map((p) => [p.row.key, p.newSku]));
    const users = new Map();
    for (const r of rows) {
      const sku = planned.get(r.key) ?? r.sku;
      finalSku.set(r.key, sku);
      if (sku) { const k = sku.toLowerCase(); if (!users.has(k)) users.set(k, []); users.get(k).push(r); }
    }
    for (const p of plan) {
      if (!p.newSku || p.row.shopKey !== shop) continue;
      const others = (users.get(p.newSku.toLowerCase()) ?? []).filter((r) => r.key !== p.row.key);
      if (others.length) {
        const o = others[0];
        fail(p.edit.key, `${p.newSku} is already the SKU of "${o.productTitle}"${o.variation ? ` (${o.variation})` : ''} in ${o.shopName}. `
          + 'Two variants of one shop cannot share a SKU.');
        p.blocked = true;
      }
    }
  }
  const allowed = plan.filter((p) => !p.blocked);

  if (dryRun) {
    for (const p of allowed) {
      results.set(p.edit.key, { key: p.edit.key, ok: true, dryRun: true, shop: p.row.shopName, channel: p.row.channel,
        from: p.row.sku, sku: p.newSku ?? p.row.sku, supplier: p.supplier ?? null,
        quantity: p.newQty != null ? { from: p.row.shopQty, to: p.newQty } : null,
        real: p.real !== undefined ? { from: p.row.realStock, to: p.real } : null });
    }
    return summarize(edits, results);
  }

  // 3. SKUs, one call per product, each inside its own shop's context
  const byProduct = new Map();
  for (const p of allowed.filter((x) => x.newSku || x.newQty != null)) {
    const k = p.row.productKey;
    if (!byProduct.has(k)) byProduct.set(k, { row: p.row, items: [] });
    byProduct.get(k).items.push(p);
  }
  for (const { row, items } of byProduct.values()) {
    const changes = Object.fromEntries(items.map((p) => [p.row.variantRef, { ...(p.newSku ? { sku: p.newSku } : {}), ...(p.newQty != null ? { quantity: p.newQty } : {}) }]));
    try {
      const res = await (row.channel === 'etsy'
        ? writers.etsy(row.shopId, row.productRef, changes)
        : writers.shopify(row.shopId, row.productRef, changes));
      // Etsy answers with what it actually applied; anything it did not know about was not changed.
      const applied = row.channel === 'etsy' ? new Set((res?.applied ?? []).map((a) => String(a.product_id))) : null;
      for (const p of items) {
        if (applied && !applied.has(String(p.row.variantRef))) {
          fail(p.edit.key, 'Etsy no longer has this variation (the shop changed since the last sync). Refresh the shop and try again.');
          p.failed = true;
          continue;
        }
        if (p.newSku) {
          rekeySupply(p.row.channel, p.row.shopId, p.row.sku, p.newSku);
          audit('catalog.sku', { entity: `${p.row.channel}_variant`, entityId: p.row.variantRef, detail: { shop: p.row.shopKey, from: p.row.sku, to: p.newSku } });
        }
        if (p.newQty != null) audit('catalog.shop_quantity', { entity: `${p.row.channel}_variant`, entityId: p.row.variantRef, detail: { shop: p.row.shopKey, from: p.row.shopQty, to: p.newQty } });
      }
    } catch (err) {
      log.warn(`SKU change failed on ${row.shopName} / ${row.productTitle}: ${err.message}`);
      for (const p of items) { fail(p.edit.key, err.message); p.failed = true; }
    }
  }

  // 4. supplier details - local to this app, saved against the (new) SKU
  for (const p of allowed) {
    if (p.failed) continue;
    if (p.supplier) {
      try { writers.supplier(p.row.channel, p.row.shopId, p.newSku ?? p.row.sku, p.supplier); } catch (err) { fail(p.edit.key, err.message); continue; }
    }
    if (p.real !== undefined) {
      try { if (p.real === null) stock.clearReal(p.newSku ?? p.row.sku); else stock.setReal(p.newSku ?? p.row.sku, p.real); } catch (err) { fail(p.edit.key, err.message); continue; }
    }
    results.set(p.edit.key, { key: p.edit.key, ok: true, shop: p.row.shopName, from: p.row.sku, sku: p.newSku ?? p.row.sku, supplier: p.supplier ?? null,
      quantity: p.newQty != null ? { from: p.row.shopQty, to: p.newQty } : null, real: p.real !== undefined ? { from: p.row.realStock, to: p.real } : null });
  }
  return summarize(edits, results);
}

function summarize(edits, results) {
  const list = edits.map((e) => results.get(e.key) ?? { key: e.key, ok: false, error: 'Not processed.' });
  return {
    results: list,
    changed: list.filter((r) => r.ok && !r.unchanged).length,
    failed: list.filter((r) => !r.ok).length,
    unchanged: list.filter((r) => r.unchanged).length,
  };
}

