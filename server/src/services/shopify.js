/**
 * Shopify products, variants, orders and fulfillment - the local-mirror +
 * push-back pattern this app already uses for Etsy, applied to Shopify's
 * GraphQL Admin API.
 */
import { getDb, json, parse, audit } from '../db/index.js';
import { gql, checkUserErrors } from '../shopify/client.js';
import { syncProducts, syncOrders } from '../shopify/sync.js';
import { requireShopifyShopId } from '../shopify/shop.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { convert } from './fx.js';

const log = createLogger('shopify-svc');
export { syncProducts, syncOrders };
const round2 = (n) => (n === null || n === undefined ? null : Math.round((n + Number.EPSILON) * 100) / 100);

// ------------------------------------------------------------- products

export function listProducts({ search = '', status = '', missingSku = false, limit = 200, offset = 0 } = {}) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const where = ['p.shop_id = ?'];
  const params = [shopId];
  if (search) { where.push('(p.title LIKE ? OR v.sku LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status) { where.push('p.status = ?'); params.push(status.toUpperCase()); }
  if (missingSku) where.push("(v.sku IS NULL OR v.sku = '')");
  const clause = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT v.*, p.title AS product_title, p.handle, p.status AS product_status, p.vendor, p.product_type,
           p.first_image_url, m.supply_link, m.supplier_name, m.supply_currency, m.notes AS supply_notes
    FROM shopify_variants v
    JOIN shopify_products p ON p.product_id = v.product_id
    LEFT JOIN shopify_variant_meta m ON m.sku = v.sku AND v.sku <> '' AND m.shop_id = p.shop_id
    ${clause}
    ORDER BY p.title, v.position
    LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM shopify_variants v JOIN shopify_products p ON p.product_id = v.product_id ${clause}`)
    .get(...params).c;

  return {
    total, limit, offset,
    rows: rows.map((r) => ({
      variantId: r.variant_id, productId: r.product_id, productTitle: r.product_title, handle: r.handle,
      productStatus: r.product_status, vendor: r.vendor, productType: r.product_type,
      variantTitle: r.title, sku: r.sku || '', price: r.price_amount, compareAtPrice: r.compare_at_amount,
      cost: r.cost_amount, inventoryQuantity: r.inventory_quantity,
      // The product's own cover shot, and this variant's own photo when
      // Shopify has one for it - never one standing in for the other, so a
      // plain variant with no photo of its own shows blank, not a copy of
      // the product's picture.
      firstImageUrl: r.first_image_url || null,
      variantImageUrl: r.image_url || null,
      supplyLink: r.supply_link || '', supplierName: r.supplier_name || '', supplyCurrency: r.supply_currency || 'CNY',
      notes: r.supply_notes || '',
      margin: r.cost_amount != null && r.price_amount != null ? Math.round((r.price_amount - r.cost_amount) * 100) / 100 : null,
    })),
  };
}

export function getProduct(productId) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const p = db.prepare('SELECT * FROM shopify_products WHERE product_id = ? AND shop_id = ?').get(productId, shopId);
  if (!p) throw notFound(`Shopify product ${productId} is not in the local mirror. Sync products first.`);
  const variants = db.prepare('SELECT * FROM shopify_variants WHERE product_id = ? ORDER BY position').all(productId);
  return {
    productId: p.product_id, title: p.title, handle: p.handle, status: p.status, vendor: p.vendor,
    productType: p.product_type, tags: parse(p.tags, []), descriptionHtml: p.description_html,
    firstImageUrl: p.first_image_url,
    variants: variants.map((v) => ({
      variantId: v.variant_id, title: v.title, sku: v.sku || '', price: v.price_amount,
      compareAtPrice: v.compare_at_amount, cost: v.cost_amount, inventoryQuantity: v.inventory_quantity,
      imageUrl: v.image_url,
    })),
  };
}

const PRODUCT_UPDATE_MUTATION = `
mutation ProductUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id title descriptionHtml vendor productType tags status }
    userErrors { field message }
  }
}`;

/** Push title/description/vendor/type/tags/status back to Shopify, then re-mirror the result. */
export async function updateProduct(productId, changes = {}) {
  const input = { id: productId };
  if (changes.title !== undefined) input.title = changes.title;
  if (changes.descriptionHtml !== undefined) input.descriptionHtml = changes.descriptionHtml;
  if (changes.vendor !== undefined) input.vendor = changes.vendor;
  if (changes.productType !== undefined) input.productType = changes.productType;
  if (changes.tags !== undefined) input.tags = Array.isArray(changes.tags) ? changes.tags : String(changes.tags).split(',').map((t) => t.trim()).filter(Boolean);
  if (changes.status !== undefined) input.status = String(changes.status).toUpperCase();

  const data = await gql(PRODUCT_UPDATE_MUTATION, { product: input });
  const product = checkUserErrors(data, 'productUpdate');
  getDb().prepare(`
    UPDATE shopify_products SET title=?, description_html=?, vendor=?, product_type=?, tags=?, status=?, synced_at=datetime('now')
    WHERE product_id = ?`)
    .run(product.title, product.descriptionHtml, product.vendor, product.productType, json(product.tags ?? []), product.status, productId);
  audit('shopify.product_update', { entity: 'shopify_product', entityId: productId, detail: changes });
  return getProduct(productId);
}

const VARIANTS_BULK_UPDATE = `
mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
    productVariants { id sku price compareAtPrice inventoryItem { id unitCost { amount } } }
    userErrors { field message }
  }
}`;

/**
 * Patch SKU/price/compare-at/cost on one or more variants of one product.
 * `changes` is { [variantId]: { sku?, price?, compareAtPrice?, cost? } } -
 * Etsy's updateVariations shape, so the SKU grid can treat both the same way.
 */
export async function updateVariants(productId, changes = {}) {
  const entries = Object.entries(changes);
  if (!entries.length) throw badRequest('No variant changes to apply.');

  const variants = entries.map(([variantId, change]) => {
    const v = { id: variantId };
    if (change.price !== undefined && change.price !== null && change.price !== '') v.price = String(change.price);
    if (change.compareAtPrice !== undefined) v.compareAtPrice = change.compareAtPrice === null || change.compareAtPrice === '' ? null : String(change.compareAtPrice);
    if (change.sku !== undefined || change.cost !== undefined) {
      v.inventoryItem = {};
      if (change.sku !== undefined) v.inventoryItem.sku = change.sku === null ? '' : String(change.sku).trim();
      if (change.cost !== undefined) v.inventoryItem.cost = change.cost === null || change.cost === '' ? null : String(change.cost);
    }
    return v;
  });

  const data = await gql(VARIANTS_BULK_UPDATE, { productId, variants });
  const result = checkUserErrors(data, 'productVariantsBulkUpdate');
  const updated = result?.productVariants ?? [];

  const stmt = getDb().prepare(`
    UPDATE shopify_variants SET sku=?, price_amount=?, compare_at_amount=?, cost_amount=?, synced_at=datetime('now')
    WHERE variant_id = ?`);
  for (const v of updated) {
    stmt.run(v.sku ?? '', v.price != null ? Number(v.price) : null, v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
      v.inventoryItem?.unitCost?.amount != null ? Number(v.inventoryItem.unitCost.amount) : null, v.id);
  }
  audit('shopify.variants_update', { entity: 'shopify_product', entityId: productId, detail: { count: updated.length } });
  return { productId, updated: updated.length, variants: updated };
}

/**
 * Supply link / supplier for a Shopify SKU, the same idea as sku_meta for
 * Etsy. Merges onto whatever is already saved - a caller that only ever
 * touches one field (the Orders list inline editor sends just `supplyLink`)
 * must not blank out the others.
 */
export function saveVariantMeta(sku, meta = {}) {
  const shopId = requireShopifyShopId();
  if (!sku) throw badRequest('This variation has no SKU yet. Set one first.');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM shopify_variant_meta WHERE shop_id = ? AND sku = ?').get(shopId, sku) || {};
  const merged = {
    supply_link: meta.supplyLink ?? existing.supply_link ?? '',
    supplier_name: meta.supplierName ?? existing.supplier_name ?? '',
    supply_currency: meta.supplyCurrency ?? existing.supply_currency ?? 'CNY',
    notes: meta.notes ?? existing.notes ?? '',
  };
  db.prepare(`
    INSERT INTO shopify_variant_meta (shop_id, sku, supply_link, supplier_name, supply_currency, notes, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(shop_id, sku) DO UPDATE SET supply_link=excluded.supply_link, supplier_name=excluded.supplier_name,
      supply_currency=excluded.supply_currency, notes=excluded.notes, updated_at=excluded.updated_at`)
    .run(shopId, sku, merged.supply_link, merged.supplier_name, merged.supply_currency, merged.notes);
  return db.prepare('SELECT * FROM shopify_variant_meta WHERE shop_id = ? AND sku = ?').get(shopId, sku);
}

// --------------------------------------------------------------- orders

export function listOrders({ search = '', canceled = null, limit = 100, offset = 0 } = {}) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const where = ['o.shop_id = ?'];
  const params = [shopId];
  if (search) { where.push('(o.name LIKE ? OR o.customer_name LIKE ? OR o.email LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  // Same idea as the Etsy orders list: canceled here means either side -
  // Shopify's own cancelled_at, or a cancel applied in this app
  // (shopify_fulfillments.is_canceled). This app deliberately never calls
  // Shopify's real cancel API, even though it could, so both are equally
  // "local only". Hidden by default; canceled=true shows only those.
  const canceledExpr = "(o.cancelled_at IS NOT NULL OR COALESCE(f.is_canceled,0) = 1)";
  if (canceled === true || canceled === 'true') where.push(canceledExpr);
  else where.push(`NOT ${canceledExpr}`);
  const clause = `WHERE ${where.join(' AND ')}`;

  const base = `
    FROM shopify_orders o
    LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
    LEFT JOIN (SELECT receipt_id, MAX(last_pushed_at) AS airtable_pushed_at
               FROM airtable_links GROUP BY receipt_id) al ON al.receipt_id = o.order_id
    ${clause}`;

  const rows = db.prepare(`
    SELECT o.*, f.tracking_number, f.tracking_company, f.shipping_cost, f.shipping_cost_currency, f.pushed_at,
           f.supplier_order_ref, f.supply_tracking_number,
           COALESCE(f.is_canceled,0) AS locally_canceled, f.canceled_at, f.notes,
           f.manual_cost, f.manual_cost_note, f.supply_cost, f.supply_cost_currency,
           al.airtable_pushed_at,
           (SELECT COUNT(*) FROM shopify_order_line_items x WHERE x.order_id = o.order_id) AS item_count
    ${base}
    ORDER BY o.created_at_shopify DESC
    LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
  const supplyPreview = loadSupplyPreview(db, shopId, rows.map((r) => r.order_id));
  const txnSummary = loadTransactionSummary(db, rows.map((r) => r.order_id));
  const orderCosts = loadOrderCosts(db, rows.map((r) => r.order_id));

  return {
    total, limit, offset,
    rows: rows.map((r) => shapeOrder(r, supplyPreview.get(r.order_id), txnSummary.get(r.order_id), orderCosts.get(r.order_id))),
  };
}

/**
 * What Shopify's own transactions say actually landed on this order - the
 * charge(s) minus refund(s), minus whatever Shopify Payments fee it reported
 * (null/no fee at all on any other gateway, which is the honest answer
 * rather than a guessed one). Batched for the list the same way the supply
 * preview above is.
 */
function loadTransactionSummary(db, orderIds) {
  const map = new Map();
  if (!orderIds.length) return map;
  const holes = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT order_id, kind, amount, currency, fee_amount
    FROM shopify_order_transactions WHERE order_id IN (${holes})`).all(...orderIds);
  for (const t of rows) {
    if (!map.has(t.order_id)) map.set(t.order_id, { netAmount: 0, feeAmount: 0, hasFees: false, currency: t.currency, count: 0 });
    const s = map.get(t.order_id);
    const sign = t.kind === 'REFUND' ? -1 : (t.kind === 'SALE' || t.kind === 'CAPTURE') ? 1 : 0;
    s.netAmount += sign * (t.amount || 0);
    if (t.fee_amount != null) { s.netAmount -= t.fee_amount; s.feeAmount += t.fee_amount; s.hasFees = true; }
    s.count += 1;
  }
  return map;
}

/**
 * What this order actually cost to fulfil - same idea as Etsy's
 * loadOrderCosts(). Shipping and a REAL (invoiced) supply cost are typed in
 * next to the order in the list, in shopify_fulfillments. With no real supply
 * cost typed in yet, this falls back to Shopify's own per-variant
 * inventoryItem.unitCost ("cost per item"), clearly marked as an estimate.
 */
function loadOrderCosts(db, orderIds) {
  const map = new Map();
  if (!orderIds.length) return map;
  const holes = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT order_id, shipping_cost, shipping_cost_currency, supply_cost, supply_cost_currency
    FROM shopify_fulfillments WHERE order_id IN (${holes})`).all(...orderIds);
  for (const r of rows) {
    map.set(r.order_id, {
      shipping: r.shipping_cost, shippingCcy: r.shipping_cost_currency,
      supply: r.supply_cost, supplyCcy: r.supply_cost_currency, supplyIsEstimate: false,
    });
  }

  const needEstimate = orderIds.filter((id) => map.get(id)?.supply == null);
  if (needEstimate.length) {
    const estHoles = needEstimate.map(() => '?').join(',');
    const items = db.prepare(`
      SELECT x.order_id, x.quantity, v.cost_amount, v.currency
      FROM shopify_order_line_items x
      LEFT JOIN shopify_variants v ON v.variant_id = x.variant_id
      WHERE x.order_id IN (${estHoles}) AND v.cost_amount IS NOT NULL`).all(...needEstimate);
    for (const it of items) {
      const e = map.get(it.order_id) ?? { shipping: null, shippingCcy: null, supply: null, supplyCcy: null, supplyIsEstimate: false };
      e.supply = (e.supply ?? 0) + (it.cost_amount || 0) * (it.quantity || 1);
      e.supplyCcy = e.supplyCcy || it.currency;
      e.supplyIsEstimate = true;
      map.set(it.order_id, e);
    }
  }
  return map;
}

/**
 * Shipping + supply cost, converted into the order's own currency, plus the
 * profit left once they and any manual cost come off Shopify's own
 * transactions net. Null fields (rather than a wrong number) whenever a
 * currency has no FX rate to convert with.
 */
function orderCostBreakdown(r, txn, costs) {
  if (!costs) return { shipping: null, supply: null, profit: null };
  const shipping = costs.shipping != null ? convert(costs.shipping, costs.shippingCcy, r.currency, r.created_at_shopify) : null;
  const supply = costs.supply != null ? convert(costs.supply, costs.supplyCcy, r.currency, r.created_at_shopify) : null;
  const shippingFailed = costs.shipping != null && shipping == null;
  const supplyFailed = costs.supply != null && supply == null;

  let profit = null;
  if (txn && !shippingFailed && !supplyFailed) {
    profit = { value: round2(txn.netAmount - (shipping || 0) - (supply || 0) - (r.manual_cost || 0)), currency: txn.currency };
  }
  return {
    shipping: shipping != null ? { value: round2(shipping), currency: r.currency } : null,
    supply: supply != null ? { value: round2(supply), currency: r.currency, isEstimate: !!costs.supplyIsEstimate } : null,
    profit,
  };
}

/**
 * Same idea as the Etsy orders list: which item to show (and edit) a supply
 * link and a warehouse photo against, plus how many of the order's items
 * actually have one. The item shown is the first one that actually has a
 * link/photo, so the preview and the inline editor it feeds always agree on
 * which item they are talking about; with nothing set yet, the very first
 * item of the order is the edit target, so "add" always has somewhere to go.
 */
function loadSupplyPreview(db, shopId, orderIds) {
  const map = new Map();
  if (!orderIds.length) return map;
  const holes = orderIds.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT x.order_id, x.line_item_id, x.sku, x.warehouse_photo_id, x.image_url, m.supply_link
    FROM shopify_order_line_items x
    LEFT JOIN shopify_variant_meta m ON m.sku = x.sku AND m.shop_id = ? AND x.sku <> ''
    WHERE x.order_id IN (${holes})
    ORDER BY x.line_item_id`).all(shopId, ...orderIds);

  for (const it of items) {
    if (!map.has(it.order_id)) map.set(it.order_id, { firstItem: it, linkItem: null, linkCount: 0, photoItem: null, photoCount: 0 });
    const entry = map.get(it.order_id);
    if (it.supply_link) { entry.linkCount += 1; if (!entry.linkItem) entry.linkItem = it; }
    if (it.warehouse_photo_id) { entry.photoCount += 1; if (!entry.photoItem) entry.photoItem = it; }
  }
  return map;
}

/**
 * A best-effort read of whether this sale is attributed to Shopify's own
 * Shop app / Shop Campaigns, from the same source/attribution fields the
 * order sync already pulls. Shopify does not split ad spend down to one
 * dollar figure per order - the actual cost lives at the campaign level in
 * Shop Campaigns (Shopify.jsx's ShopCampaignsPanel) - so this only flags
 * *which* orders to credit to it, never a per-order cost.
 */
function looksLikeShopAds(sourceName, attributionSource) {
  return /\bshop[\s_-]*(campaigns?|ads?)\b/i.test(`${sourceName || ''} ${attributionSource || ''}`);
}

function shapeOrder(r, preview, txn, costs) {
  const linkItem = preview?.linkItem ?? preview?.firstItem ?? null;
  const photoItem = preview?.photoItem ?? preview?.firstItem ?? null;
  return {
    orderId: r.order_id, name: r.name, email: r.email, phone: r.phone,
    financialStatus: r.financial_status, fulfillmentStatus: r.fulfillment_status, currency: r.currency,
    subtotal: r.subtotal_amount, tax: r.total_tax_amount, shipping: r.total_shipping_amount,
    discounts: r.total_discounts_amount,
    // The order's real value, untouched - Excel/Airtable/Analytics read this
    // one. `displayTotal`/`refundedAmount` below are for the list and detail
    // screens only, same split as the Etsy side.
    total: r.total_amount,
    customerName: r.customer_name,
    shipName: r.ship_name, shipAddress1: r.ship_address1, shipAddress2: r.ship_address2, shipCity: r.ship_city,
    shipProvince: r.ship_province, shipZip: r.ship_zip, shipCountry: r.ship_country, shipPhone: r.ship_phone,
    note: r.note, tags: parse(r.tags, []), createdAt: r.created_at_shopify, cancelledAt: r.cancelled_at,
    isCanceled: !!r.cancelled_at,
    // Ours, not Shopify's - set by the "Cancel" button in this app. Shopify's
    // API could really cancel the order, but this app deliberately never
    // calls it, so this flag is the only kind of cancel that ever happens.
    isLocallyCanceled: !!r.locally_canceled,
    canceledAt: r.canceled_at ?? null,
    refundedAmount: r.refunded_amount ? { value: r.refunded_amount, currency: r.currency } : null,
    displayTotal: (r.cancelled_at || r.locally_canceled)
      ? { value: 0, currency: r.currency }
      : r.refunded_amount
        ? { value: Math.max(0, (r.total_amount ?? 0) - r.refunded_amount), currency: r.currency }
        : { value: r.total_amount, currency: r.currency },
    notes: r.notes || '',
    // What Shopify's own transactions say actually landed, after whatever
    // Shopify Payments fee it reported - null until orders have been synced
    // since transactions were added, or on a non-Shopify-Payments gateway
    // that reports no fee at all.
    realNet: txn ? { value: txn.netAmount, currency: txn.currency } : null,
    paymentFees: txn?.hasFees ? { value: txn.feeAmount, currency: txn.currency } : null,
    // See looksLikeShopAds() - attribution only, never an exact ad cost.
    isShopAdsAttributed: looksLikeShopAds(r.source_name, r.attribution_source),
    // The hand-typed cost field this flag exists for: what you actually spent
    // on this order's share of Shop Campaigns (or anything else Shopify does
    // not report per order). Kept apart from realNet, which is Shopify's own
    // numbers untouched; `netAfterManualCost` is the two combined.
    manualCost: r.manual_cost != null
      ? { value: r.manual_cost, currency: r.currency, note: r.manual_cost_note || '' }
      : null,
    netAfterManualCost: (txn && r.manual_cost != null)
      ? { value: txn.netAmount - r.manual_cost, currency: txn.currency }
      : null,
    // The full picture: what shipping and the goods themselves actually cost
    // (real figures typed in below when there are any, else a clearly-flagged
    // per-variant estimate from Shopify's own inventory cost), and what is
    // left of the transactions net once those and the manual cost above come off.
    costBreakdown: orderCostBreakdown(r, txn, costs),
    itemCount: r.item_count, trackingNumber: r.tracking_number || null, trackingCompany: r.tracking_company || null,
    shippingCost: r.shipping_cost ?? null, shippingCostCurrency: r.shipping_cost_currency ?? null,
    supplyCost: r.supply_cost ?? null, supplyCostCurrency: r.supply_cost_currency ?? null,
    pushedAt: r.pushed_at || null,
    supplierOrderRef: r.supplier_order_ref || '',
    supplyTrackingNumber: r.supply_tracking_number || '',
    // Preview of what the Items tab holds, so the list does not need opening
    // just to see - or change - whether the supply chain side of an order is
    // covered. Each carries the item (line item id + sku) the value belongs
    // to, so an inline edit on the list writes to exactly the item shown.
    supplyLink: linkItem?.supply_link || null,
    supplyLinkLineItemId: linkItem?.line_item_id ?? null,
    supplyLinkSku: linkItem?.sku || null,
    itemsWithSupplyLink: preview?.linkCount || 0,
    // Shopify resolves a line item's own image to the variant's photo already
    // when the variant has one, so there is no separate main/variant split to
    // carry here the way Etsy needs - one URL covers both.
    imageUrl: photoItem?.image_url || null,
    warehousePhotoUrl: photoItem?.warehouse_photo_id ? `/api/ai/attachments/${photoItem.warehouse_photo_id}` : null,
    warehousePhotoLineItemId: photoItem?.line_item_id ?? null,
    itemsWithPhoto: preview?.photoCount || 0,
    discountCodes: parse(r.discount_codes, []),
    riskLevel: r.risk_level || null,
    sourceName: r.source_name || null,
    attributionSource: r.attribution_source || null,
    attributionLandingPage: r.attribution_landing_page || null,
    airtablePushedAt: r.airtable_pushed_at || null,
  };
}

export function getOrder(orderId) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const o = db.prepare(`
    SELECT o.*, f.tracking_number, f.tracking_company, f.tracking_url, f.shipping_cost, f.shipping_cost_currency, f.pushed_at,
           f.supplier_order_ref, f.supply_tracking_number,
           COALESCE(f.is_canceled,0) AS locally_canceled, f.canceled_at, f.notes,
           f.manual_cost, f.manual_cost_note, f.supply_cost, f.supply_cost_currency,
           al.airtable_pushed_at
    FROM shopify_orders o LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
    LEFT JOIN (SELECT receipt_id, MAX(last_pushed_at) AS airtable_pushed_at
               FROM airtable_links GROUP BY receipt_id) al ON al.receipt_id = o.order_id
    WHERE o.order_id = ? AND o.shop_id = ?`).get(orderId, shopId);
  if (!o) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const items = db.prepare(`
    SELECT x.*, m.supply_link, m.supplier_name
    FROM shopify_order_line_items x
    LEFT JOIN shopify_variant_meta m ON m.sku = x.sku AND m.shop_id = ? AND x.sku <> ''
    WHERE x.order_id = ?`).all(shopId, orderId).map((i) => ({
    lineItemId: i.line_item_id, productId: i.product_id, variantId: i.variant_id, sku: i.sku || '',
    title: i.title, variantTitle: i.variant_title || '', quantity: i.quantity,
    price: i.price_amount, currency: i.currency, imageUrl: i.image_url,
    // The supplier's page for this SKU, from the SKUs & variations tab -
    // Shopify keeps one link per SKU, unlike Etsy's separate main/variant links.
    supplyLink: i.supply_link || '', supplierName: i.supplier_name || '',
    // A photo taken at the warehouse, held next to this same item's own
    // picture - same idea as receipt_transactions on the Etsy side.
    warehousePhotoId: i.warehouse_photo_id || null,
    warehousePhotoUrl: i.warehouse_photo_id ? `/api/ai/attachments/${i.warehouse_photo_id}` : null,
  }));

  const txnRows = db.prepare(`
    SELECT transaction_id, kind, status, amount, currency, fee_amount, fee_currency, fees_raw, created_at_shopify
    FROM shopify_order_transactions WHERE order_id = ? ORDER BY created_at_shopify`).all(orderId);
  const txnSummary = loadTransactionSummary(db, [orderId]).get(orderId);
  const transactions = txnRows.map((t) => ({
    transactionId: t.transaction_id, kind: t.kind, status: t.status,
    amount: t.amount, currency: t.currency,
    feeAmount: t.fee_amount, feeCurrency: t.fee_currency,
    // Etsy's ledger equivalent shows each fee named and rated ("6.5% of
    // item total"); Shopify's TransactionFee carries the same shape -
    // type/rate/rateName/flatFeeName - kept verbatim rather than re-labelled.
    fees: parse(t.fees_raw, []),
  }));

  const costs = loadOrderCosts(db, [orderId]).get(orderId);
  return { ...shapeOrder(o, null, txnSummary, costs), trackingUrl: o.tracking_url || null, items, transactions };
}

/** What this parcel cost to send, typed in next to the tracking number - mirrors tracking.setShippingCost. */
export function setShippingCost(orderId, { cost, currency } = {}) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const amount = cost === null || cost === undefined || cost === '' ? null : Number(cost);
  if (amount !== null && !Number.isFinite(amount)) throw badRequest(`"${cost}" is not a number.`);
  getDb().prepare(`
    INSERT INTO shopify_fulfillments (order_id, shipping_cost, shipping_cost_currency)
    VALUES (?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET shipping_cost=excluded.shipping_cost, shipping_cost_currency=excluded.shipping_cost_currency`)
    .run(orderId, amount, amount === null ? null : (currency || 'CNY').toUpperCase());
  return getOrder(orderId);
}

/** What the goods in this order actually cost, typed in next to the shipping cost - mirrors tracking.setSupplyCost. */
export function setSupplyCost(orderId, { cost, currency } = {}) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const amount = cost === null || cost === undefined || cost === '' ? null : Number(cost);
  if (amount !== null && !Number.isFinite(amount)) throw badRequest(`"${cost}" is not a number.`);
  getDb().prepare(`
    INSERT INTO shopify_fulfillments (order_id, supply_cost, supply_cost_currency)
    VALUES (?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET supply_cost=excluded.supply_cost, supply_cost_currency=excluded.supply_cost_currency`)
    .run(orderId, amount, amount === null ? null : (currency || 'CNY').toUpperCase());
  return getOrder(orderId);
}

/** The supplier's own order reference and the inbound supplier-to-warehouse
 *  tracking number - Shopify's equivalent of Etsy's order_flags fields. */
export function setSupplierInfo(orderId, { supplierOrderRef, supplyTrackingNumber } = {}) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  getDb().prepare(`
    INSERT INTO shopify_fulfillments (order_id, supplier_order_ref, supply_tracking_number)
    VALUES (?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET
      supplier_order_ref = COALESCE(excluded.supplier_order_ref, shopify_fulfillments.supplier_order_ref),
      supply_tracking_number = COALESCE(excluded.supply_tracking_number, shopify_fulfillments.supply_tracking_number)`)
    .run(orderId, supplierOrderRef ?? null, supplyTrackingNumber ?? null);
  return getOrder(orderId);
}

/**
 * Cancel/restore an order (local only - see listOrders' comment on why this
 * never calls Shopify's real cancel API), and this order's private notes.
 * Same shape and same table as setSupplierInfo above.
 */
export function setFlags(orderId, { canceled, notes } = {}) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO shopify_fulfillments (order_id) VALUES (?)').run(orderId);
  if (canceled !== undefined) {
    db.prepare(`UPDATE shopify_fulfillments SET is_canceled = ?, canceled_at = ${canceled ? "datetime('now')" : 'NULL'} WHERE order_id = ?`)
      .run(canceled ? 1 : 0, orderId);
  }
  if (notes !== undefined) {
    db.prepare('UPDATE shopify_fulfillments SET notes = ? WHERE order_id = ?').run(String(notes), orderId);
  }
  audit('shopify.order_flags', { entity: 'shopify_order', entityId: orderId, detail: { canceled, notes } });
  return getOrder(orderId);
}

/**
 * The hand-typed cost field: this order's share of Shop Campaigns spend, or
 * anything else Shopify's transactions never report per order. `amount: null`
 * clears it. Same shape as Etsy's orders.setManualCost.
 */
export function setManualCost(orderId, { amount, note } = {}) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const value = amount === null || amount === undefined || amount === '' ? null : Number(amount);
  if (value !== null && !Number.isFinite(value)) throw badRequest(`"${amount}" is not a number.`);
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO shopify_fulfillments (order_id) VALUES (?)').run(orderId);
  db.prepare('UPDATE shopify_fulfillments SET manual_cost = ?, manual_cost_note = ? WHERE order_id = ?')
    .run(value, note !== undefined ? String(note ?? '') : '', orderId);
  audit('shopify.manual_cost', { entity: 'shopify_order', entityId: orderId, detail: { amount: value, note } });
  return getOrder(orderId);
}

/**
 * Attach (or remove, with attachmentId = null) a warehouse photo to one line
 * item. Ownership runs through both the order and the shop, so a line item id
 * from another store's order can never be written to.
 */
export function setWarehousePhoto(orderId, lineItemId, attachmentId) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const owns = db.prepare(`
    SELECT 1 FROM shopify_order_line_items x JOIN shopify_orders o ON o.order_id = x.order_id
    WHERE x.line_item_id = ? AND x.order_id = ? AND o.shop_id = ?`).get(lineItemId, orderId, shopId);
  if (!owns) throw notFound(`Item ${lineItemId} is not on order ${orderId}.`);
  db.prepare('UPDATE shopify_order_line_items SET warehouse_photo_id = ? WHERE line_item_id = ?').run(attachmentId, lineItemId);
  audit('shopify.warehouse_photo', { entity: 'shopify_order', entityId: orderId, detail: { lineItemId, attachmentId } });
  return { orderId, lineItemId, warehousePhotoId: attachmentId };
}

const FULFILLMENT_ORDERS_QUERY = `
query OpenFulfillmentOrders($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 10) { nodes { id status } }
  }
}`;

const FULFILLMENT_CREATE = `
mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id trackingInfo { number url company } }
    userErrors { field message }
  }
}`;

/**
 * Add tracking to this order's still-open fulfillment order(s) and mark it
 * shipped on Shopify - the fulfillment equivalent of Etsy's "add tracking"
 * button, which also both records the number locally and pushes it.
 */
export async function pushFulfillment(orderId, { trackingNumber, trackingCompany, trackingUrl, notifyCustomer = false } = {}) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  if (!trackingNumber) throw badRequest('Enter a tracking number first.');

  const data = await gql(FULFILLMENT_ORDERS_QUERY, { id: orderId });
  const open = (data.order?.fulfillmentOrders?.nodes ?? []).filter((f) => f.status === 'OPEN' || f.status === 'IN_PROGRESS');
  if (!open.length) throw badRequest('This order has no open fulfillment - it may already be fully shipped, or has nothing left to ship.');

  const created = [];
  for (const fo of open) {
    const res = await gql(FULFILLMENT_CREATE, {
      fulfillment: {
        notifyCustomer,
        trackingInfo: { number: trackingNumber, company: trackingCompany || undefined, url: trackingUrl || undefined },
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
      },
    });
    const fulfillment = checkUserErrors(res, 'fulfillmentCreate');
    created.push(fulfillment);
  }

  getDb().prepare(`
    INSERT INTO shopify_fulfillments (order_id, fulfillment_id, tracking_number, tracking_company, tracking_url, pushed_at)
    VALUES (?,?,?,?,?, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET fulfillment_id=excluded.fulfillment_id, tracking_number=excluded.tracking_number,
      tracking_company=excluded.tracking_company, tracking_url=excluded.tracking_url, pushed_at=excluded.pushed_at`)
    .run(orderId, created[0]?.id ?? null, trackingNumber, trackingCompany || null, trackingUrl || null);

  // The order's fulfillment status changed on Shopify's side; refresh just
  // this one row rather than waiting for the next full sync (which walks
  // pages by recency and may not even reach this order).
  try {
    const fresh = await gql(`query($id: ID!) { order(id: $id) { displayFulfillmentStatus } }`, { id: orderId });
    if (fresh.order) {
      getDb().prepare('UPDATE shopify_orders SET fulfillment_status = ? WHERE order_id = ?')
        .run(fresh.order.displayFulfillmentStatus, orderId);
    }
  } catch (err) { log.warn(`could not refresh order status: ${err.message}`); }

  audit('shopify.fulfillment_push', { entity: 'shopify_order', entityId: orderId, detail: { trackingNumber, fulfillments: created.length } });
  return getOrder(orderId);
}
