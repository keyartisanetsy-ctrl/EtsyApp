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

const log = createLogger('shopify-svc');
export { syncProducts, syncOrders };

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
      cost: r.cost_amount, inventoryQuantity: r.inventory_quantity, imageUrl: r.image_url || r.first_image_url,
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

/** Supply link / supplier for a Shopify SKU, the same idea as sku_meta for Etsy. */
export function saveVariantMeta(sku, { supplyLink, supplierName, supplyCurrency, notes } = {}) {
  const shopId = requireShopifyShopId();
  if (!sku) throw badRequest('This variation has no SKU yet. Set one first.');
  getDb().prepare(`
    INSERT INTO shopify_variant_meta (shop_id, sku, supply_link, supplier_name, supply_currency, notes, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(shop_id, sku) DO UPDATE SET supply_link=excluded.supply_link, supplier_name=excluded.supplier_name,
      supply_currency=excluded.supply_currency, notes=excluded.notes, updated_at=excluded.updated_at`)
    .run(shopId, sku, supplyLink ?? '', supplierName ?? '', supplyCurrency ?? 'CNY', notes ?? '');
  return getDb().prepare('SELECT * FROM shopify_variant_meta WHERE shop_id = ? AND sku = ?').get(shopId, sku);
}

// --------------------------------------------------------------- orders

export function listOrders({ search = '', limit = 100, offset = 0 } = {}) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const where = ['o.shop_id = ?'];
  const params = [shopId];
  if (search) { where.push('(o.name LIKE ? OR o.customer_name LIKE ? OR o.email LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const clause = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT o.*, f.tracking_number, f.tracking_company, f.shipping_cost, f.shipping_cost_currency, f.pushed_at,
           (SELECT COUNT(*) FROM shopify_order_line_items x WHERE x.order_id = o.order_id) AS item_count
    FROM shopify_orders o
    LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
    ${clause}
    ORDER BY o.created_at_shopify DESC
    LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM shopify_orders o ${clause}`).get(...params).c;

  return {
    total, limit, offset,
    rows: rows.map((r) => shapeOrder(r)),
  };
}

function shapeOrder(r) {
  return {
    orderId: r.order_id, name: r.name, email: r.email, phone: r.phone,
    financialStatus: r.financial_status, fulfillmentStatus: r.fulfillment_status, currency: r.currency,
    subtotal: r.subtotal_amount, tax: r.total_tax_amount, shipping: r.total_shipping_amount,
    discounts: r.total_discounts_amount, total: r.total_amount, customerName: r.customer_name,
    shipName: r.ship_name, shipAddress1: r.ship_address1, shipAddress2: r.ship_address2, shipCity: r.ship_city,
    shipProvince: r.ship_province, shipZip: r.ship_zip, shipCountry: r.ship_country, shipPhone: r.ship_phone,
    note: r.note, tags: parse(r.tags, []), createdAt: r.created_at_shopify, cancelledAt: r.cancelled_at,
    itemCount: r.item_count, trackingNumber: r.tracking_number || null, trackingCompany: r.tracking_company || null,
    shippingCost: r.shipping_cost ?? null, shippingCostCurrency: r.shipping_cost_currency ?? null,
    pushedAt: r.pushed_at || null,
  };
}

export function getOrder(orderId) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const o = db.prepare(`
    SELECT o.*, f.tracking_number, f.tracking_company, f.tracking_url, f.shipping_cost, f.shipping_cost_currency, f.pushed_at
    FROM shopify_orders o LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
    WHERE o.order_id = ? AND o.shop_id = ?`).get(orderId, shopId);
  if (!o) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const items = db.prepare('SELECT * FROM shopify_order_line_items WHERE order_id = ?').all(orderId).map((i) => ({
    lineItemId: i.line_item_id, productId: i.product_id, variantId: i.variant_id, sku: i.sku || '',
    title: i.title, variantTitle: i.variant_title || '', quantity: i.quantity,
    price: i.price_amount, currency: i.currency, imageUrl: i.image_url,
  }));
  return { ...shapeOrder(o), trackingUrl: o.tracking_url || null, items };
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
