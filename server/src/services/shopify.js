/**
 * Shopify products, variants, orders and fulfillment - the local-mirror +
 * push-back pattern this app already uses for Etsy, applied to Shopify's
 * GraphQL Admin API.
 */
import { getDb, json, parse, audit } from '../db/index.js';
import { gql, checkUserErrors } from '../shopify/client.js';
import { syncProducts, syncOrders, syncBalanceTransactions } from '../shopify/sync.js';
import { requireShopifyShopId } from '../shopify/shop.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { convert } from './fx.js';

const log = createLogger('shopify-svc');
export { syncProducts, syncOrders, syncBalanceTransactions };
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
           f.manual_cost, f.manual_cost_note, f.supply_cost, f.supply_cost_currency, f.shop_ads_override,
           al.airtable_pushed_at,
           (SELECT COUNT(*) FROM shopify_order_line_items x WHERE x.order_id = o.order_id) AS item_count
    ${base}
    ORDER BY o.created_at_shopify DESC
    LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
  const supplyPreview = loadSupplyPreview(db, shopId, rows.map((r) => r.order_id));
  const txnSummary = loadTransactionSummary(db, rows.map((r) => r.order_id));
  const ledgerSummary = loadBalanceLedgerSummary(db, rows.map((r) => r.order_id));
  const orderCosts = loadOrderCosts(db, rows.map((r) => r.order_id));

  return {
    total, limit, offset,
    rows: rows.map((r) => shapeOrder(r, supplyPreview.get(r.order_id), txnSummary.get(r.order_id), orderCosts.get(r.order_id), ledgerSummary.get(r.order_id))),
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
 * Not every row Shopify posts against an order's balance-transaction ledger
 * is part of settling THAT sale. Shopify also attaches marketing/referral
 * activity (Shop Campaigns' referral fee, a promotional credit, an ads
 * publisher credit...) and other rare account-level activity to the same
 * order_id, purely for reporting/attribution. Summing every row blindly - the
 * first version of this code did - produced a "net" that could land above
 * the order's own gross amount (a promo credit inflating it) or far below
 * what any real card-processing fee could explain (a referral fee being
 * mislabelled as a "payment fee"). Three buckets instead:
 *   - settlement: the sale itself - charge/refund/dispute/chargeback and the
 *     real Shopify Payments processing fee on them. This is realNet/paymentFees.
 *   - marketing: Shop Campaigns' own referral fee and related credits - a
 *     real cost, but a marketing one, never a payment-processing fee. This is
 *     adSpend, and its mere presence is definitive proof the order came
 *     through Shop Campaigns (better evidence than the tags/source heuristic
 *     in looksLikeShopAds() below).
 *   - other: rare account-level activity (transfers, disputes-in-progress,
 *     lending, etc.) that happens to reference this order_id. Kept visible in
 *     the ledger-lines detail view, but deliberately left out of both totals
 *     above rather than guessed into either one.
 */
const SETTLEMENT_TXN_TYPES = new Set([
  'CHARGE', 'REFUND', 'REFUND_FAILURE', 'ADJUSTMENT', 'CHARGE_ADJUSTMENT', 'REFUND_ADJUSTMENT',
  'SHOP_CASH_CREDIT', 'SHOP_CASH_CREDIT_REVERSAL', 'SHOP_CASH_REFUND_DEBIT', 'SHOP_CASH_REFUND_DEBIT_REVERSAL',
  'DISPUTE_WITHDRAWAL', 'DISPUTE_REVERSAL', 'CHARGEBACK_FEE', 'CHARGEBACK_FEE_REFUND',
  'CHARGEBACK_HOLD', 'CHARGEBACK_HOLD_RELEASE', 'APPLICATION_FEE_REFUND',
  'TAX_ADJUSTMENT_DEBIT', 'TAX_ADJUSTMENT_DEBIT_REVERSAL', 'TAX_ADJUSTMENT_CREDIT', 'TAX_ADJUSTMENT_CREDIT_REVERSAL',
  'CUSTOMS_DUTY', 'CUSTOMS_DUTY_ADJUSTMENT', 'IMPORT_TAX', 'IMPORT_TAX_ADJUSTMENT', 'IMPORT_TAX_REFUND',
]);
const MARKETING_TXN_TYPES = new Set([
  'REFERRAL_FEE', 'REFERRAL_FEE_TAX',
  'CHANNEL_PROMOTION_CREDIT', 'CHANNEL_PROMOTION_CREDIT_REVERSAL',
  'CHANNEL_CREDIT', 'CHANNEL_CREDIT_REVERSAL',
  'ADS_PUBLISHER_CREDIT', 'ADS_PUBLISHER_CREDIT_REVERSAL',
  'MARKETPLACE_FEE_CREDIT', 'MARKETPLACE_FEE_CREDIT_REVERSAL',
  'SHOP_CASH_CAMPAIGN_BILLING_DEBIT', 'SHOP_CASH_CAMPAIGN_BILLING_DEBIT_REVERSAL',
  'SHOP_CASH_CAMPAIGN_BILLING_CREDIT', 'SHOP_CASH_CAMPAIGN_BILLING_CREDIT_REVERSAL',
  'PROMOTION_CREDIT', 'PROMOTION_CREDIT_REVERSAL',
]);

/**
 * Shopify Payments' own balance ledger for these orders - ground truth, the
 * same numbers Settings > Payments > Payouts > Transactions shows, unlike
 * loadTransactionSummary() above which only ever recomputes a rate-card
 * estimate. A Shop Cash credit and its matching card charge are two separate
 * rows for the same order_id here, exactly as Shopify's own payout ledger
 * lists them - summing every settlement row per order reproduces that page's
 * numbers. Empty (order not in the map) until syncBalanceTransactions() has
 * run for this store, or on a store still missing the
 * read_shopify_payments_accounts scope - financialsFor() below falls back to
 * the estimate in either case.
 */
function loadBalanceLedgerSummary(db, orderIds) {
  const map = new Map();
  if (!orderIds.length) return map;
  const holes = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT order_id, type, amount, fee, net, currency
    FROM shopify_balance_transactions WHERE order_id IN (${holes})`).all(...orderIds);
  for (const r of rows) {
    if (!map.has(r.order_id)) {
      map.set(r.order_id, {
        settlement: { grossAmount: 0, feeAmount: 0, netAmount: 0, currency: r.currency, count: 0 },
        marketing: { netAmount: 0, currency: r.currency, count: 0 },
      });
    }
    const entry = map.get(r.order_id);
    if (SETTLEMENT_TXN_TYPES.has(r.type)) {
      const s = entry.settlement;
      s.grossAmount += r.amount || 0;
      s.feeAmount += r.fee || 0;
      s.netAmount += r.net || 0;
      s.currency = s.currency || r.currency;
      s.count += 1;
    } else if (MARKETING_TXN_TYPES.has(r.type)) {
      const m = entry.marketing;
      m.netAmount += r.net || 0;
      m.currency = m.currency || r.currency;
      m.count += 1;
    }
    // Anything else (transfers, disputes-in-progress, lending, ...) is left
    // out of both totals - see the comment above SETTLEMENT_TXN_TYPES.
  }
  return map;
}

/** Every real ledger row for one order, for the detail drawer's line-by-line breakdown. */
function loadBalanceLedgerLines(db, orderId) {
  return db.prepare(`
    SELECT txn_id, type, source_type, amount, fee, net, currency, transaction_date, payout_status
    FROM shopify_balance_transactions WHERE order_id = ? ORDER BY transaction_date, txn_id`).all(orderId)
    .map((r) => ({
      txnId: r.txn_id, type: r.type, sourceType: r.source_type,
      amount: r.amount, fee: r.fee, net: r.net, currency: r.currency,
      label: prettyBalanceLabel(r.type),
      // Which total (if any) this row is folded into above - see the comment
      // above SETTLEMENT_TXN_TYPES/MARKETING_TXN_TYPES.
      category: SETTLEMENT_TXN_TYPES.has(r.type) ? 'settlement' : MARKETING_TXN_TYPES.has(r.type) ? 'marketing' : 'other',
      transactionDate: r.transaction_date, payoutStatus: r.payout_status,
    }));
}

/** "SHOP_CASH_CREDIT" -> "Shop cash credit" - formatting only, never a re-guessed meaning. */
function prettyBalanceLabel(type) {
  const raw = (type || '').trim();
  if (!raw) return 'Other';
  const words = raw.replace(/_+/g, ' ').trim().split(/\s+/);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

/**
 * What actually landed for one order: the real balance-ledger settlement
 * total when syncBalanceTransactions() has found any settlement rows for it
 * (source: 'ledger'), else the rate-card estimate from
 * shopify_order_transactions.fees (source: 'estimate') - never both mixed
 * together, so the UI can say plainly which one it is showing. Shop
 * Campaigns' own referral-fee rows never enter this figure at all - see
 * adSpendFor() below.
 */
function financialsFor(txn, ledger) {
  const settlement = ledger?.settlement;
  if (settlement && settlement.count > 0) {
    return { netAmount: round2(settlement.netAmount), feeAmount: round2(settlement.feeAmount), currency: settlement.currency, hasFees: true, source: 'ledger' };
  }
  if (txn) return { netAmount: txn.netAmount, feeAmount: txn.hasFees ? txn.feeAmount : null, currency: txn.currency, hasFees: txn.hasFees, source: 'estimate' };
  return null;
}

/**
 * What Shop Campaigns actually cost on this one order. The real referral-fee
 * ledger rows (source: 'ledger') are definitive proof the order was Shop-ads
 * attributed - far better evidence than the tags/source guess in
 * looksLikeShopAds(). With no ledger data yet, falls back to the shop's own
 * observed rule (source: 'estimate') only when something else already flags
 * the order as Shop ads (the heuristic or a manual override) - never invented
 * for an order nothing else points to.
 */
function adSpendFor(ledger, isShopAdsAttributed, totalAmount, currency) {
  // A manual "Off" always wins outright, even over a real referral-fee ledger
  // row - "cancel Shop ads for this order" means take it out of the profit
  // math entirely, not just relabel it.
  if (!isShopAdsAttributed) return null;
  const marketing = ledger?.marketing;
  if (marketing && marketing.count > 0) {
    // A referral fee is a cost (positive spend) even though the ledger's own
    // sign convention for it is negative (it reduces the balance).
    return { value: round2(Math.abs(marketing.netAmount)), currency: marketing.currency || currency, source: 'ledger' };
  }
  // The shop's own reconciled rule: over $50, Shop Campaigns always costs a
  // flat $25 - used only until the real ledger line has synced for this order.
  if (totalAmount != null && totalAmount > 50) {
    return { value: 25, currency: currency || 'USD', source: 'estimate' };
  }
  return null;
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
 * Shipping + supply cost + Shop Campaigns ad spend, converted into the
 * order's own currency, plus the profit left once they and any manual cost
 * come off Shopify's own transactions net. Null fields (rather than a wrong
 * number) whenever a currency has no FX rate to convert with.
 */
function orderCostBreakdown(r, fin, costs, adSpend) {
  // No shipping/supply data at all (a fresh order, or nothing costed yet) is
  // "nothing to subtract", not "unknown" - it must never block adSpend or
  // profit from showing when a real ledger fee or ad spend is already known.
  const shipping = costs?.shipping != null ? convert(costs.shipping, costs.shippingCcy, r.currency, r.created_at_shopify) : null;
  const supply = costs?.supply != null ? convert(costs.supply, costs.supplyCcy, r.currency, r.created_at_shopify) : null;
  const ads = adSpend != null ? convert(adSpend.value, adSpend.currency, r.currency, r.created_at_shopify) : null;
  const shippingFailed = costs?.shipping != null && shipping == null;
  const supplyFailed = costs?.supply != null && supply == null;
  const adsFailed = adSpend != null && ads == null;

  let profit = null;
  if (fin && !shippingFailed && !supplyFailed && !adsFailed) {
    profit = { value: round2(fin.netAmount - (shipping || 0) - (supply || 0) - (ads || 0) - (r.manual_cost || 0)), currency: fin.currency };
  }
  return {
    shipping: shipping != null ? { value: round2(shipping), currency: r.currency } : null,
    supply: supply != null ? { value: round2(supply), currency: r.currency, isEstimate: !!costs.supplyIsEstimate } : null,
    adSpend: ads != null ? { value: round2(ads), currency: r.currency, source: adSpend.source } : null,
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
 * Shop app / Shop Campaigns, from the source/attribution/tags fields the
 * order sync already pulls - overridden by the per-order toggle
 * (shop_ads_override) or superseded outright by a real referral-fee ledger
 * line (adSpendFor() above), whichever is available. An explicit "shop
 * campaigns"/"shop ads" mention anywhere is definitive; a bare "shop"
 * channel order that also carries any tag is treated as likely Shop ads too
 * - Shopify's Admin API has no order-level "was this an ad" flag on the
 * order itself, only this kind of indirect evidence, which is exactly why
 * the manual override and the real ledger check above exist.
 */
function looksLikeShopAds(sourceName, attributionSource, tags) {
  const haystack = `${sourceName || ''} ${attributionSource || ''} ${(tags || []).join(' ')}`;
  if (/\bshop[\s_-]*(campaigns?|ads?)\b/i.test(haystack)) return true;
  return /^shop$/i.test((sourceName || '').trim()) && (tags || []).length > 0;
}

function shapeOrder(r, preview, txn, costs, ledger) {
  const linkItem = preview?.linkItem ?? preview?.firstItem ?? null;
  const photoItem = preview?.photoItem ?? preview?.firstItem ?? null;
  const fin = financialsFor(txn, ledger);
  const tags = parse(r.tags, []);
  // shop_ads_override wins outright when set by hand; otherwise the real
  // referral-fee ledger line (if it has synced) or the tags/source heuristic
  // decides - see looksLikeShopAds() and adSpendFor() above.
  const heuristicShopAds = looksLikeShopAds(r.source_name, r.attribution_source, tags);
  const ledgerSaysShopAds = (ledger?.marketing?.count ?? 0) > 0;
  const isShopAdsAttributed = r.shop_ads_override != null ? !!r.shop_ads_override : (ledgerSaysShopAds || heuristicShopAds);
  const adSpend = adSpendFor(ledger, isShopAdsAttributed, r.total_amount, r.currency);
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
    note: r.note, tags, createdAt: r.created_at_shopify, cancelledAt: r.cancelled_at,
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
    // What actually landed on this order: Shopify Payments' own balance
    // ledger when syncBalanceTransactions() has found rows for it (the exact
    // numbers Payouts > Transactions shows - source 'ledger'), else a
    // rate-card estimate recomputed from the transaction's fees (source
    // 'estimate') - null only when this order has no Shopify Payments data
    // at all (a non-Shopify-Payments gateway, or nothing synced yet).
    realNet: fin ? { value: fin.netAmount, currency: fin.currency } : null,
    paymentFees: fin?.hasFees ? { value: fin.feeAmount, currency: fin.currency } : null,
    // 'ledger' = Shopify's own real per-charge fee (varies by card brand and
    // currency conversion); 'estimate' = this app's rate-card recomputation,
    // shown only until the real ledger has synced for this order.
    feeSource: fin?.source ?? null,
    // See looksLikeShopAds()/adSpendFor() above - 'ledger' when a real
    // referral-fee row proves it, 'override' when set by hand, else a guess
    // from tags/source ('heuristic'). adSpend (in costBreakdown below) is the
    // actual cost, when known.
    isShopAdsAttributed,
    shopAdsSource: r.shop_ads_override != null ? 'override' : ledgerSaysShopAds ? 'ledger' : heuristicShopAds ? 'heuristic' : null,
    shopAdsOverride: r.shop_ads_override == null ? null : !!r.shop_ads_override,
    // The hand-typed cost field: anything Shopify's transactions don't tie to
    // this order by themselves and that isn't Shop Campaigns ad spend (that
    // has its own line now - costBreakdown.adSpend). Kept apart from realNet,
    // which is Shopify's own numbers untouched; `netAfterManualCost` is the two combined.
    manualCost: r.manual_cost != null
      ? { value: r.manual_cost, currency: r.currency, note: r.manual_cost_note || '' }
      : null,
    netAfterManualCost: (fin && r.manual_cost != null)
      ? { value: fin.netAmount - r.manual_cost, currency: fin.currency }
      : null,
    // The full picture: what shipping, the goods themselves, and any Shop
    // Campaigns ad spend actually cost (real figures typed in/synced when
    // there are any, else a clearly-flagged estimate), and what is left of
    // the transactions net once those and the manual cost above come off.
    costBreakdown: orderCostBreakdown(r, fin, costs, adSpend),
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
           f.manual_cost, f.manual_cost_note, f.supply_cost, f.supply_cost_currency, f.shop_ads_override,
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
    // type/rate/rateName/flatFeeName, plus taxAmount for the VAT/GST Shopify
    // charges on its own fee where that applies (a Shopify Payments merchant
    // outside a VAT country never has one) - flattened here so the frontend
    // does not have to unpack GraphQL's nested amount/taxAmount objects.
    fees: parse(t.fees_raw, []).map((f) => ({
      type: f.type, flatFeeName: f.flatFeeName, rateName: f.rateName, rate: f.rate,
      amount: f.amount?.amount != null ? Number(f.amount.amount) : null,
      currency: f.amount?.currencyCode ?? null,
      taxAmount: f.taxAmount?.amount != null ? Number(f.taxAmount.amount) : null,
    })),
  }));

  const costs = loadOrderCosts(db, [orderId]).get(orderId);
  const ledgerSummary = loadBalanceLedgerSummary(db, [orderId]).get(orderId);
  const ledgerLines = loadBalanceLedgerLines(db, orderId);
  return {
    ...shapeOrder(o, null, txnSummary, costs, ledgerSummary),
    trackingUrl: o.tracking_url || null, items, transactions,
    // The real Shopify Payments ledger for this order - empty until
    // syncBalanceTransactions() has run for this store (or on a store still
    // missing the read_shopify_payments_accounts scope), in which case
    // `feeSource` above reads 'estimate' and `transactions[].fees` is what is
    // shown instead.
    ledgerLines,
  };
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
 * Force this order's Shop-ads attribution on/off by hand, overriding
 * looksLikeShopAds()'s tags/source guess (and the real referral-fee ledger
 * check, for the rare case Shopify posts one on an order that plainly isn't
 * Shop-ads, or vice versa). `override: null` goes back to automatic.
 */
export function setShopAdsOverride(orderId, override) {
  const shopId = requireShopifyShopId();
  const owns = getDb().prepare('SELECT 1 FROM shopify_orders WHERE order_id = ? AND shop_id = ?').get(orderId, shopId);
  if (!owns) throw notFound(`Shopify order ${orderId} is not in the local mirror. Sync orders first.`);
  const value = override === null || override === undefined ? null : (override ? 1 : 0);
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO shopify_fulfillments (order_id) VALUES (?)').run(orderId);
  db.prepare('UPDATE shopify_fulfillments SET shop_ads_override = ? WHERE order_id = ?').run(value, orderId);
  audit('shopify.shop_ads_override', { entity: 'shopify_order', entityId: orderId, detail: { override: value } });
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
