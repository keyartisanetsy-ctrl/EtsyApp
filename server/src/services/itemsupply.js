/**
 * The Taobao item and its price for one product, typed from the Packing page
 * while a parcel is in front of you: the item id (or the link) and what it costs.
 *
 * It is the product that is described, not the order, so the details are saved
 * against the SKU and reach every place the product is sold:
 *   - each Etsy shop that has the SKU gets them in its supply record (link, the
 *     exact-variant link when the link names one, the price) - Etsy has no cost
 *     field of its own, the records are what the Orders pages and the profit
 *     figures read;
 *   - each Shopify store that has the SKU gets them in its supply record too, and
 *     the price - converted into the store's currency - is written to Shopify
 *     itself as the variant's "cost per item".
 *
 * An order item is first mapped to its variation (Etsy product / Shopify variant)
 * and so to its SKU; an item that has no SKU can be given one here. Other shops
 * that already hold a different Taobao item or price for the SKU are never
 * overwritten silently: they are reported and the caller changes or keeps them.
 */
import { getDb, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { withShop } from '../etsy/client.js';
import { withShopifyShop, gql } from '../shopify/client.js';
import * as catalog from './catalog.js';
import * as inventory from './inventory.js';
import * as shopify from './shopify.js';
import * as taobao from './taobao.js';
import * as fx from './fx.js';

const log = createLogger('itemsupply');

const norm = (s) => String(s ?? '').trim();
const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------- reading input

/**
 * What was typed in the Taobao box: a bare item id (7-14 digits), a link, or the
 * text Taobao's share button produces (a link with words around it).
 */
export function parseTaobaoInput(text) {
  const raw = norm(text);
  if (!raw) return null;
  if (/^\d{6,16}$/.test(raw)) {
    const link = `https://item.taobao.com/item.htm?id=${raw}`;
    return { itemId: raw, supplier: 'taobao', link, variantLink: '', skuId: null };
  }
  const url = /https?:\/\/[^\s"'<>，。]+/i.exec(raw)?.[0] ?? (/^[\w.-]+\.[a-z]{2,}\//i.test(raw) ? raw : null);
  if (!url) {
    const id = /(?:^|[?&\s])(?:id|itemId)=(\d{6,16})/i.exec(raw)?.[1];
    if (id) return parseTaobaoInput(id);
    throw badRequest(`"${raw.slice(0, 60)}" is not a Taobao item id or link. Type the number from the link (id=…) or paste the whole link.`);
  }
  const p = taobao.parseSupplyUrl(url);
  if (!p.ok) throw badRequest(p.reason);
  if (!p.itemId) {
    throw badRequest('That link does not show the item id (short share links do not). Open it, then copy the full item link - or just type the item id number.');
  }
  const cleaned = p.cleanUrl;
  const variantLink = p.skuId && (p.supplier === 'taobao' || p.supplier === 'tmall') ? `${cleaned}&skuId=${p.skuId}` : '';
  return { itemId: p.itemId, supplier: p.supplier, link: cleaned, variantLink, skuId: p.skuId };
}

function parsePrice(price) {
  if (price === undefined || price === null || norm(price) === '') return null;
  const n = Number(norm(price).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw badRequest(`"${price}" is not a price.`);
  return Math.round(n * 10000) / 10000;
}

// ------------------------------------------------------- order item -> variant

/** The order item behind a parcel, and the shop variation it was bought as (when that is still in the shop). */
export function resolveItem(channel, itemId) {
  const db = getDb();
  if (channel === 'etsy') {
    const x = db.prepare(`
      SELECT x.transaction_id, x.sku, x.product_id, x.listing_id, x.title, x.variations, COALESCE(r.shop_id, l.shop_id) AS shop_id
      FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
      LEFT JOIN listings l ON l.listing_id = x.listing_id
      WHERE x.transaction_id = ?`).get(Number(itemId));
    if (!x) throw notFound('That order item is not in the app any more.');
    let own = null;
    if (x.product_id && x.shop_id != null) {
      try { own = catalog.getRow(catalog.variantKey('etsy', x.shop_id, x.product_id)); } catch { /* the variation left the shop */ }
    }
    return { channel, itemId: String(itemId), shopId: x.shop_id ?? null, title: x.title || '', orderSku: norm(x.sku), own };
  }
  if (channel === 'shopify') {
    const x = db.prepare(`
      SELECT x.line_item_id, x.sku, x.variant_id, x.title, x.variant_title, o.shop_id
      FROM shopify_order_line_items x JOIN shopify_orders o ON o.order_id = x.order_id
      WHERE x.line_item_id = ?`).get(String(itemId));
    if (!x) throw notFound('That order item is not in the app any more.');
    let own = null;
    if (x.variant_id && x.shop_id != null) {
      try { own = catalog.getRow(catalog.variantKey('shopify', x.shop_id, x.variant_id)); } catch { /* the variant left the store */ }
    }
    return { channel, itemId: String(itemId), shopId: x.shop_id ?? null, title: x.title || '', orderSku: norm(x.sku), own };
  }
  throw badRequest('channel must be "etsy" or "shopify".');
}

const shopLabel = (channel, shopId) => {
  const s = catalog.listShops().find((x) => x.channel === channel && x.shopId === shopId);
  return s?.name ?? `${channel === 'etsy' ? 'Etsy' : 'Shopify'} ${shopId}`;
};

/** The currency a Shopify store keeps its costs in: what its orders are in, else (asking Shopify) its own setting. */
const storeCurrencyLocal = (storeId) => getDb().prepare(
  "SELECT currency FROM shopify_orders WHERE shop_id = ? AND currency IS NOT NULL AND currency <> '' ORDER BY created_at_shopify DESC LIMIT 1").get(storeId)?.currency ?? null;

async function storeCurrency(storeId) {
  const known = storeCurrencyLocal(storeId);
  if (known) return known;
  try {
    const data = await withShopifyShop(storeId, () => gql('{ shop { currencyCode } }'));
    if (data?.shop?.currencyCode) return data.shop.currencyCode;
  } catch (err) { log.warn(`could not ask store ${storeId} for its currency: ${err.message}`); }
  return 'USD';
}

// ------------------------------------------------------------ what is saved

/** What a shop's own supply record holds for a SKU, plus (Shopify) the cost per item it shows. */
function stateOf(channel, shopId, sku, variantRef) {
  const db = getDb();
  if (channel === 'etsy') {
    const m = db.prepare('SELECT * FROM sku_meta WHERE shop_id IS ? AND sku = ?').get(shopId, sku) ?? {};
    const link = norm(m.variant_supply_link) || norm(m.supply_link);
    return {
      link: norm(m.supply_link), variantLink: norm(m.variant_supply_link),
      taobaoId: taobao.parseSupplyUrl(link || '').itemId ?? null,
      cost: m.supply_cost ?? null, currency: m.supply_currency || 'CNY', shopCost: null, shopCurrency: null,
    };
  }
  const m = db.prepare('SELECT * FROM shopify_variant_meta WHERE shop_id = ? AND sku = ?').get(shopId, sku) ?? {};
  const v = variantRef ? db.prepare('SELECT cost_amount, currency FROM shopify_variants WHERE variant_id = ?').get(variantRef) : null;
  const link = norm(m.supply_link);
  return {
    link, variantLink: '',
    taobaoId: taobao.parseSupplyUrl(link || '').itemId ?? null,
    cost: m.supply_cost ?? null, currency: m.supply_currency || 'CNY',
    shopCost: v?.cost_amount ?? null, shopCurrency: v?.currency || storeCurrencyLocal(shopId),
  };
}

/** Every place this SKU is sold: one entry per variant, with what its shop holds for it. */
function targetsFor(sku, item) {
  const rows = catalog.variantsBySku(sku);
  if (item.own && !rows.some((r) => r.key === item.own.key)) rows.unshift(item.own); // the item's variation, even when it still lacks the SKU
  const targets = rows.map((r) => ({
    key: r.key, channel: r.channel, shopId: r.shopId, shopName: r.shopName, productRef: r.productRef, variantRef: r.variantRef,
    productTitle: r.productTitle, variation: r.variation, productUrl: r.productUrl,
    sku: r.key === item.own?.key ? sku : r.sku, own: r.key === item.own?.key,
  }));
  // The order's shop with no variation left in it still gets the record - the Orders pages read it by SKU.
  if (!targets.some((t) => t.channel === item.channel && t.shopId === item.shopId) && item.shopId != null) {
    targets.push({
      key: null, channel: item.channel, shopId: item.shopId, shopName: shopLabel(item.channel, item.shopId), productRef: null, variantRef: null,
      productTitle: item.title, variation: '', productUrl: '', sku, own: true,
    });
  }
  return targets.map((t) => ({ ...t, state: stateOf(t.channel, t.shopId, t.sku, t.channel === 'shopify' ? t.variantRef : null) }));
}

/** The values to show in the form: the item's own variation first, else the first shop that has any. */
function shownOf(targets) {
  const ordered = [...targets].sort((a, b) => Number(b.own) - Number(a.own));
  const link = ordered.find((t) => t.state.taobaoId || t.state.link);
  const cost = ordered.find((t) => t.state.cost != null);
  return {
    taobaoId: link?.state.taobaoId ?? '', link: link?.state.link ?? '', variantLink: link?.state.variantLink ?? '',
    cost: cost?.state.cost ?? null, currency: cost?.state.currency ?? 'CNY',
  };
}

const sameCost = (a, ccyA, b, ccyB) => {
  if (a == null || b == null) return false;
  let x = Number(a);
  if (String(ccyA).toUpperCase() !== String(ccyB).toUpperCase()) {
    const c = fx.convert(x, ccyA, ccyB, today());
    if (c == null) return false;
    x = c;
  }
  return Math.abs(x - Number(b)) < 0.005 + Math.abs(Number(b)) * 0.0005;
};

/** Does the store's own "cost per item" already show this price (allowing for the rate having moved a little since)? */
function pushed(st, amount, ccy) {
  if (st.shopCost == null) return false;
  const want = String(ccy).toUpperCase() === String(st.shopCurrency || 'USD').toUpperCase() ? Number(amount) : fx.convert(amount, ccy, st.shopCurrency || 'USD', today());
  if (want == null) return true; // no rate to judge by: take the store's figure as it is
  return Math.abs(Number(st.shopCost) - want) <= 0.01 + want * 0.05;
}

/** What the item looks like right now: its SKU, and what every shop that sells it holds. */
export function describe(channel, itemId, { sku: typedSku = '' } = {}) {
  const item = resolveItem(channel, itemId);
  const sku = item.own?.sku || item.orderSku || norm(typedSku);
  const targets = sku ? targetsFor(sku, item) : [];
  const shown = shownOf(targets);
  const ids = new Set(targets.map((t) => t.state.taobaoId).filter(Boolean));
  const costs = targets.map((t) => t.state).filter((s) => s.cost != null);
  return {
    item: {
      channel, itemId: String(itemId), title: item.title, sku: item.own?.sku || item.orderSku || '', needsSku: !(item.own?.sku || item.orderSku),
      canSetSku: !!item.own, variation: item.own?.variation ?? '', shop: item.shopId != null ? shopLabel(channel, item.shopId) : '',
    },
    current: shown,
    // shops that disagree with each other about the item or the price
    differs: ids.size > 1 || costs.some((s) => !sameCost(s.cost, s.currency, shown.cost, shown.currency)),
    targets: targets.map((t) => ({
      key: t.key, channel: t.channel, shopName: t.shopName, productTitle: t.productTitle, variation: t.variation, productUrl: t.productUrl,
      sku: t.sku, own: t.own, taobaoId: t.state.taobaoId, link: t.state.variantLink || t.state.link, cost: t.state.cost, currency: t.state.currency,
      shopCost: t.state.shopCost, shopCurrency: t.state.shopCurrency,
    })),
  };
}

/** A short line per order item for the Packing list: what is saved for its SKU, from its own shop first. */
export function briefFor(channel, shopId, sku) {
  const s = norm(sku);
  if (!s) return null;
  const db = getDb();
  let found = null;
  const etsy = db.prepare('SELECT shop_id, supply_link, variant_supply_link, supply_cost, supply_currency FROM sku_meta WHERE sku = ? COLLATE NOCASE').all(s);
  const shop = db.prepare('SELECT shop_id, supply_link, supply_cost, supply_currency FROM shopify_variant_meta WHERE sku = ? COLLATE NOCASE').all(s);
  const all = [
    ...etsy.map((m) => ({ own: channel === 'etsy' && m.shop_id === shopId, link: m.variant_supply_link || m.supply_link, cost: m.supply_cost, currency: m.supply_currency })),
    ...shop.map((m) => ({ own: channel === 'shopify' && m.shop_id === shopId, link: m.supply_link, cost: m.supply_cost, currency: m.supply_currency })),
  ].sort((a, b) => Number(b.own) - Number(a.own));
  const withLink = all.find((m) => norm(m.link));
  const withCost = all.find((m) => m.cost != null);
  if (withLink || withCost) {
    found = { taobaoId: withLink ? taobao.parseSupplyUrl(withLink.link).itemId ?? '' : '', cost: withCost?.cost ?? null, currency: withCost?.currency || 'CNY' };
  }
  return found;
}

// ------------------------------------------------------------------- saving

/**
 * Work out, per shop, what would be written and what would be left alone - without writing anything.
 *   write.link / write.cost : this shop takes the new value
 *   conflict                : this shop holds something else the form did not show
 */
function plan(targets, { t, amount, ccy }, decision) {
  const shown = shownOf(targets);
  const conflicts = [];
  const rows = [];
  for (const tg of targets) {
    const st = tg.state;
    const row = { target: tg, write: { link: false, cost: false }, why: { link: '', cost: '' } };
    if (t) {
      const empty = !st.taobaoId && !st.link;
      const same = st.taobaoId === t.itemId;
      const knownToCaller = same || (shown.taobaoId && st.taobaoId === shown.taobaoId);
      if (empty || same) row.write.link = true;
      else if (tg.own || knownToCaller || decision === 'change') row.write.link = true;
      else {
        conflicts.push({ shop: tg.shopName, channel: tg.channel, field: 'Taobao item', current: st.taobaoId || st.link, next: t.itemId, product: tg.productTitle, variation: tg.variation });
        row.why.link = 'conflict';
      }
    }
    if (amount != null) {
      const holds = st.cost != null ? { v: st.cost, c: st.currency }
        : tg.channel === 'shopify' && st.shopCost != null ? { v: st.shopCost, c: st.shopCurrency || 'USD' } : null;
      const matches = holds != null && sameCost(holds.v, holds.c, amount, ccy);
      // Shopify must also show it as its cost per item, not only hold the figure in our record
      const inSync = tg.channel !== 'shopify' || !tg.variantRef || pushed(st, amount, ccy);
      const knownToCaller = shown.cost != null && st.cost != null && sameCost(st.cost, st.currency, shown.cost, shown.currency);
      if (matches && inSync) row.write.cost = false;
      else if (!holds || matches) row.write.cost = true;
      else if (tg.own || knownToCaller || decision === 'change') row.write.cost = true;
      else {
        conflicts.push({ shop: tg.shopName, channel: tg.channel, field: 'Price', current: `${holds.v} ${holds.c}`, next: `${amount} ${ccy}`, product: tg.productTitle, variation: tg.variation });
        row.why.cost = 'conflict';
      }
    }
    rows.push(row);
  }
  return { rows, conflicts };
}

async function costInStore(amount, ccy, storeCcy) {
  if (String(ccy).toUpperCase() === String(storeCcy).toUpperCase()) return round2(amount);
  let v = fx.convert(amount, ccy, storeCcy, today());
  if (v == null) {
    try { await fx.ensureRates(); } catch (err) { log.warn(`rates: ${err.message}`); }
    v = fx.convert(amount, ccy, storeCcy, today());
  }
  return v == null ? null : round2(v);
}

/**
 * Save the Taobao item and/or price for the item behind a parcel.
 *   decision 'check'  - write unless another shop holds something different (then report it and write nothing)
 *             'change' - write everywhere, replacing what the other shops hold
 *             'keep'   - write, but leave the shops that hold something different as they are
 */
export async function save(channel, itemId, { taobao: typed, price, currency, sku: typedSku } = {}, { decision = 'check', writers } = {}) {
  const t = parseTaobaoInput(typed);
  const amount = parsePrice(price);
  if (!t && amount == null) throw badRequest('Type the Taobao item id (or paste its link) and/or the price.');
  const ccy = (norm(currency) || 'CNY').toUpperCase().slice(0, 6);

  const item = resolveItem(channel, itemId);
  let sku = item.own?.sku || item.orderSku;
  const needsSku = !sku;
  if (needsSku) {
    sku = norm(typedSku);
    if (!sku) throw badRequest('This item has no SKU yet - type one. The Taobao item and price are saved against the SKU, so every shop that sells it gets them.');
    if (!item.own) throw badRequest('This item is not tied to a variation in the shop any more, so a SKU cannot be written to it. Give the variation a SKU on the All products page.');
    const check = await catalog.applyChanges([{ key: item.own.key, sku }], { dryRun: true, ...(writers ? { writers } : {}) });
    if (check.failed) throw badRequest(check.results[0]?.error || 'That SKU cannot be used.');
  }

  const targets = targetsFor(sku, item);
  const { rows, conflicts } = plan(targets, { t, amount, ccy }, decision);
  if (decision === 'check' && conflicts.length) return { status: 'needs_decision', conflicts, sku };

  // 1. the SKU itself, for an item that had none (written to the shop the variation belongs to)
  if (needsSku) {
    const res = await catalog.applyChanges([{ key: item.own.key, sku }], writers ? { writers } : {});
    if (res.failed) throw badRequest(res.results[0]?.error || 'The SKU could not be written.');
    const db = getDb();
    if (channel === 'etsy') db.prepare('UPDATE receipt_transactions SET sku = ? WHERE transaction_id = ?').run(sku, Number(itemId));
    else db.prepare('UPDATE shopify_order_line_items SET sku = ? WHERE line_item_id = ?').run(sku, String(itemId));
  }

  // 2. one supply record per shop, and (Shopify) the cost per item in the store itself
  const results = [];
  const warnings = [];
  const done = new Set();
  const shopifyCosts = new Map(); // "store|product" -> { storeId, productRef, changes: { variantRef: cost }, items: [...] }
  for (const row of rows) {
    const tg = row.target;
    const out = { shop: tg.shopName, channel: tg.channel, product: tg.productTitle, variation: tg.variation, link: null, price: null, shopCost: null, error: null };
    results.push(out);
    if (t) out.link = row.why.link === 'conflict' ? 'kept' : row.write.link ? 'saved' : 'same';
    if (amount != null) out.price = row.why.cost === 'conflict' ? 'kept' : row.write.cost ? 'saved' : 'same';

    const meta = {};
    if (t && row.write.link) {
      if (tg.channel === 'etsy') {
        meta.supplyLink = t.link;
        if (t.variantLink) meta.variantSupplyLink = t.variantLink;
        else if (tg.state.taobaoId !== t.itemId) meta.variantSupplyLink = ''; // an older exact-variant link belongs to another item
      } else {
        meta.supplyLink = t.variantLink || t.link; // Shopify keeps one link per SKU
      }
    }
    if (amount != null && row.write.cost) {
      meta.supplyCost = amount; meta.supplyCurrency = ccy; // our record always holds the price as typed
      if (tg.channel === 'shopify' && tg.variantRef) {
        // eslint-disable-next-line no-await-in-loop
        const storeCcy = tg.state.shopCurrency || await storeCurrency(tg.shopId);
        // eslint-disable-next-line no-await-in-loop
        const cost = await costInStore(amount, ccy, storeCcy);
        if (cost == null) {
          warnings.push(`${tg.shopName}: there is no ${ccy} to ${storeCcy} exchange rate yet, so Shopify's cost per item was not changed. Save again once rates are in.`);
          out.price = 'no rate';
        } else {
          const k = `${tg.shopId}|${tg.productRef}`;
          if (!shopifyCosts.has(k)) shopifyCosts.set(k, { storeId: tg.shopId, productRef: tg.productRef, changes: {}, items: [] });
          const g = shopifyCosts.get(k);
          g.changes[tg.variantRef] = cost;
          g.items.push({ out, tg });
          out.shopCost = `${cost} ${storeCcy}`;
        }
      }
    }
    const metaKey = `${tg.channel}:${tg.shopId}:${tg.sku}`;
    if (!Object.keys(meta).length || done.has(metaKey)) continue;
    try {
      if (tg.channel === 'etsy') withShop(tg.shopId, () => inventory.setSkuMeta(tg.sku, meta));
      else withShopifyShop(tg.shopId, () => shopify.saveVariantMeta(tg.sku, meta));
      done.add(metaKey);
    } catch (err) {
      out.error = err.message;
      log.warn(`supply record failed for ${tg.shopName} / ${tg.sku}: ${err.message}`);
    }
  }

  // 3. Shopify's cost per item, one call per product, inside that store's context (a refusal is reported and retried by the next save)
  for (const g of shopifyCosts.values()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await withShopifyShop(g.storeId, () => shopify.updateVariants(g.productRef, Object.fromEntries(Object.entries(g.changes).map(([v, c]) => [v, { cost: c }]))));
    } catch (err) {
      log.warn(`Shopify cost failed (${g.storeId}/${g.productRef}): ${err.message}`);
      for (const it of g.items) { it.out.error = `Shopify refused the cost per item: ${err.message}`; it.out.price = 'failed'; }
    }
  }

  audit('packing.item_supply', {
    entity: `${channel}_item`, entityId: String(itemId),
    detail: { sku, taobaoId: t?.itemId ?? null, price: amount, currency: ccy, decision, shops: results.length, failed: results.filter((r) => r.error).length },
  });
  const failed = results.filter((r) => r.error);
  return {
    status: failed.length && failed.length === results.length ? 'failed' : 'saved',
    sku, results, warnings, kept: conflicts.length && decision === 'keep' ? conflicts : [],
    info: describe(channel, itemId),
  };
}
