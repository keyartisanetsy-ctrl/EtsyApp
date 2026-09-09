/**
 * Which picture belongs to which variant.
 *
 * Etsy models this in three pieces that have to be joined:
 *
 *   listing_images     the photos on the listing, in the order you arranged them
 *   variation_images   (property_id, value_id) -> listing_image_id
 *   listing_products   one row per buyable variation, carrying its property values
 *
 * So a URL like
 *
 *   .../listing/4447531240/one-piece-...?variation0=6251766498
 *
 * names a property *value* (6251766498), and the picture for it is found by
 * looking that value up in variation_images and then fetching that image.
 *
 * When a listing has no per-variant photos - most listings do not - the useful
 * answer is not "nothing". It is the listing's own photos: the first one, which
 * is the cover shot, and the last one, which for these shops is nearly always
 * the size or colour chart. Both are returned, so a sheet can carry whichever
 * it needs.
 */
import { getDb, parse } from '../db/index.js';
import { syncListing } from './variantimages.js';
import { badRequest } from '../lib/errors.js';

/**
 * Pull the value ids out of an Etsy listing URL.
 * `?variation0=6251766498&variation1=99` -> [6251766498, 99]
 */
export function valueIdsFromUrl(url) {
  const out = [];
  const text = String(url ?? '');
  for (const m of text.matchAll(/[?&]variation\d+=(\d+)/g)) out.push(Number(m[1]));
  return out;
}

/** The listing id out of the same URL. */
export function listingIdFromUrl(url) {
  const m = /\/listing\/(\d+)/.exec(String(url ?? ''));
  return m ? Number(m[1]) : null;
}

/** Every photo on a listing, in the order it appears on Etsy. */
export function listingImages(listingId) {
  return getDb().prepare(`
    SELECT listing_image_id, rank, url_75x75, url_570xN, url_fullxfull, alt_text
    FROM listing_images WHERE listing_id = ?
    ORDER BY COALESCE(rank, 999999), listing_image_id`).all(Number(listingId))
    .map((i) => ({
      imageId: i.listing_image_id,
      rank: i.rank,
      thumb: i.url_75x75,
      medium: i.url_570xN,
      url: i.url_fullxfull || i.url_570xN || i.url_75x75,
      alt: i.alt_text || '',
    }));
}

/**
 * The picture Etsy has pinned to one property value.
 * Returns null when that value has no photo of its own.
 */
export function imageForValue(listingId, valueId) {
  const row = getDb().prepare(`
    SELECT vi.image_id, vi.property_id, vi.value_id,
           li.url_75x75, li.url_570xN, li.url_fullxfull, li.rank
    FROM variation_images vi
    LEFT JOIN listing_images li ON li.listing_image_id = vi.image_id
    WHERE vi.listing_id = ? AND vi.value_id = ?`).get(Number(listingId), Number(valueId));
  if (!row?.image_id) return null;
  return {
    imageId: row.image_id,
    propertyId: row.property_id,
    valueId: row.value_id,
    rank: row.rank,
    url: row.url_fullxfull || row.url_570xN || row.url_75x75 || null,
    thumb: row.url_75x75 || null,
  };
}

/**
 * The whole picture for one listing, and for one variant of it when you name
 * one. This is what every screen and every Airtable column reads from, so the
 * answer is the same everywhere.
 *
 * `valueIds` may come from a variant URL, from an order line's variations, or
 * from a listing_products row.
 */
export function resolveImages(listingId, { valueIds = [], productId = null } = {}) {
  const id = Number(listingId);
  if (!id) throw badRequest('A listing id is needed to look up its pictures.');

  const images = listingImages(id);
  const first = images[0] ?? null;
  const last = images.length > 1 ? images[images.length - 1] : null;

  // A saved product row may already carry the variant photo Etsy gave us.
  let saved = null;
  if (productId) {
    const p = getDb().prepare(
      'SELECT variation_image_url, variation_image_id, property_values FROM listing_products WHERE product_id = ?',
    ).get(Number(productId));
    if (p?.variation_image_url) saved = { url: p.variation_image_url, imageId: p.variation_image_id ?? null };
    // The product's own property values are the best source of value ids.
    if (!valueIds.length && p?.property_values) {
      for (const pv of parse(p.property_values, []) ?? []) {
        for (const v of pv.value_ids ?? []) valueIds.push(Number(v));
      }
    }
  }

  const matches = [];
  for (const valueId of [...new Set(valueIds.map(Number).filter(Boolean))]) {
    const hit = imageForValue(id, valueId);
    if (hit) matches.push(hit);
  }

  const variant = matches[0] ?? saved ?? null;

  return {
    listingId: id,
    // What to show for this variant, with the reason, so a blank is never a mystery.
    variant: variant
      ? { ...variant, source: matches.length ? 'variation image' : 'saved on the variation' }
      : null,
    // The fallback the shop actually wants when there is no variant photo:
    // the cover shot and the last photo, which is usually the chart.
    first,
    last,
    // What to write into a sheet: the variant photo if there is one, else the
    // cover shot.
    best: variant ?? first ?? null,
    images,
    count: images.length,
    hasVariantImages: matches.length > 0,
    note: variant
      ? null
      : images.length
        ? 'This listing has no per-variant photo, so the first and last listing photos are given instead.'
        : 'No photos have been synced for this listing yet.',
  };
}

/** The same answer, straight from a variant URL you pasted. */
export function resolveFromUrl(url) {
  const listingId = listingIdFromUrl(url);
  if (!listingId) throw badRequest('That does not look like an Etsy listing URL.');
  return { ...resolveImages(listingId, { valueIds: valueIdsFromUrl(url) }), sourceUrl: String(url) };
}

/**
 * The variant image for one line of an order.
 *
 * An order line records the variations the buyer chose, each with the property
 * and value id, which is exactly what we need - no extra API call.
 */
export function resolveForTransaction(txn) {
  if (!txn?.listing_id) return null;
  const valueIds = [];
  for (const v of parse(txn.variations, []) ?? []) {
    if (v.value_id != null) valueIds.push(Number(v.value_id));
    for (const id of v.value_ids ?? []) valueIds.push(Number(id));
  }
  const resolved = resolveImages(txn.listing_id, { valueIds, productId: txn.product_id });
  return {
    ...resolved,
    // The photo Etsy attached to the order line itself, which is a decent
    // last resort when nothing has been synced.
    fromOrder: txn.image_url || null,
    best: resolved.best ?? (txn.image_url ? { url: txn.image_url, imageId: null } : null),
  };
}

/** The public Etsy URL for a listing, optionally pinned to one variant. */
export function listingUrl(listingId, { valueIds = [], slug = '' } = {}) {
  const base = `https://www.etsy.com/listing/${Number(listingId)}${slug ? `/${slug}` : ''}`;
  const ids = [...new Set(valueIds.map(Number).filter(Boolean))];
  if (!ids.length) return base;
  return `${base}?${ids.map((v, i) => `variation${i}=${v}`).join('&')}`;
}

/** The variant URL for one order line, so the exact thing bought can be reopened. */
export function variantUrlForTransaction(txn) {
  if (!txn?.listing_id) return null;
  const valueIds = [];
  for (const v of parse(txn.variations, []) ?? []) {
    if (v.value_id != null) valueIds.push(Number(v.value_id));
    for (const id of v.value_ids ?? []) valueIds.push(Number(id));
  }
  return listingUrl(txn.listing_id, { valueIds });
}

/**
 * Fetch one listing's per-variant photos from Etsy and store them, then bring
 * each variation's own copy of the URL up to date.
 *
 * The fetching itself lives in variantimages.js, which the order push already
 * uses; this only adds the follow-up that keeps listing_products in step, so
 * the SKU grid can show the picture without a join.
 */
export async function refreshVariationImages(listingId) {
  const db = getDb();
  const id = Number(listingId);
  const { mapped } = await syncListing(id);

  const products = db.prepare('SELECT product_id, property_values FROM listing_products WHERE listing_id = ?').all(id);
  let updated = 0;
  for (const p of products) {
    const valueIds = [];
    for (const pv of parse(p.property_values, []) ?? []) {
      for (const v of pv.value_ids ?? []) valueIds.push(Number(v));
    }
    let hit = null;
    for (const v of valueIds) { hit = imageForValue(id, v); if (hit) break; }
    if (hit?.url) {
      db.prepare('UPDATE listing_products SET variation_image_url = ?, variation_image_id = ? WHERE product_id = ?')
        .run(hit.url, hit.imageId, p.product_id);
      updated += 1;
    }
  }

  return { listingId: id, pinned: mapped, variations: products.length, updated };
}
