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
import { resolveForTransaction, variantUrlForTransaction, listingImages } from '../services/productimages.js';
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
  // Etsy fills buyer_email on some orders and leaves it null on others, but it
  // sends payment_email in the same receipt - and it is the same person. Taking
  // only the first was why this column arrived empty, so the plain "email"
  // field now uses whichever one Etsy actually sent.
  { key: 'buyer.email', group: 'Buyer', label: 'Buyer email', hint: 'The buyer\u2019s email - Etsy\u2019s buyer address, or the payment address when that is the one it sent',
    get: ({ order }) => clean(order.buyer_email || order.payment_email) },
  { key: 'buyer.email_buyer', group: 'Buyer', label: 'Buyer email (buyer field only)', hint: 'Strictly Etsy\u2019s buyer_email, blank when Etsy did not send one',
    get: ({ order }) => clean(order.buyer_email) },
  { key: 'buyer.email_payment', group: 'Buyer', label: 'Buyer email (payment field only)', hint: 'Strictly Etsy\u2019s payment_email',
    get: ({ order }) => clean(order.payment_email) },
  { key: 'buyer.email_source', group: 'Buyer', label: 'Which email field was used', hint: 'Says whether the address came from Etsy\u2019s buyer field, its payment field, or neither',
    get: ({ order }) => (order.buyer_email ? 'buyer' : order.payment_email ? 'payment' : null) },
  { key: 'buyer.user_id', group: 'Buyer', label: 'Buyer user id', hint: 'Etsy\u2019s numeric id for the buyer',
    get: ({ order }) => order.buyer_user_id ?? null },
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
  { key: 'item.price', group: 'Item', label: 'Unit price (one unit)', hint: 'What a single unit sold for. For the figure a price column normally wants, use the subtotal instead.',
    get: ({ item, rowMode }) => (rowMode === 'item' ? money(item?.price_amount, item?.price_divisor) : null) },
  { key: 'item.line_subtotal', group: 'Item', label: 'Line subtotal (unit price \u00d7 quantity)',
    hint: 'What this line came to: the unit price times how many were bought.',
    get: ({ item, items, rowMode }) => {
      const lineOf = (i) => {
        const unit = money(i?.price_amount, i?.price_divisor);
        return unit === null ? null : Math.round(unit * (i?.quantity ?? 1) * 100) / 100;
      };
      if (rowMode === 'item') return lineOf(item);
      const sum = items.reduce((n, i) => n + (lineOf(i) ?? 0), 0);
      return items.length ? Math.round(sum * 100) / 100 : null;
    } },
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
  { key: 'item.variant_supply_link', group: 'Item', label: 'Variant supply link',
    hint: 'The supplier page for this exact option, when one is saved against the SKU',
    get: ({ item, items, rowMode }) => (rowMode === 'item'
      ? clean(item?.variant_supply_link)
      : joinItems(items, (i) => i.variant_supply_link, ' ')) },
  { key: 'item.supply_link_any', group: 'Item', label: 'Supply link (variant, else main)',
    hint: 'The variant supplier page when there is one, otherwise the main product page. Use this for a single "\u00dcr\u00fcn Tedarik Link" column.',
    get: ({ item, items, rowMode }) => {
      const pick = (i) => i?.variant_supply_link || i?.supply_link || null;
      return rowMode === 'item' ? clean(pick(item)) : joinItems(items, pick, ' ');
    } },

  // --------------------------------------------------- pictures of the item
  // Three separate columns, because a sheet wants different things in each:
  // the id to match rows on, the URL to look at, and the link to click.
  { key: 'item.variant_image_id', group: 'Item images', label: 'Variant image id',
    hint: 'Etsy\u2019s numeric id for the photo pinned to the chosen option. Stable, so it makes a good key.',
    get: ({ item, items, rowMode }) => {
      const idOf = (i) => resolveForTransaction(i)?.variant?.imageId ?? null;
      return rowMode === 'item' ? idOf(item) : joinItems(items, idOf, ' ');
    } },
  { key: 'item.variant_image', group: 'Item images', label: 'Variant image (URL)',
    hint: 'The photo for the exact option bought. Falls back to the listing\u2019s cover shot when the listing has no per-option photos.',
    get: ({ item, items, rowMode }) => {
      const pick = (i) => resolveForTransaction(i)?.best?.url ?? null;
      return rowMode === 'item' ? pick(item) : joinItems(items, pick, ' ');
    } },
  { key: 'item.variant_link', group: 'Item images', label: 'Variant link on Etsy',
    hint: 'The listing URL pinned to this option, e.g. \u2026/listing/4447531240?variation0=6251766498',
    get: ({ item, items, rowMode }) => (rowMode === 'item'
      ? variantUrlForTransaction(item)
      : joinItems(items, variantUrlForTransaction, ' ')) },
  { key: 'item.first_image', group: 'Item images', label: 'First listing photo',
    hint: 'The cover shot. This is what to use when a listing has no per-option photos.',
    get: ({ item, items, rowMode }) => {
      const pick = (i) => (i?.listing_id ? listingImages(i.listing_id)[0]?.url ?? null : null);
      return rowMode === 'item' ? pick(item) : joinItems(items, pick, ' ');
    } },
  { key: 'item.last_image', group: 'Item images', label: 'Last listing photo',
    hint: 'The final photo, which on these listings is usually the size or layout chart.',
    get: ({ item, items, rowMode }) => {
      const pick = (i) => {
        if (!i?.listing_id) return null;
        const all = listingImages(i.listing_id);
        return all.length > 1 ? all[all.length - 1].url : all[0]?.url ?? null;
      };
      return rowMode === 'item' ? pick(item) : joinItems(items, pick, ' ');
    } },
  { key: 'item.first_last_image', group: 'Item images', label: 'First and last photo together',
    hint: 'Both URLs in one cell, for a listing with no per-option photos. Airtable shows both as attachments.',
    get: ({ item, items, rowMode }) => {
      const pick = (i) => {
        if (!i?.listing_id) return null;
        const all = listingImages(i.listing_id);
        if (!all.length) return null;
        const ends = all.length > 1 ? [all[0].url, all[all.length - 1].url] : [all[0].url];
        return ends.filter(Boolean).join(' ') || null;
      };
      return rowMode === 'item' ? pick(item) : joinItems(items, pick, ' ');
    } },
  { key: 'item.all_images', group: 'Item images', label: 'Every listing photo',
    hint: 'All the listing\u2019s photo URLs, space separated, in the order they appear on Etsy.',
    get: ({ item, items, rowMode }) => {
      const pick = (i) => (i?.listing_id ? listingImages(i.listing_id).map((x) => x.url).filter(Boolean).join(' ') || null : null);
      return rowMode === 'item' ? pick(item) : joinItems(items, pick, ' ');
    } },
  { key: 'item.image_count', group: 'Item images', label: 'How many photos',
    hint: 'Number of photos on the listing, as a number',
    get: ({ item, rowMode }) => (rowMode === 'item' && item?.listing_id ? listingImages(item.listing_id).length : null) },

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
  { key: 'tracking.supply_cost', group: 'Tracking', label: 'Supply cost you paid',
    hint: 'What the goods in this parcel cost you, typed in next to the shipping cost, as a number',
    get: ({ order }) => (order.supply_cost ?? null) },
  { key: 'tracking.supply_cost_currency', group: 'Tracking', label: 'Supply cost currency',
    hint: 'Currency of the supply cost you typed in, e.g. CNY, USD',
    get: ({ order }) => clean(order.supply_cost_currency) },
  { key: 'tracking.supply_cost_usd', group: 'Tracking', label: 'Supply cost in USD',
    hint: 'The supply cost converted to USD at the rate of the order date',
    get: ({ order }) => round2(convert(order.supply_cost, order.supply_cost_currency || 'CNY', 'USD', isoDate(order.created_ts))) },

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

/**
 * True for any source that resolves to a picture (or a link to one). Airtable
 * automations that turn such a link into an attachment (e.g. "Varyant
 * Görsel") only fire on a genuine empty-to-value transition, so a column fed
 * by one of these needs a clear-then-set write when it is merely overwritten
 * with a different value on an existing row - see `push()` in
 * services/airtable.js.
 */
export const isVariantImageSource = (key) => String(key).startsWith('item.variant_image')
  || key === 'item.image_any' || key === 'item.first_image' || key === 'item.last_image'
  || key === 'item.first_last_image' || key === 'item.all_images' || key === 'item.image_count';

export const SOURCE_BY_KEY = new Map(SOURCE_FIELDS.map((f) => [f.key, f]));

/** Resolve one source key against a row context. Unknown keys resolve to null. */
export function resolveSource(key, ctx) {
  const def = SOURCE_BY_KEY.get(key);
  if (!def) return null;
  try { return def.get(ctx); } catch { return null; }
}

const titleKey = (title) => String(title ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * When a SKU has no supply link of its own, most sellers still have one for
 * some other variant of the exact same product - the supplier page is
 * usually shared across colours/sizes. Look through this shop's other SKUs
 * for a link already saved against the same listing, or (a listing can get
 * deleted and relisted with a new id but the same title) the same title,
 * and use whichever is found first. Mutates `items` in place.
 */
function backfillSupplyLinks(db, shopId, items) {
  const missing = items.filter((it) => !it.supply_link && !it.variant_supply_link);
  if (!missing.length) return;

  const known = db.prepare(`
    SELECT rt.listing_id, rt.title, m.supply_link, m.variant_supply_link, m.supplier_name
    FROM sku_meta m
    JOIN receipt_transactions rt ON rt.sku = m.sku AND rt.sku <> ''
    WHERE m.shop_id IS ? AND (COALESCE(m.supply_link,'') <> '' OR COALESCE(m.variant_supply_link,'') <> '')
    ORDER BY m.updated_at DESC`).all(shopId);

  const byListing = new Map();
  const byTitle = new Map();
  for (const row of known) {
    if (row.listing_id != null && !byListing.has(row.listing_id)) byListing.set(row.listing_id, row);
    const key = titleKey(row.title);
    if (key && !byTitle.has(key)) byTitle.set(key, row);
  }

  for (const it of missing) {
    const found = (it.listing_id != null && byListing.get(it.listing_id)) || byTitle.get(titleKey(it.title));
    if (!found) continue;
    it.supply_link = found.supply_link || '';
    it.variant_supply_link = found.variant_supply_link || '';
    if (!it.supplier_name) it.supplier_name = found.supplier_name || '';
  }
}

const toCents = (decimalString) => {
  const n = Number(decimalString);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toUnixSeconds = (isoString) => (isoString ? Math.floor(Date.parse(isoString) / 1000) : null);

/**
 * Shopify's own equivalent of loadRows() below - same output shape (order/
 * item objects carrying the same property names: created_ts as unix seconds,
 * grandtotal_amount/divisor/currency, tracking_code, etc.) so the entire
 * SOURCE_FIELDS catalogue and buildRecords() work unchanged for either
 * channel. Etsy-only fields (offsite ads, listing URLs, personalization)
 * simply resolve to null for a Shopify destination, which is correct: no one
 * would map an Etsy-only column onto a Shopify sheet.
 */
function loadShopifyRows(orderIds, { rowMode = 'item' } = {}) {
  const db = getDb();
  const shopDomain = readSetting('shopify.shop_domain');
  const shop = {
    shopId: null, shopName: shopDomain,
    airtableName: readSetting('shopify.airtable_name') || shopDomain,
  };
  const holes = orderIds.map(() => '?').join(',');

  const orders = db.prepare(`
    SELECT o.*, f.tracking_number, f.tracking_company, f.shipping_cost, f.shipping_cost_currency
    FROM shopify_orders o
    LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
    WHERE o.order_id IN (${holes})
    ORDER BY o.created_at_shopify DESC`).all(...orderIds);

  const items = db.prepare(`
    SELECT x.*, m.supply_link, m.supplier_name, m.supply_currency
    FROM shopify_order_line_items x
    LEFT JOIN shopify_variant_meta m ON m.sku = x.sku AND x.sku <> ''
    WHERE x.order_id IN (${holes})
    ORDER BY x.line_item_id`).all(...orderIds);

  const byOrder = new Map();
  for (const it of items) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push({
      receipt_id: it.order_id, transaction_id: it.line_item_id, listing_id: it.product_id, product_id: it.variant_id,
      sku: it.sku, title: it.title, variations: null, image_url: it.image_url, is_digital: 0,
      quantity: it.quantity, price_amount: toCents(it.price_amount), price_divisor: 100, price_currency: it.currency,
      supply_link: it.supply_link, variant_supply_link: it.supply_link, supplier_name: it.supplier_name,
      supply_cost: null, supply_currency: it.supply_currency, saved_variant_image_url: it.image_url,
    });
  }

  const rows = [];
  for (const o of orders) {
    const lines = byOrder.get(o.order_id) ?? [];
    const order = {
      receipt_id: o.order_id, shop_id: null, status: (o.financial_status || '').toLowerCase(),
      name: o.customer_name, buyer_email: o.email, first_line: o.ship_address1, second_line: o.ship_address2,
      city: o.ship_city, state: o.ship_province, zip: o.ship_zip, country_iso: o.ship_country,
      formatted_address: [o.ship_address1, o.ship_address2, o.ship_city, o.ship_province, o.ship_zip, o.ship_country].filter(Boolean).join(', '),
      was_paid: /paid/i.test(o.financial_status || '') ? 1 : 0,
      was_shipped: /fulfilled/i.test(o.fulfillment_status || '') ? 1 : 0, was_canceled: o.cancelled_at ? 1 : 0,
      grandtotal_amount: toCents(o.total_amount), grandtotal_divisor: 100, grandtotal_currency: o.currency,
      subtotal_amount: toCents(o.subtotal_amount), total_shipping_amount: toCents(o.total_shipping_amount),
      total_tax_amount: toCents(o.total_tax_amount), discount_amount: toCents(o.total_discounts_amount),
      created_ts: toUnixSeconds(o.created_at_shopify), tracking_code: o.tracking_number,
      carrier_name: o.tracking_company, tracking_status: null,
      shipping_cost: o.shipping_cost, shipping_cost_currency: o.shipping_cost_currency,
      is_done: 0, supplier_ordered: 0, supplier_order_ref: null, notes: null,
    };
    if (rowMode === 'order' || lines.length === 0) {
      rows.push({ receiptId: o.order_id, transactionId: null, order, item: lines[0] ?? null, items: lines, shop, rowMode: 'order' });
    } else {
      for (const item of lines) {
        rows.push({ receiptId: o.order_id, transactionId: item.transaction_id, order, item, items: lines, shop, rowMode: 'item' });
      }
    }
  }
  return rows;
}

/**
 * Load the orders to push, shaped into the rows that will become Airtable
 * records: one per order line in 'item' mode, one per order in 'order' mode.
 */
export function loadRows(receiptIds, { rowMode = 'item', channel = 'etsy' } = {}) {
  if (!receiptIds?.length) return [];
  if (channel === 'shopify') return loadShopifyRows(receiptIds, { rowMode });
  const db = getDb();
  const shopId = activeShopId();
  const shop = currentShop();
  const holes = receiptIds.map(() => '?').join(',');

  const orders = db.prepare(`
    SELECT r.*,
           COALESCE(f.is_done, 0) AS is_done, COALESCE(f.supplier_ordered, 0) AS supplier_ordered,
           f.supplier_order_ref, f.notes,
           s.tracking_code, s.carrier_name, t.status AS tracking_status,
           t.shipping_cost, t.shipping_cost_currency, t.supply_cost, t.supply_cost_currency
    FROM receipts r
    LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
    LEFT JOIN (SELECT receipt_id, MAX(id) AS sid FROM shipments GROUP BY receipt_id) ls ON ls.receipt_id = r.receipt_id
    LEFT JOIN shipments s ON s.id = ls.sid
    LEFT JOIN tracking t ON t.tracking_code = s.tracking_code AND t.shop_id IS r.shop_id
    WHERE r.shop_id IS ? AND r.receipt_id IN (${holes})
    ORDER BY r.created_ts DESC`).all(shopId, ...receiptIds);

  const items = db.prepare(`
    SELECT x.*, m.supply_link, m.variant_supply_link, m.supplier_name, m.supply_cost,
           m.supply_currency, m.variant_image_url AS saved_variant_image_url
    FROM receipt_transactions x
    LEFT JOIN sku_meta m ON m.sku = x.sku AND m.shop_id IS ? AND x.sku <> ''
    WHERE x.receipt_id IN (${holes})
    ORDER BY x.transaction_id`).all(shopId, ...receiptIds);

  backfillSupplyLinks(db, shopId, items);

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
export function sampleValues(rowMode = 'item', channel = 'etsy') {
  const db = getDb();
  const latest = channel === 'shopify'
    ? db.prepare('SELECT order_id AS receipt_id FROM shopify_orders ORDER BY created_at_shopify DESC LIMIT 1').get()
    : db.prepare('SELECT receipt_id FROM receipts WHERE shop_id IS ? ORDER BY created_ts DESC LIMIT 1').get(activeShopId());
  if (!latest) return {};
  const [row] = loadRows([latest.receipt_id], { rowMode, channel });
  if (!row) return {};
  return Object.fromEntries(SOURCE_FIELDS.map((f) => [f.key, resolveSource(f.key, row)]));
}
