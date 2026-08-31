/**
 * Pulls Etsy state into the local mirror so the grids, filters and Excel
 * exports are instant and work offline. Nothing here mutates Etsy.
 */
import { call, callAll } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';
import { getDb, json, audit } from '../db/index.js';
import { money } from '../lib/money.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('sync');

export const LISTING_STATES = ['active', 'inactive', 'draft', 'expired', 'sold_out'];

/** "Colour: Red / Size: M" - what the seller actually recognises a variation by. */
export function variationLabel(propertyValues = []) {
  if (!propertyValues.length) return '';
  return propertyValues
    .map((pv) => `${pv.property_name || pv.property_id}: ${(pv.values || []).join(', ')}`)
    .join(' / ');
}

// ------------------------------------------------------------------ listings

const upsertListing = (db) => db.prepare(`
  INSERT INTO listings (listing_id, shop_id, title, description, state, url,
    price_amount, price_divisor, price_currency, quantity, taxonomy_id, shop_section_id,
    shipping_profile_id, return_policy_id, tags, materials, sku_list, views, num_favorers,
    featured_rank, created_ts, updated_ts, ends_ts, first_image_url, first_image_id, raw, synced_at)
  VALUES (@listing_id,@shop_id,@title,@description,@state,@url,
    @price_amount,@price_divisor,@price_currency,@quantity,@taxonomy_id,@shop_section_id,
    @shipping_profile_id,@return_policy_id,@tags,@materials,@sku_list,@views,@num_favorers,
    @featured_rank,@created_ts,@updated_ts,@ends_ts,@first_image_url,@first_image_id,@raw,datetime('now'))
  ON CONFLICT(listing_id) DO UPDATE SET
    shop_id=excluded.shop_id, title=excluded.title, description=excluded.description,
    state=excluded.state, url=excluded.url, price_amount=excluded.price_amount,
    price_divisor=excluded.price_divisor, price_currency=excluded.price_currency,
    quantity=excluded.quantity, taxonomy_id=excluded.taxonomy_id,
    shop_section_id=excluded.shop_section_id, shipping_profile_id=excluded.shipping_profile_id,
    return_policy_id=excluded.return_policy_id, tags=excluded.tags, materials=excluded.materials,
    sku_list=excluded.sku_list, views=excluded.views, num_favorers=excluded.num_favorers,
    featured_rank=excluded.featured_rank, created_ts=excluded.created_ts,
    updated_ts=excluded.updated_ts, ends_ts=excluded.ends_ts,
    first_image_url=COALESCE(excluded.first_image_url, listings.first_image_url),
    first_image_id=COALESCE(excluded.first_image_id, listings.first_image_id),
    raw=excluded.raw, synced_at=datetime('now')
`);

function listingRow(l) {
  const price = money(l.price);
  const firstImage = (l.images || [])[0];
  return {
    listing_id: l.listing_id,
    shop_id: l.shop_id ?? null,
    title: l.title ?? null,
    description: l.description ?? null,
    state: l.state ?? null,
    url: l.url ?? null,
    price_amount: price.amount,
    price_divisor: price.divisor,
    price_currency: price.currency,
    quantity: l.quantity ?? null,
    taxonomy_id: l.taxonomy_id ?? null,
    shop_section_id: l.shop_section_id ?? null,
    shipping_profile_id: l.shipping_profile_id ?? null,
    return_policy_id: l.return_policy_id ?? null,
    tags: json(l.tags || []),
    materials: json(l.materials || []),
    sku_list: json(l.skus || []),
    views: l.views ?? null,
    num_favorers: l.num_favorers ?? null,
    featured_rank: l.featured_rank ?? null,
    created_ts: l.created_timestamp ?? l.original_creation_timestamp ?? null,
    updated_ts: l.updated_timestamp ?? l.last_modified_timestamp ?? null,
    ends_ts: l.ending_timestamp ?? null,
    first_image_url: firstImage?.url_570xN ?? firstImage?.url_fullxfull ?? null,
    first_image_id: firstImage?.listing_image_id ?? null,
    raw: json(l),
  };
}

export function saveListing(listing) {
  const db = getDb();
  db.transaction(() => {
    upsertListing(db).run(listingRow(listing));
    if (listing.images) saveImages(listing.listing_id, listing.images);
    if (listing.videos) saveVideos(listing.listing_id, listing.videos);
    if (listing.inventory) saveInventory(listing.listing_id, listing.inventory);
  })();
}

export function saveImages(listingId, images = []) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO listing_images (listing_image_id, listing_id, rank, url_75x75, url_570xN, url_fullxfull, alt_text, raw)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(listing_image_id) DO UPDATE SET rank=excluded.rank, url_75x75=excluded.url_75x75,
      url_570xN=excluded.url_570xN, url_fullxfull=excluded.url_fullxfull,
      alt_text=excluded.alt_text, raw=excluded.raw`);
  db.transaction(() => {
    const keep = images.map((i) => i.listing_image_id);
    if (keep.length) {
      db.prepare(`DELETE FROM listing_images WHERE listing_id = ? AND listing_image_id NOT IN (${keep.map(() => '?').join(',')})`)
        .run(listingId, ...keep);
    }
    for (const i of images) {
      stmt.run(i.listing_image_id, listingId, i.rank ?? null, i.url_75x75 ?? null,
        i.url_570xN ?? null, i.url_fullxfull ?? null, i.alt_text ?? null, json(i));
    }
    const first = [...images].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
    if (first) {
      db.prepare('UPDATE listings SET first_image_url = ?, first_image_id = ? WHERE listing_id = ?')
        .run(first.url_570xN ?? first.url_fullxfull ?? null, first.listing_image_id, listingId);
    }
  })();
}

export function saveVideos(listingId, videos = []) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO listing_videos (video_id, listing_id, height, width, thumbnail_url, video_url, video_state, raw)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(video_id) DO UPDATE SET thumbnail_url=excluded.thumbnail_url,
      video_url=excluded.video_url, video_state=excluded.video_state, raw=excluded.raw`);
  for (const v of videos) {
    if (!v?.video_id) continue;
    stmt.run(v.video_id, listingId, v.height ?? null, v.width ?? null,
      v.thumbnail_url ?? null, v.video_url ?? null, v.video_state ?? null, json(v));
  }
}

/** Flattens Etsy's inventory payload into one row per variation (product). */
export function saveInventory(listingId, inventory) {
  const db = getDb();
  const products = inventory?.products || [];
  const stmt = db.prepare(`
    INSERT INTO listing_products (product_id, listing_id, sku, is_deleted, property_values,
      variation_label, offering_id, price_amount, price_divisor, price_currency, quantity,
      is_enabled, raw, synced_at)
    VALUES (@product_id,@listing_id,@sku,@is_deleted,@property_values,@variation_label,
      @offering_id,@price_amount,@price_divisor,@price_currency,@quantity,@is_enabled,@raw,datetime('now'))
    ON CONFLICT(product_id) DO UPDATE SET sku=excluded.sku, is_deleted=excluded.is_deleted,
      property_values=excluded.property_values, variation_label=excluded.variation_label,
      offering_id=excluded.offering_id, price_amount=excluded.price_amount,
      price_divisor=excluded.price_divisor, price_currency=excluded.price_currency,
      quantity=excluded.quantity, is_enabled=excluded.is_enabled, raw=excluded.raw,
      synced_at=datetime('now')`);

  db.transaction(() => {
    const keep = products.map((p) => p.product_id).filter(Boolean);
    if (keep.length) {
      db.prepare(`DELETE FROM listing_products WHERE listing_id = ? AND product_id NOT IN (${keep.map(() => '?').join(',')})`)
        .run(listingId, ...keep);
    } else {
      db.prepare('DELETE FROM listing_products WHERE listing_id = ?').run(listingId);
    }

    for (const p of products) {
      const offering = (p.offerings || [])[0] || {};
      const price = money(offering.price);
      stmt.run({
        product_id: p.product_id,
        listing_id: listingId,
        sku: p.sku ?? '',
        is_deleted: p.is_deleted ? 1 : 0,
        property_values: json(p.property_values || []),
        variation_label: variationLabel(p.property_values),
        offering_id: offering.offering_id ?? null,
        price_amount: price.amount,
        price_divisor: price.divisor,
        price_currency: price.currency,
        quantity: offering.quantity ?? null,
        is_enabled: offering.is_enabled === false ? 0 : 1,
        raw: json(p),
      });
    }
  })();
  return products.length;
}

/** Maps each variation value to its Etsy image, then denormalises onto products. */
export async function syncVariationImages(listingId, shopId = requireShopId()) {
  const res = await call('getListingVariationImages', { shop_id: shopId, listing_id: listingId });
  const rows = res?.results || [];
  const db = getDb();

  db.transaction(() => {
    db.prepare('DELETE FROM variation_images WHERE listing_id = ?').run(listingId);
    const ins = db.prepare('INSERT OR REPLACE INTO variation_images (listing_id, property_id, value_id, image_id) VALUES (?,?,?,?)');
    for (const r of rows) ins.run(listingId, r.property_id, r.value_id, r.image_id ?? null);
  })();

  // Attach the matching image url to every product that carries that value.
  const imageById = new Map(
    db.prepare('SELECT listing_image_id, url_570xN, url_fullxfull FROM listing_images WHERE listing_id = ?')
      .all(listingId).map((i) => [i.listing_image_id, i.url_570xN || i.url_fullxfull]),
  );
  const products = db.prepare('SELECT product_id, property_values FROM listing_products WHERE listing_id = ?').all(listingId);
  const upd = db.prepare('UPDATE listing_products SET variation_image_url = ?, variation_image_id = ? WHERE product_id = ?');

  db.transaction(() => {
    for (const p of products) {
      let pv = [];
      try { pv = JSON.parse(p.property_values || '[]'); } catch { /* keep empty */ }
      let match = null;
      for (const entry of pv) {
        for (const valueId of entry.value_ids || []) {
          const hit = rows.find((r) => r.property_id === entry.property_id && r.value_id === valueId);
          if (hit?.image_id) { match = hit; break; }
        }
        if (match) break;
      }
      upd.run(match ? imageById.get(match.image_id) ?? null : null, match?.image_id ?? null, p.product_id);
    }
  })();

  return rows.length;
}

/**
 * Sync listings for the given states. `withInventory` also pulls every
 * variation/SKU, which is what the SKU manager reads.
 */
export async function syncListings({
  states = LISTING_STATES, withInventory = true, withVariationImages = true, onProgress,
} = {}) {
  const shopId = requireShopId();
  const summary = { shopId, states: {}, listings: 0, products: 0, errors: [] };

  for (const state of states) {
    const listings = await callAll('getListingsByShop',
      { shop_id: shopId, state, includes: ['Images', 'Videos'] },
      { onPage: (rows) => onProgress?.({ phase: 'listings', state, added: rows.length }) });

    for (const l of listings) saveListing({ ...l, state: l.state || state });
    summary.states[state] = listings.length;
    summary.listings += listings.length;
  }

  if (withInventory) {
    const ids = getDb().prepare('SELECT listing_id FROM listings').all().map((r) => r.listing_id);
    for (const listingId of ids) {
      try {
        const inv = await call('getListingInventory', { listing_id: listingId });
        summary.products += saveInventory(listingId, inv);
        if (withVariationImages) await syncVariationImages(listingId, shopId);
        onProgress?.({ phase: 'inventory', listingId });
      } catch (err) {
        // Digital-only or legacy listings can 404 on inventory; keep going.
        summary.errors.push({ listingId, message: err.message });
      }
    }
  }

  audit('sync.listings', { entity: 'listing', detail: summary });
  log.info(`listings synced: ${summary.listings} listings, ${summary.products} variations`);
  return summary;
}

export async function syncShopSections() {
  const shopId = requireShopId();
  const res = await call('getShopSections', { shop_id: shopId });
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO shop_sections (shop_section_id, title, rank, active_listing_count, raw)
    VALUES (?,?,?,?,?) ON CONFLICT(shop_section_id) DO UPDATE SET title=excluded.title,
    rank=excluded.rank, active_listing_count=excluded.active_listing_count, raw=excluded.raw`);
  db.transaction(() => {
    for (const s of res?.results || []) {
      stmt.run(s.shop_section_id, s.title ?? null, s.rank ?? null, s.active_listing_count ?? null, json(s));
    }
  })();
  return res?.results?.length ?? 0;
}

// ------------------------------------------------------------------ receipts

const upsertReceipt = (db) => db.prepare(`
  INSERT INTO receipts (receipt_id, shop_id, receipt_type, status, buyer_user_id, buyer_email, name,
    first_line, second_line, city, state, zip, country_iso, formatted_address,
    message_from_buyer, message_from_seller, message_from_payment,
    is_paid, is_shipped, was_paid, was_shipped, was_delivered, was_canceled,
    grandtotal_amount, grandtotal_divisor, grandtotal_currency, subtotal_amount,
    total_shipping_amount, total_tax_amount, discount_amount, gift_wrap_price_amount,
    is_gift, gift_message, payment_method, created_ts, updated_ts, shipped_ts, expected_ship_ts, raw, synced_at)
  VALUES (@receipt_id,@shop_id,@receipt_type,@status,@buyer_user_id,@buyer_email,@name,
    @first_line,@second_line,@city,@state,@zip,@country_iso,@formatted_address,
    @message_from_buyer,@message_from_seller,@message_from_payment,
    @is_paid,@is_shipped,@was_paid,@was_shipped,@was_delivered,@was_canceled,
    @grandtotal_amount,@grandtotal_divisor,@grandtotal_currency,@subtotal_amount,
    @total_shipping_amount,@total_tax_amount,@discount_amount,@gift_wrap_price_amount,
    @is_gift,@gift_message,@payment_method,@created_ts,@updated_ts,@shipped_ts,@expected_ship_ts,@raw,datetime('now'))
  ON CONFLICT(receipt_id) DO UPDATE SET
    status=excluded.status, is_paid=excluded.is_paid, is_shipped=excluded.is_shipped,
    was_paid=excluded.was_paid, was_shipped=excluded.was_shipped,
    was_delivered=excluded.was_delivered, was_canceled=excluded.was_canceled,
    message_from_buyer=excluded.message_from_buyer, message_from_seller=excluded.message_from_seller,
    updated_ts=excluded.updated_ts, shipped_ts=excluded.shipped_ts,
    expected_ship_ts=excluded.expected_ship_ts, raw=excluded.raw, synced_at=datetime('now')
`);

function receiptRow(r) {
  const total = money(r.grandtotal);
  return {
    receipt_id: r.receipt_id,
    shop_id: r.shop_id ?? null,
    receipt_type: r.receipt_type ?? null,
    status: r.status ?? null,
    buyer_user_id: r.buyer_user_id ?? null,
    buyer_email: r.buyer_email ?? null,
    name: r.name ?? null,
    first_line: r.first_line ?? null,
    second_line: r.second_line ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    zip: r.zip ?? null,
    country_iso: r.country_iso ?? null,
    formatted_address: r.formatted_address ?? null,
    message_from_buyer: r.message_from_buyer ?? null,
    message_from_seller: r.message_from_seller ?? null,
    message_from_payment: r.message_from_payment ?? null,
    is_paid: r.is_paid ? 1 : 0,
    is_shipped: r.is_shipped ? 1 : 0,
    was_paid: r.was_paid ? 1 : 0,
    was_shipped: r.was_shipped ? 1 : 0,
    was_delivered: r.was_delivered ? 1 : 0,
    was_canceled: r.was_canceled ? 1 : 0,
    grandtotal_amount: total.amount,
    grandtotal_divisor: total.divisor,
    grandtotal_currency: total.currency,
    subtotal_amount: money(r.subtotal).amount,
    total_shipping_amount: money(r.total_shipping_cost).amount,
    total_tax_amount: money(r.total_tax_cost).amount,
    discount_amount: money(r.discount_amt).amount,
    gift_wrap_price_amount: money(r.gift_wrap_price).amount,
    is_gift: r.is_gift ? 1 : 0,
    gift_message: r.gift_message ?? null,
    payment_method: r.payment_method ?? null,
    created_ts: r.created_timestamp ?? null,
    updated_ts: r.updated_timestamp ?? null,
    shipped_ts: r.shipped_timestamp ?? null,
    expected_ship_ts: r.expected_ship_date ?? null,
    raw: json(r),
  };
}

export function saveReceipt(r) {
  const db = getDb();
  db.transaction(() => {
    upsertReceipt(db).run(receiptRow(r));
    // Give every receipt a flags row so the Done tick list has somewhere to write.
    db.prepare('INSERT OR IGNORE INTO order_flags (receipt_id) VALUES (?)').run(r.receipt_id);
    if (r.transactions) saveTransactions(r.receipt_id, r.transactions);
    if (r.shipments) saveShipmentsFromEtsy(r.receipt_id, r.shipments);
  })();
}

export function saveTransactions(receiptId, transactions = []) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO receipt_transactions (transaction_id, receipt_id, listing_id, product_id, sku, title,
      description, quantity, price_amount, price_divisor, price_currency, shipping_cost_amount,
      variations, image_url, is_digital, paid_ts, shipped_ts, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET sku=excluded.sku, quantity=excluded.quantity,
      price_amount=excluded.price_amount, variations=excluded.variations,
      image_url=excluded.image_url, shipped_ts=excluded.shipped_ts, raw=excluded.raw`);
  for (const t of transactions) {
    const p = money(t.price);
    stmt.run(t.transaction_id, receiptId, t.listing_id ?? null, t.product_id ?? null, t.sku ?? '',
      t.title ?? null, t.description ?? null, t.quantity ?? null, p.amount, p.divisor, p.currency,
      money(t.shipping_cost).amount, json(t.variations || []),
      t.image_url_fullxfull ?? t.image_url_570xN ?? null,
      t.is_digital ? 1 : 0, t.paid_timestamp ?? null, t.shipped_timestamp ?? null, json(t));
  }
}

/** Records tracking Etsy already knows about so the tracking board is complete. */
export function saveShipmentsFromEtsy(receiptId, shipments = []) {
  const db = getDb();
  const ins = db.prepare(`INSERT OR IGNORE INTO shipments (receipt_id, tracking_code, carrier_name, pushed_to_etsy, pushed_at)
    VALUES (?,?,?,1,datetime('now'))`);
  const track = db.prepare(`INSERT OR IGNORE INTO tracking (tracking_code, receipt_id, carrier_name, provider, status)
    VALUES (?,?,?,'manual','pre_shipped')`);
  for (const s of shipments) {
    const code = s.tracking_code || s.tracking_number;
    if (!code) continue;
    ins.run(receiptId, code, s.carrier_name ?? null);
    track.run(code, receiptId, s.carrier_name ?? null);
  }
}

/**
 * Sync receipts. Incremental by default: only what changed since the last run.
 */
export async function syncReceipts({ full = false, sinceDays = null, onProgress } = {}) {
  const shopId = requireShopId();
  const db = getDb();
  const args = { shop_id: shopId, sort_on: 'updated', sort_order: 'desc' };

  if (!full) {
    const last = db.prepare('SELECT MAX(updated_ts) AS t FROM receipts').get()?.t;
    // Overlap by a day so nothing slips through a clock skew.
    if (last) args.min_last_modified = Math.max(0, last - 86_400);
  }
  if (sinceDays) args.min_created = Math.floor(Date.now() / 1000) - sinceDays * 86_400;

  const receipts = await callAll('getShopReceipts', args, {
    onPage: (rows) => onProgress?.({ phase: 'receipts', added: rows.length }),
  });

  for (const r of receipts) saveReceipt(r);

  // Etsy embeds transactions in the receipt payload; fetch only if it did not.
  let fetched = 0;
  for (const r of receipts) {
    if (r.transactions?.length) continue;
    try {
      const t = await call('getShopReceiptTransactionsByReceipt', { shop_id: shopId, receipt_id: r.receipt_id });
      saveTransactions(r.receipt_id, t?.results || []);
      fetched += 1;
    } catch (err) {
      log.warn(`transactions for receipt ${r.receipt_id}: ${err.message}`);
    }
  }

  const summary = { receipts: receipts.length, transactionFetches: fetched, full };
  audit('sync.receipts', { entity: 'receipt', detail: summary });
  log.info(`receipts synced: ${receipts.length}`);
  return summary;
}

export async function syncAll(opts = {}) {
  const listings = await syncListings(opts);
  const sections = await syncShopSections();
  const receipts = await syncReceipts(opts);
  return { listings, sections, receipts };
}
