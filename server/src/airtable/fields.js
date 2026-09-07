/**
 * What this app can send to Airtable.
 *
 * Every field here is a stable key the mapping stores, a human label the UI
 * shows, and a resolver that turns one order (and, in per-item mode, one line
 * of that order) into a value. Adding a field here makes it available to both
 * matching modes at once - the name matcher and the AI matcher both read this
 * same list, so they can never drift apart.
 */
import { getDb } from '../db/index.js';
import { activeShopId, currentShop } from '../etsy/shop.js';
import { readSetting } from '../services/settings.js';
import { rateOn, convert } from '../services/fx.js';
import { codeFor, monthLabelTr, monthLabelEn } from '../services/ordercode.js';
import { imageForTransaction } from '../services/variantimages.js';
import { feeFor as offsiteFeeFor } from '../services/offsiteads.js';

const iso = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);
const isoDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);
const money = (amount, divisor) => (amount === null || amount === undefined ? null : amount / (divisor || 100));
const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const round6 = (n) => (n === null || n === undefined ? null : Math.round(n * 1e6) / 1e6);
/**
 * Etsy hands back HTML entities in titles and option values ("Sarah&#039;s"),
 * which look wrong in a spreadsheet. Decode the named and numeric ones.
 */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};
export function decodeEntities(text) {
  if (text === null || text === undefined) return null;
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

const clean = (s) => (s === null || s === undefined ? null : decodeEntities(String(s)));

/** Distinct, non-empty values in order, joined for the per-order row mode. */
const joinItems = (items, pick, sep = ', ') => {
  const seen = [];
  for (const it of items) {
    const v = pick(it);
    if (v !== null && v !== undefined && v !== '' && !seen.includes(v)) seen.push(v);
  }
  return seen.length ? seen.join(sep) : null;
};

const variationList = (item) => {
  let list = [];
  try { list = JSON.parse(item?.variations || '[]') || []; } catch { list = []; }
  return list;
};

/** Just what the buyer picked - "Silver / 8 US", no property titles. */
const variationValues = (item) => variationList(item)
  .map((v) => clean(v.formatted_value ?? v.value ?? ''))
  .filter(Boolean)
  .join(' / ') || null;

/** The long form, kept for anyone who does want "Colour: Silver". */
const variationPairs = (item) => variationList(item)
  .map((v) => `${clean(v.formatted_name ?? v.property_name ?? '') ?? ''}: ${clean(v.formatted_value ?? v.value ?? '') ?? ''}`.trim())
  .filter((t) => t && t !== ':')
  .join(' / ') || null;

const trackingLink = (code) => (code
  ? (readSetting('tracking.url_template') || 'https://www.yuntrack.com/parcelTracking?id={code}').replace('{code}', encodeURIComponent(code))
  : null);

/**
 * The catalogue. `group` only drives how the UI clusters the dropdown;
 * `hint` is what the AI matcher reads to understand a field it cannot infer
 * from the key alone.
 */
export const SOURCE_FIELDS = [
  // ---------------------------------------------------------------- order
  { key: 'order.id', group: 'Order', label: 'Order ID (Etsy receipt id)', hint: 'The Etsy order/receipt number, digits only, e.g. 4166419738',
    get: ({ order }) => String(order.receipt_id) },
  { key: 'order.id_hash', group: 'Order', label: 'Order ID with a # in front (rarely wanted)',
    hint: 'Only use if the sheet really wants #4166419738. The plain order.id is the normal choice.',
    get: ({ order }) => `#${order.receipt_id}` },
  { key: 'order.code', group: 'Order', label: 'Short order code (26-0709-01)',
    hint: 'A short code built from the order date and its position that day. Every item of the same order shares it.',
    get: ({ order }) => codeFor(order.receipt_id, { shopId: order.shop_id, createdTs: order.created_ts }) },
  { key: 'order.month', group: 'Order', label: 'Month of the order (2026 Eylül)',
    hint: 'The month the order arrived, Turkish, e.g. "2026 Eylül"',
    get: ({ order }) => monthLabelTr(order.created_ts) },
  { key: 'order.month_en', group: 'Order', label: 'Month of the order (September 2026)',
    hint: 'The month the order arrived, English',
    get: ({ order }) => monthLabelEn(order.created_ts) },
  { key: 'order.date', group: 'Order', label: 'Order date (YYYY-MM-DD)', hint: 'The date the order was placed, no time part',
    get: ({ order }) => isoDate(order.created_ts) },
  { key: 'order.datetime', group: 'Order', label: 'Order date and time (ISO)', hint: 'Full ISO timestamp of the order',
    get: ({ order }) => iso(order.created_ts) },
  { key: 'order.status', group: 'Order', label: 'Etsy status', hint: 'Etsy order status such as Paid, Completed, Open',
    get: ({ order }) => clean(order.status) },
  { key: 'order.is_paid', group: 'Order', label: 'Paid?', hint: 'true/false checkbox for payment received',
    get: ({ order }) => !!order.was_paid },
  { key: 'order.is_shipped', group: 'Order', label: 'Shipped?', hint: 'true/false checkbox for dispatched',
    get: ({ order }) => !!order.was_shipped },
  { key: 'order.is_gift', group: 'Order', label: 'Gift?', hint: 'true/false, buyer marked the order as a gift',
    get: ({ order }) => !!order.is_gift },
  { key: 'order.gift_message', group: 'Order', label: 'Gift message', hint: 'The gift note the buyer wrote',
    get: ({ order }) => clean(order.gift_message) },
  { key: 'order.buyer_message', group: 'Order', label: 'Buyer note / message', hint: 'Free-text note the buyer left with the order',
    get: ({ order }) => clean(order.message_from_buyer) },
  { key: 'order.item_count', group: 'Order', label: 'Number of lines in the order', hint: 'How many distinct items this order contains',
    get: ({ items }) => items.length },
  { key: 'order.etsy_url', group: 'Order', label: 'Etsy order link', hint: 'Deep link to this order in the Etsy seller dashboard',
    get: ({ order }) => `https://www.etsy.com/your/orders/sold?order_id=${order.receipt_id}` },

  // --------------------------------------------------------------- totals
  { key: 'total.grand', group: 'Totals', label: 'Order total', hint: 'What the buyer paid in total, as a number',
    get: ({ order }) => money(order.grandtotal_amount, order.grandtotal_divisor) },
  { key: 'total.subtotal', group: 'Totals', label: 'Subtotal', hint: 'Items subtotal before shipping and tax',
    get: ({ order }) => money(order.subtotal_amount, order.grandtotal_divisor) },
  { key: 'total.shipping', group: 'Totals', label: 'Shipping charged', hint: 'Shipping the buyer paid',
    get: ({ order }) => money(order.total_shipping_amount, order.grandtotal_divisor) },
  { key: 'total.tax', group: 'Totals', label: 'Tax', hint: 'Tax collected on the order',
    get: ({ order }) => money(order.total_tax_amount, order.grandtotal_divisor) },
  { key: 'total.discount', group: 'Totals', label: 'Discount', hint: 'Discount applied to the order',
    get: ({ order }) => money(order.discount_amount, order.grandtotal_divisor) },
  { key: 'total.currency', group: 'Totals', label: 'Currency code', hint: 'Currency of the totals, e.g. USD, TRY',
    get: ({ order }) => clean(order.grandtotal_currency) },

  // ----------------------------------------------------------- buyer info
  { key: 'buyer.name', group: 'Buyer', label: 'Buyer full name', hint: 'Name on the shipping label',
    get: ({ order }) => clean(order.name) },
  { key: 'buyer.email', group: 'Buyer', label: 'Buyer email', hint: 'Email address of the buyer',
    get: ({ order }) => clean(order.buyer_email) },
  { key: 'address.line1', group: 'Address', label: 'Street line 1', hint: 'First address line',
    get: ({ order }) => clean(order.first_line) },
  { key: 'address.line2', group: 'Address', label: 'Street line 2', hint: 'Second address line, often empty',
    get: ({ order }) => clean(order.second_line) },
  { key: 'address.street', group: 'Address', label: 'Street (both lines)', hint: 'Street lines 1 and 2 joined together',
    get: ({ order }) => [order.first_line, order.second_line].filter(Boolean).join('\n') || null },
  { key: 'address.city', group: 'Address', label: 'City', hint: 'Shipping city',
    get: ({ order }) => clean(order.city) },
  { key: 'address.state', group: 'Address', label: 'State / province', hint: 'Shipping state, province or region',
    get: ({ order }) => clean(order.state) },
  { key: 'address.zip', group: 'Address', label: 'Post code', hint: 'Shipping ZIP or postal code',
    get: ({ order }) => clean(order.zip) },
  { key: 'address.country', group: 'Address', label: 'Country code (US, DE)', hint: 'Two letter ISO country code of the destination',
    get: ({ order }) => clean(order.country_iso) },
  { key: 'address.formatted', group: 'Address', label: 'Full formatted address', hint: 'The whole address as one block of text',
    get: ({ order }) => clean(order.formatted_address) },

  // ------------------------------------------------------------ item info
  { key: 'item.sku', group: 'Item', label: 'SKU', hint: 'Stock code of the product ordered',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? clean(item?.sku) : joinItems(items, (i) => i.sku)) },
  { key: 'item.title', group: 'Item', label: 'Product title', hint: 'Full listing title',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? clean(item?.title) : joinItems(items, (i) => i.title, ' | ')) },
  { key: 'item.title40', group: 'Item', label: 'Product title, first 40 characters', hint: 'Shortened listing title for narrow columns',
    get: ({ item, items, rowMode }) => {
      const t = rowMode === 'item' ? item?.title : joinItems(items, (i) => i.title, ' | ');
      return t ? String(t).slice(0, 40) : null;
    } },
  { key: 'item.quantity', group: 'Item', label: 'Quantity', hint: 'How many units, a number',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? (item?.quantity ?? null) : items.reduce((n, i) => n + (i.quantity || 0), 0)) },
  { key: 'item.price', group: 'Item', label: 'Unit price', hint: 'Price of one unit as a number',
    get: ({ item, rowMode }) => (rowMode === 'item' ? money(item?.price_amount, item?.price_divisor) : null) },
  { key: 'item.variations', group: 'Item', label: 'Variant (what the buyer picked)',
    hint: 'Only the chosen values, no option titles, e.g. "Silver / 8 US"',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? variationValues(item ?? {}) : joinItems(items, variationValues, ' | ')) },
  { key: 'item.variations_full', group: 'Item', label: 'Variant with option titles',
    hint: 'The long form including the property names, e.g. "Colour: Silver / Ring size: 8 US"',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? variationPairs(item ?? {}) : joinItems(items, variationPairs, ' | ')) },
  { key: 'item.image_url', group: 'Item', label: 'Product image URL', hint: 'Direct link to the listing photo',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? item?.image_url ?? null : joinItems(items, (i) => i.image_url, ' ')) },
  { key: 'item.variant_image_url', group: 'Item', label: 'Variant image URL (the chosen option)',
    hint: 'Photo Etsy has attached to the exact option the buyer chose. Empty when the listing has no per-variation photos.',
    get: ({ item, items, rowMode }) => (rowMode === 'item'
      ? imageForTransaction(item)
      : joinItems(items, (i) => imageForTransaction(i), ' ')) },
  { key: 'item.image_any', group: 'Item', label: 'Best available image URL',
    hint: 'The variant photo when there is one, otherwise the listing photo. Use this if you just want a picture.',
    get: ({ item, items, rowMode }) => {
      const best = (i) => imageForTransaction(i) ?? i?.image_url ?? null;
      return rowMode === 'item' ? best(item) : joinItems(items, best, ' ');
    } },
  { key: 'item.listing_id', group: 'Item', label: 'Etsy listing id', hint: 'Numeric id of the listing',
    get: ({ item, rowMode }) => (rowMode === 'item' ? (item?.listing_id ?? null) : null) },
  { key: 'item.etsy_link', group: 'Item', label: 'Etsy listing link', hint: 'Public etsy.com URL of the product',
    get: ({ item, items, rowMode }) => {
      const id = rowMode === 'item' ? item?.listing_id : items[0]?.listing_id;
      return id ? `https://www.etsy.com/listing/${id}` : null;
    } },
  { key: 'item.supply_link', group: 'Item', label: 'Supplier link (from SKU manager)', hint: 'The buying/dropshipping URL saved against this SKU',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? clean(item?.supply_link) : joinItems(items, (i) => i.supply_link, ' ')) },
  { key: 'item.supplier_name', group: 'Item', label: 'Supplier name', hint: 'Supplier saved against this SKU',
    get: ({ item, items, rowMode }) => (rowMode === 'item' ? clean(item?.supplier_name) : joinItems(items, (i) => i.supplier_name)) },
  { key: 'item.supply_cost', group: 'Item', label: 'Supply cost', hint: 'What the item costs you, as a number',
    get: ({ item, rowMode }) => (rowMode === 'item' ? (item?.supply_cost ?? null) : null) },

  // -------------------------------------------------------------- parcels
  { key: 'tracking.code', group: 'Tracking', label: 'Tracking number', hint: 'Parcel tracking number',
    get: ({ order }) => clean(order.tracking_code) },
  { key: 'tracking.url', group: 'Tracking', label: 'Tracking link', hint: 'Clickable tracking URL for the parcel',
    get: ({ order }) => trackingLink(order.tracking_code) },
  { key: 'tracking.carrier', group: 'Tracking', label: 'Carrier', hint: 'Shipping company name',
    get: ({ order }) => clean(order.carrier_name) },
  { key: 'tracking.status', group: 'Tracking', label: 'Tracking status', hint: 'Latest parcel status, e.g. in_transit, delivered',
    get: ({ order }) => clean(order.tracking_status) },
  { key: 'tracking.shipping_cost', group: 'Tracking', label: 'Shipping cost you paid',
    hint: 'What sending this parcel cost you, typed in next to the tracking number, as a number',
    get: ({ order }) => (order.shipping_cost ?? null) },
  { key: 'tracking.shipping_cost_currency', group: 'Tracking', label: 'Shipping cost currency',
    hint: 'Currency of the shipping cost you typed in, e.g. CNY, USD',
    get: ({ order }) => clean(order.shipping_cost_currency) },
  { key: 'tracking.shipping_cost_usd', group: 'Tracking', label: 'Shipping cost in USD',
    hint: 'The shipping cost converted to USD at the rate of the order date',
    get: ({ order }) => round2(convert(order.shipping_cost, order.shipping_cost_currency || 'CNY', 'USD', isoDate(order.created_ts))) },

  // ----------------------------------------------------------- offsite ads
  // Etsy does not report which orders came from an offsite ad, so this
  // follows the button you press on the order.
  { key: 'order.offsite_ads', group: 'Offsite ads', label: 'Came from an offsite ad?',
    hint: 'true/false. Whether you marked this order as having come from an Etsy Offsite Ad.',
    get: ({ order }) => !!order.offsite_ads },
  { key: 'order.offsite_ads_yesno', group: 'Offsite ads', label: 'Offsite ad (YES / empty)',
    hint: 'Writes "YES" when the order came from an offsite ad and nothing when it did not - for a select column',
    get: ({ order }) => (order.offsite_ads ? 'YES' : null) },
  { key: 'order.offsite_ads_fee', group: 'Offsite ads', label: 'Offsite ads fee (order currency)',
    hint: "Etsy's advertising fee on this order, in the order's own currency, capped at $100",
    get: ({ order }) => offsiteFeeFor(order)?.fee ?? null },
  { key: 'order.offsite_ads_fee_usd', group: 'Offsite ads', label: 'Offsite ads fee in USD',
    hint: "Etsy's advertising fee on this order converted to USD at the order date, capped at $100",
    get: ({ order }) => offsiteFeeFor(order)?.feeUsd ?? null },
  { key: 'order.offsite_ads_rate', group: 'Offsite ads', label: 'Offsite ads rate (%)',
    hint: 'The percentage this shop pays on offsite ad orders, 12 or 15',
    get: ({ order }) => offsiteFeeFor(order)?.ratePercent ?? null },
  { key: 'order.after_offsite_ads', group: 'Offsite ads', label: 'Order total after the offsite ads fee',
    hint: 'The order total with the advertising fee already taken off, in the order currency',
    get: ({ order }) => {
      const fee = offsiteFeeFor(order);
      const total = money(order.grandtotal_amount, order.grandtotal_divisor);
      if (total === null) return null;
      return round2(fee ? total - fee.fee : total);
    } },

  // ------------------------------------------------- rates and conversions
  // Everything here uses the rate published for the order's own day (the last
  // business day before it, when the order landed on a weekend).
  { key: 'rate.cny_usd', group: 'Rates', label: 'Yuan → USD rate on the order date',
    hint: 'What 1 CNY was worth in USD the day the order came in, e.g. 0.1489',
    get: ({ order }) => round6(rateOn(isoDate(order.created_ts), 'CNY', 'USD')) },
  { key: 'rate.usd_cny', group: 'Rates', label: 'USD → Yuan rate on the order date',
    hint: 'How many CNY one USD bought that day, e.g. 6.71',
    get: ({ order }) => round6(rateOn(isoDate(order.created_ts), 'USD', 'CNY')) },
  { key: 'rate.try_usd', group: 'Rates', label: 'Lira → USD rate on the order date',
    hint: 'What 1 TRY was worth in USD that day',
    get: ({ order }) => round6(rateOn(isoDate(order.created_ts), 'TRY', 'USD')) },
  { key: 'rate.usd_try', group: 'Rates', label: 'USD → Lira rate on the order date',
    hint: 'How many TRY one USD bought that day',
    get: ({ order }) => round6(rateOn(isoDate(order.created_ts), 'USD', 'TRY')) },
  { key: 'rate.eur_usd', group: 'Rates', label: 'Euro → USD rate on the order date',
    hint: 'What 1 EUR was worth in USD that day',
    get: ({ order }) => round6(rateOn(isoDate(order.created_ts), 'EUR', 'USD')) },
  { key: 'rate.order_currency_usd', group: 'Rates', label: "This order's currency → USD rate",
    hint: 'The rate used to turn this order\'s own currency into USD on its date',
    get: ({ order }) => round6(rateOn(isoDate(order.created_ts), order.grandtotal_currency || 'USD', 'USD')) },

  { key: 'total.grand_usd', group: 'Totals in USD', label: 'Order total in USD',
    hint: 'The order total converted to USD at the rate of the order date, whatever currency the shop bills in',
    get: ({ order }) => round2(convert(money(order.grandtotal_amount, order.grandtotal_divisor),
      order.grandtotal_currency || 'USD', 'USD', isoDate(order.created_ts))) },
  { key: 'total.subtotal_usd', group: 'Totals in USD', label: 'Subtotal in USD',
    hint: 'The items subtotal converted to USD at the rate of the order date. Use this when the shop bills in lira.',
    get: ({ order }) => round2(convert(money(order.subtotal_amount, order.grandtotal_divisor),
      order.grandtotal_currency || 'USD', 'USD', isoDate(order.created_ts))) },
  { key: 'total.shipping_usd', group: 'Totals in USD', label: 'Shipping charged, in USD',
    hint: 'Shipping the buyer paid, converted to USD at the rate of the order date',
    get: ({ order }) => round2(convert(money(order.total_shipping_amount, order.grandtotal_divisor),
      order.grandtotal_currency || 'USD', 'USD', isoDate(order.created_ts))) },
  { key: 'item.price_usd', group: 'Totals in USD', label: 'Unit price in USD',
    hint: 'Price of one unit converted to USD at the rate of the order date',
    get: ({ item, order, rowMode }) => (rowMode === 'item'
      ? round2(convert(money(item?.price_amount, item?.price_divisor),
        item?.price_currency || order.grandtotal_currency || 'USD', 'USD', isoDate(order.created_ts)))
      : null) },

  // ----------------------------------------------------------------- shop
  { key: 'shop.airtable_name', group: 'Shop', label: 'Shop name as written in Airtable',
    hint: 'The name this shop goes by in your sheets (KeyArtisann, KeyArtisanUS, CutieGiftsUS). '
      + 'This is what a shop/MAĞAZA column should be filled with, since it decides which view the row lands in.',
    get: ({ shop }) => clean(shop?.airtableName || shop?.shopName) },
  { key: 'shop.name', group: 'Shop', label: 'Shop name exactly as Etsy has it',
    hint: 'The shop name Etsy returns, which may be spelled differently from your Airtable option',
    get: ({ shop }) => clean(shop?.shopName) },
  { key: 'shop.id', group: 'Shop', label: 'Shop id', hint: 'Numeric Etsy shop id',
    get: ({ shop }) => (shop?.shopId ?? null) },

  // ------------------------------------------------------- your own flags
  { key: 'flags.done', group: 'Your flags', label: 'Marked done?', hint: 'true/false, your own done tick in this app',
    get: ({ order }) => !!order.is_done },
  { key: 'flags.supplier_ordered', group: 'Your flags', label: 'Supplier ordered?', hint: 'true/false, you have placed the supplier order',
    get: ({ order }) => !!order.supplier_ordered },
  { key: 'flags.supplier_ref', group: 'Your flags', label: 'Supplier order reference', hint: 'Your reference/code at the supplier',
    get: ({ order }) => clean(order.supplier_order_ref) },
  { key: 'flags.notes', group: 'Your flags', label: 'Your note', hint: 'The private note you typed on the order',
    get: ({ order }) => clean(order.notes) },
];

/**
 * When one order becomes several rows (one per item), most of what it carries
 * belongs to the order, not to the line: the money, the address, the parcel.
 * Repeating those on every row double-counts the order total in any sum.
 *
 * These sources stay on every row, because they are what ties the rows of an
 * order together and what Airtable matches on. Everything else that is not an
 * `item.*` field is written on the first row only.
 */
export const REPEATED_ON_EVERY_ROW = new Set([
  'order.id', 'order.id_hash', 'order.code',
  'order.date', 'order.datetime', 'order.month', 'order.month_en',
  'shop.airtable_name', 'shop.name', 'shop.id',
]);

/** True when this source should only be filled on an order's first row. */
export const isOrderLevel = (key) => !String(key).startsWith('item.') && !REPEATED_ON_EVERY_ROW.has(key);

export const SOURCE_BY_KEY = new Map(SOURCE_FIELDS.map((f) => [f.key, f]));

/** Resolve one source key against a row context. Unknown keys resolve to null. */
export function resolveSource(key, ctx) {
  const def = SOURCE_BY_KEY.get(key);
  if (!def) return null;
  try { return def.get(ctx); } catch { return null; }
}

/**
 * Load the orders to push, shaped into the rows that will become Airtable
 * records: one per order line in 'item' mode, one per order in 'order' mode.
 */
export function loadRows(receiptIds, { rowMode = 'item' } = {}) {
  if (!receiptIds?.length) return [];
  const db = getDb();
  const shopId = activeShopId();
  const shop = currentShop();
  const holes = receiptIds.map(() => '?').join(',');

  const orders = db.prepare(`
    SELECT r.*,
           COALESCE(f.is_done, 0) AS is_done, COALESCE(f.supplier_ordered, 0) AS supplier_ordered,
           f.supplier_order_ref, f.notes,
           s.tracking_code, s.carrier_name, t.status AS tracking_status,
           t.shipping_cost, t.shipping_cost_currency
    FROM receipts r
    LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
    LEFT JOIN (SELECT receipt_id, MAX(id) AS sid FROM shipments GROUP BY receipt_id) ls ON ls.receipt_id = r.receipt_id
    LEFT JOIN shipments s ON s.id = ls.sid
    LEFT JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS r.shop_id
    WHERE r.shop_id IS ? AND r.receipt_id IN (${holes})
    ORDER BY r.created_ts DESC`).all(shopId, ...receiptIds);

  const items = db.prepare(`
    SELECT x.*, m.supply_link, m.supplier_name, m.supply_cost
    FROM receipt_transactions x
    LEFT JOIN sku_meta m ON m.sku = x.sku AND m.shop_id IS ? AND x.sku <> ''
    WHERE x.receipt_id IN (${holes})
    ORDER BY x.transaction_id`).all(shopId, ...receiptIds);

  const byReceipt = new Map();
  for (const it of items) {
    if (!byReceipt.has(it.receipt_id)) byReceipt.set(it.receipt_id, []);
    byReceipt.get(it.receipt_id).push(it);
  }

  const rows = [];
  for (const order of orders) {
    const lines = byReceipt.get(order.receipt_id) ?? [];
    if (rowMode === 'order' || lines.length === 0) {
      rows.push({ receiptId: order.receipt_id, transactionId: null, order, item: lines[0] ?? null, items: lines, shop, rowMode: 'order' });
    } else {
      for (const item of lines) {
        rows.push({ receiptId: order.receipt_id, transactionId: item.transaction_id, order, item, items: lines, shop, rowMode: 'item' });
      }
    }
  }
  return rows;
}

/** A single order's worth of sample values, for the mapping preview and the AI prompt. */
export function sampleValues(rowMode = 'item') {
  const db = getDb();
  const latest = db.prepare('SELECT receipt_id FROM receipts WHERE shop_id IS ? ORDER BY created_ts DESC LIMIT 1')
    .get(activeShopId());
  if (!latest) return {};
  const [row] = loadRows([latest.receipt_id], { rowMode });
  if (!row) return {};
  return Object.fromEntries(SOURCE_FIELDS.map((f) => [f.key, resolveSource(f.key, row)]));
}
