/**
 * Pull products/variants and orders from Shopify into the local mirror, the
 * same shape this app already uses for Etsy: sync once, then every other
 * screen reads the local tables instead of hitting the API on every click.
 */
import { getDb, json } from '../db/index.js';
import { gql } from './client.js';
import { requireShopifyShopId } from './shop.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('shopify-sync');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const firstImageOf = (media) => media?.nodes?.[0]?.image?.url ?? media?.nodes?.[0]?.preview?.image?.url ?? null;

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 40, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status vendor productType tags descriptionHtml
      featuredImage { url }
      variants(first: 100) {
        nodes {
          id title sku price compareAtPrice position inventoryQuantity
          inventoryItem { id unitCost { amount } }
          media(first: 1) { nodes { ... on MediaImage { image { url } } } }
        }
      }
    }
  }
}`;

/** Pull every product+variant for the active store. Paginates until Shopify says there is no more. */
export async function syncProducts() {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const upsertProduct = db.prepare(`
    INSERT INTO shopify_products (product_id, shop_id, title, handle, status, vendor, product_type, tags, description_html, first_image_url, raw, synced_at)
    VALUES (@id,@shopId,@title,@handle,@status,@vendor,@productType,@tags,@descriptionHtml,@firstImageUrl,@raw,datetime('now'))
    ON CONFLICT(product_id) DO UPDATE SET shop_id=excluded.shop_id, title=excluded.title, handle=excluded.handle, status=excluded.status,
      vendor=excluded.vendor, product_type=excluded.product_type, tags=excluded.tags,
      description_html=excluded.description_html, first_image_url=excluded.first_image_url,
      raw=excluded.raw, synced_at=excluded.synced_at`);
  const upsertVariant = db.prepare(`
    INSERT INTO shopify_variants (variant_id, product_id, inventory_item_id, title, sku, price_amount,
      compare_at_amount, currency, cost_amount, inventory_quantity, image_url, position, raw, synced_at)
    VALUES (@id,@productId,@inventoryItemId,@title,@sku,@price,@compareAt,@currency,@cost,@quantity,@image,@position,@raw,datetime('now'))
    ON CONFLICT(variant_id) DO UPDATE SET title=excluded.title, sku=excluded.sku, price_amount=excluded.price_amount,
      compare_at_amount=excluded.compare_at_amount, cost_amount=excluded.cost_amount,
      inventory_quantity=excluded.inventory_quantity, image_url=excluded.image_url,
      position=excluded.position, raw=excluded.raw, synced_at=excluded.synced_at`);

  let cursor = null;
  let products = 0;
  let variants = 0;
  const seenProductIds = [];
  for (;;) {
    const data = await gql(PRODUCTS_QUERY, { cursor });
    for (const p of data.products.nodes) {
      seenProductIds.push(p.id);
      upsertProduct.run({
        id: p.id, shopId, title: p.title, handle: p.handle, status: p.status, vendor: p.vendor,
        productType: p.productType, tags: json(p.tags ?? []), descriptionHtml: p.descriptionHtml ?? null,
        firstImageUrl: p.featuredImage?.url ?? null, raw: json(p),
      });
      products += 1;
      for (const v of p.variants.nodes) {
        upsertVariant.run({
          id: v.id, productId: p.id, inventoryItemId: v.inventoryItem?.id ?? null,
          title: v.title, sku: v.sku ?? '', price: num(v.price), compareAt: num(v.compareAtPrice),
          currency: null, cost: num(v.inventoryItem?.unitCost?.amount),
          // Only this variant's own media - never the product's featured
          // image standing in for it, which would make every plain variant
          // look like it has a photo of its own when it does not.
          quantity: v.inventoryQuantity ?? null, image: firstImageOf(v.media),
          position: v.position ?? null, raw: json(v),
        });
        variants += 1;
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  // A product deleted on Shopify since the last sync should not linger here -
  // scoped to this store, so syncing it never touches another store's rows.
  if (seenProductIds.length) {
    const holes = seenProductIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM shopify_products WHERE shop_id = ? AND product_id NOT IN (${holes})`).run(shopId, ...seenProductIds);
  } else {
    db.prepare('DELETE FROM shopify_products WHERE shop_id = ?').run(shopId);
  }
  log.info(`synced ${products} product(s), ${variants} variant(s)`);
  return { products, variants };
}

const ADDR_FIELDS = 'name address1 address2 city provinceCode zip countryCodeV2 phone';
const ORDERS_QUERY = `
query Orders($cursor: String) {
  orders(first: 40, after: $cursor, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name email phone note tags createdAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus
      customer { displayName phone }
      shippingAddress { ${ADDR_FIELDS} }
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      currentTotalTaxSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      discountCodes
      sourceName
      risk { assessments { riskLevel } }
      customerJourneySummary {
        firstVisit { source landingPage referrerUrl }
      }
      transactions(first: 10) {
        id kind status
        amountSet { shopMoney { amount currencyCode } }
        fees {
          type flatFeeName rateName rate
          amount { amount currencyCode }
          taxAmount { amount currencyCode }
        }
        currencyExchangeAdjustment { adjustment { amount currencyCode } }
      }
      lineItems(first: 100) {
        nodes {
          id title variantTitle sku quantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          image { url }
          product { id }
          variant { id }
        }
      }
    }
  }
}`;

/** Pull recent orders + their line items for the active store. */
export async function syncOrders({ pages = 5 } = {}) {
  const shopId = requireShopifyShopId();
  const db = getDb();
  const upsertOrder = db.prepare(`
    INSERT INTO shopify_orders (order_id, shop_id, name, email, phone, financial_status, fulfillment_status,
      currency, subtotal_amount, total_tax_amount, total_shipping_amount, total_discounts_amount, total_amount,
      refunded_amount, customer_name, ship_name, ship_address1, ship_address2, ship_city, ship_province, ship_zip,
      ship_country, ship_phone, note, tags, created_at_shopify, cancelled_at, discount_codes, risk_level,
      source_name, attribution_source, attribution_landing_page, raw, synced_at)
    VALUES (@id,@shopId,@name,@email,@phone,@financialStatus,@fulfillmentStatus,@currency,@subtotal,@tax,@shipping,
      @discounts,@total,@refunded,@customerName,@shipName,@shipAddress1,@shipAddress2,@shipCity,@shipProvince,@shipZip,
      @shipCountry,@shipPhone,@note,@tags,@createdAt,@cancelledAt,@discountCodes,@riskLevel,@sourceName,
      @attributionSource,@attributionLandingPage,@raw,datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET shop_id=excluded.shop_id, financial_status=excluded.financial_status,
      fulfillment_status=excluded.fulfillment_status, subtotal_amount=excluded.subtotal_amount,
      total_tax_amount=excluded.total_tax_amount, total_shipping_amount=excluded.total_shipping_amount,
      total_discounts_amount=excluded.total_discounts_amount, total_amount=excluded.total_amount,
      refunded_amount=excluded.refunded_amount,
      email=excluded.email, phone=excluded.phone, customer_name=excluded.customer_name,
      ship_name=excluded.ship_name, ship_address1=excluded.ship_address1, ship_address2=excluded.ship_address2,
      ship_city=excluded.ship_city, ship_province=excluded.ship_province, ship_zip=excluded.ship_zip,
      ship_country=excluded.ship_country, ship_phone=excluded.ship_phone,
      note=excluded.note, tags=excluded.tags, cancelled_at=excluded.cancelled_at,
      discount_codes=excluded.discount_codes, risk_level=excluded.risk_level, source_name=excluded.source_name,
      attribution_source=excluded.attribution_source, attribution_landing_page=excluded.attribution_landing_page,
      raw=excluded.raw, synced_at=excluded.synced_at`);
  const clearItems = db.prepare('DELETE FROM shopify_order_line_items WHERE order_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO shopify_order_line_items (line_item_id, order_id, product_id, variant_id, sku, title,
      variant_title, quantity, price_amount, currency, image_url)
    VALUES (@id,@orderId,@productId,@variantId,@sku,@title,@variantTitle,@quantity,@price,@currency,@image)`);
  const clearTxns = db.prepare('DELETE FROM shopify_order_transactions WHERE order_id = ?');
  const insertTxn = db.prepare(`
    INSERT INTO shopify_order_transactions (transaction_id, order_id, kind, status, amount, currency,
      fee_amount, fee_currency, fees_raw, created_at_shopify)
    VALUES (@id,@orderId,@kind,@status,@amount,@currency,@feeAmount,@feeCurrency,@feesRaw,@createdAt)`);

  let cursor = null;
  let orders = 0;
  let page = 0;
  for (;;) {
    const data = await gql(ORDERS_QUERY, { cursor });
    for (const o of data.orders.nodes) {
      const addr = o.shippingAddress ?? {};
      const firstVisit = o.customerJourneySummary?.firstVisit ?? null;
      upsertOrder.run({
        id: o.id, shopId, name: o.name, email: o.email ?? null, phone: o.phone ?? o.customer?.phone ?? null,
        financialStatus: o.displayFinancialStatus ?? null, fulfillmentStatus: o.displayFulfillmentStatus ?? null,
        currency: o.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
        subtotal: num(o.currentSubtotalPriceSet?.shopMoney?.amount),
        tax: num(o.currentTotalTaxSet?.shopMoney?.amount),
        shipping: num(o.totalShippingPriceSet?.shopMoney?.amount),
        discounts: num(o.totalDiscountsSet?.shopMoney?.amount),
        total: num(o.currentTotalPriceSet?.shopMoney?.amount),
        refunded: num(o.totalRefundedSet?.shopMoney?.amount),
        customerName: o.customer?.displayName ?? addr.name ?? null,
        shipName: addr.name ?? null, shipAddress1: addr.address1 ?? null, shipAddress2: addr.address2 ?? null,
        shipCity: addr.city ?? null, shipProvince: addr.provinceCode ?? null, shipZip: addr.zip ?? null,
        shipCountry: addr.countryCodeV2 ?? null, shipPhone: addr.phone ?? null,
        note: o.note ?? null, tags: json(o.tags ?? []), createdAt: o.createdAt, cancelledAt: o.cancelledAt ?? null,
        discountCodes: json(o.discountCodes ?? []),
        riskLevel: o.risk?.assessments?.[0]?.riskLevel ?? null,
        sourceName: o.sourceName ?? null,
        attributionSource: firstVisit?.source ?? null,
        attributionLandingPage: firstVisit?.landingPage ?? null,
        raw: json(o),
      });
      clearItems.run(o.id);
      for (const li of o.lineItems.nodes) {
        insertItem.run({
          id: li.id, orderId: o.id, productId: li.product?.id ?? null, variantId: li.variant?.id ?? null,
          sku: li.sku ?? '', title: li.title, variantTitle: li.variantTitle ?? '', quantity: li.quantity ?? 0,
          price: num(li.originalUnitPriceSet?.shopMoney?.amount),
          currency: li.originalUnitPriceSet?.shopMoney?.currencyCode ?? null, image: li.image?.url ?? null,
        });
      }
      clearTxns.run(o.id);
      for (const t of o.transactions ?? []) {
        // `fees` is only ever populated for Shopify Payments transactions -
        // any other gateway (PayPal, manual, etc.) reports no fee at all,
        // which is the honest answer rather than a guessed one. taxAmount is
        // VAT/GST Shopify charges on its own fee, on stores where that
        // applies - part of what actually comes off the payout, same as
        // Etsy's "VAT on seller services" ledger line. currencyExchangeAdjustment
        // is Shopify's separate cut for converting a foreign-currency charge
        // into the store's payout currency - a real deduction `fees[]` never
        // includes, and part of why this rate-card total is only ever a
        // fallback estimate: syncBalanceTransactions() below is the real number.
        const fxAdj = num(t.currencyExchangeAdjustment?.adjustment?.amount);
        const fxFee = fxAdj != null ? Math.abs(fxAdj) : 0;
        const fxCurrency = t.currencyExchangeAdjustment?.adjustment?.currencyCode ?? null;
        const feesForDisplay = fxFee
          ? [...(t.fees ?? []), { type: 'Currency conversion fee', flatFeeName: null, rateName: null, rate: null,
              amount: { amount: fxFee, currencyCode: fxCurrency }, taxAmount: null }]
          : (t.fees ?? []);
        const feeTotal = feesForDisplay.reduce((sum, f) =>
          sum + (num(f.amount?.amount) ?? 0) + (num(f.taxAmount?.amount) ?? 0), 0);
        insertTxn.run({
          id: t.id, orderId: o.id, kind: t.kind ?? null, status: t.status ?? null,
          amount: num(t.amountSet?.shopMoney?.amount), currency: t.amountSet?.shopMoney?.currencyCode ?? null,
          feeAmount: feesForDisplay.length ? feeTotal : null,
          feeCurrency: feesForDisplay[0]?.amount?.currencyCode ?? null,
          feesRaw: feesForDisplay.length ? json(feesForDisplay) : null,
          createdAt: o.createdAt,
        });
      }
      orders += 1;
    }
    page += 1;
    if (!data.orders.pageInfo.hasNextPage || page >= pages) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  log.info(`synced ${orders} order(s)`);
  return { orders };
}

// ----------------------------------------------------- balance transactions

const BALANCE_TRANSACTIONS_QUERY = `
query BalanceTransactions($cursor: String, $query: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: 50, after: $cursor, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type test sourceId sourceType sourceOrderTransactionId
        amount { amount currencyCode }
        fee { amount currencyCode }
        net { amount currencyCode }
        transactionDate
        associatedOrder { id name }
        associatedPayout { id status }
      }
    }
  }
}`;

/**
 * Shopify Payments' own balance ledger - the exact rows behind Settings >
 * Payments > Payouts > Transactions in the real Shopify admin, and the only
 * place the *actual* fee Shopify charged on a given charge lives. The rate
 * card synced onto shopify_order_transactions (syncOrders() above) only ever
 * describes what a transaction is *supposed* to cost; a Shop Cash credit, a
 * currency conversion, a dispute, or simply a different card brand than the
 * rate card assumed all change what really came off the balance, and none of
 * that is visible anywhere except here.
 *
 * `shopifyPaymentsAccount` needs the `read_shopify_payments_accounts` scope
 * (see shopify/oauth.js) - a store connected before that scope existed reads
 * back `shopifyPaymentsAccount: null` with an ACCESS_DENIED error gql()
 * already treats as "field skipped, not a hard failure" (see client.js), so
 * this quietly does nothing rather than breaking the rest of the sync;
 * reconnecting that store once picks the scope up.
 *
 * No documented cap on the `processed_at` filter's window (unlike Etsy's
 * ledger, which requires chunking into 31-day calls) - a first sync just asks
 * for everything back to `sinceDays`.
 */
export async function syncBalanceTransactions({ sinceDays = 90 } = {}) {
  const shopId = requireShopifyShopId();
  const db = getDb();

  const last = db.prepare('SELECT MAX(transaction_date) AS t FROM shopify_balance_transactions WHERE shop_id = ?')
    .get(shopId)?.t;
  const windowStart = last
    ? new Date(new Date(last).getTime() - 86_400_000)
    : new Date(Date.now() - sinceDays * 86_400_000);
  const queryFilter = `processed_at:>='${windowStart.toISOString().slice(0, 10)}'`;

  const upsert = db.prepare(`
    INSERT INTO shopify_balance_transactions (txn_id, shop_id, order_id, order_transaction_id, type, source_type,
      amount, fee, net, currency, is_test, payout_id, payout_status, transaction_date, raw, synced_at)
    VALUES (@id,@shopId,@orderId,@orderTransactionId,@type,@sourceType,@amount,@fee,@net,@currency,@isTest,
      @payoutId,@payoutStatus,@transactionDate,@raw,datetime('now'))
    ON CONFLICT(txn_id) DO UPDATE SET order_id=excluded.order_id, order_transaction_id=excluded.order_transaction_id,
      type=excluded.type, source_type=excluded.source_type, amount=excluded.amount, fee=excluded.fee, net=excluded.net,
      currency=excluded.currency, is_test=excluded.is_test, payout_id=excluded.payout_id, payout_status=excluded.payout_status,
      transaction_date=excluded.transaction_date, raw=excluded.raw, synced_at=excluded.synced_at`);

  let cursor = null;
  let total = 0;
  let sawAccount = false;
  for (;;) {
    const data = await gql(BALANCE_TRANSACTIONS_QUERY, { cursor, query: queryFilter });
    const account = data.shopifyPaymentsAccount;
    if (!account) break; // no Shopify Payments account, or the scope above is missing - nothing to read
    sawAccount = true;
    for (const n of account.balanceTransactions.nodes) {
      upsert.run({
        id: n.id, shopId, orderId: n.associatedOrder?.id ?? null,
        orderTransactionId: n.sourceOrderTransactionId != null ? `gid://shopify/OrderTransaction/${n.sourceOrderTransactionId}` : null,
        type: n.type ?? null, sourceType: n.sourceType ?? null,
        amount: num(n.amount?.amount), fee: num(n.fee?.amount), net: num(n.net?.amount),
        currency: n.amount?.currencyCode ?? n.net?.currencyCode ?? null,
        isTest: n.test ? 1 : 0, payoutId: n.associatedPayout?.id ?? null, payoutStatus: n.associatedPayout?.status ?? null,
        transactionDate: n.transactionDate, raw: json(n),
      });
      total += 1;
    }
    if (!account.balanceTransactions.pageInfo.hasNextPage) break;
    cursor = account.balanceTransactions.pageInfo.endCursor;
  }
  if (!sawAccount) {
    log.warn('shopifyPaymentsAccount not readable - missing read_shopify_payments_accounts scope, or this store has no Shopify Payments account. Reconnect the store to grant the scope.');
  } else {
    log.info(`balance transactions synced: ${total}`);
  }
  return { transactions: total, hasAccount: sawAccount };
}
