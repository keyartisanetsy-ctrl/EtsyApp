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
import { call } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';
import { createLogger } from '../lib/logger.js';
import { badRequest } from '../lib/errors.js';

const log = createLogger('product-images');

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
  // "Ask Etsy again" means what it says -- always re-pull the base photos,
  // not only when this listing has never had any cached.
  const { mapped } = await syncListing(id, { forceImages: true });

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

// ------------------------------------------------- pinning a photo to a variant

/**
 * Tell Etsy which photo belongs to which option.
 *
 * Two things in Etsy's own description of this endpoint decide how it has to be
 * written, and both are easy to get wrong:
 *
 *   "The update overwrites all existing variation images on a listing, so if
 *    your request is successful, the variation images on the listing will be
 *    exactly those you specify."
 *
 * So sending only the pair you just changed would silently unpin every other
 * variant. Every call here therefore reads what Etsy currently has, merges the
 * change into it, and sends the complete set back.
 *
 *   "variation_images does not contain more than one property_id as variation
 *    images can only be associated on one property."
 *
 * A listing can pin photos to Colour or to Size, but not both. So changing the
 * property clears the pairs belonging to the old one, and that is said out loud
 * in the result rather than happening quietly.
 */
export async function pinVariantImages(listingId, changes = [], { replace = false, caller = call } = {}) {
  const id = Number(listingId);
  const shopId = requireShopId();
  if (!changes.length && !replace) throw badRequest('Nothing to pin.');

  // What Etsy has right now. Local rows are a mirror and may be stale, so ask.
  let current = [];
  try {
    const res = await caller('getListingVariationImages', { shop_id: shopId, listing_id: id });
    current = (res?.results ?? [])
      .filter((r) => r.image_id)
      .map((r) => ({ property_id: Number(r.property_id), value_id: Number(r.value_id), image_id: Number(r.image_id) }));
  } catch (err) {
    log.debug?.(`listing ${id} had no variation images yet: ${err.message}`);
  }

  const wanted = changes
    .map((c) => ({
      property_id: Number(c.propertyId ?? c.property_id),
      value_id: Number(c.valueId ?? c.value_id),
      image_id: c.imageId ?? c.image_id ?? null,
    }))
    .filter((c) => c.property_id && c.value_id);

  // Merge, unless the caller means "these and nothing else".
  const merged = new Map();
  if (!replace) for (const r of current) merged.set(`${r.property_id}:${r.value_id}`, r);
  for (const c of wanted) {
    const key = `${c.property_id}:${c.value_id}`;
    // A null image id means "unpin this one".
    if (c.image_id === null) merged.delete(key);
    else merged.set(key, { ...c, image_id: Number(c.image_id) });
  }

  let final = [...merged.values()];

  // One property only. The newest change decides which one wins.
  const properties = [...new Set(final.map((r) => r.property_id))];
  let droppedForProperty = [];
  if (properties.length > 1) {
    const keep = wanted[wanted.length - 1]?.property_id ?? properties[0];
    droppedForProperty = final.filter((r) => r.property_id !== keep);
    final = final.filter((r) => r.property_id === keep);
  }

  if (!final.length && !replace) throw badRequest('That would leave no variation images at all. Use replace to clear them deliberately.');

  const res = await caller('updateVariationImages', { shop_id: shopId, listing_id: id },
    { body: { variation_images: final } });

  // Bring the local mirror in line with what Etsy now holds.
  await refreshVariationImages(id).catch(() => {});

  return {
    listingId: id,
    pinned: final.length,
    // Said plainly, because Etsy replaced the lot and the caller should know.
    hadBefore: current.length,
    droppedForProperty: droppedForProperty.length,
    note: droppedForProperty.length
      ? `Etsy allows variation images on one property only, so ${droppedForProperty.length} pairing(s) on the other property were removed.`
      : null,
    results: res?.results ?? final,
  };
}

/**
 * What can be pinned: every option on the listing, and every photo, with what
 * is currently paired. This is what a "choose the photo for each option" screen
 * needs in one call.
 */
export function pinnableOptions(listingId) {
  const id = Number(listingId);
  const db = getDb();
  const images = listingImages(id);

  const products = db.prepare(`
    SELECT product_id, sku, variation_label, property_values
    FROM listing_products WHERE listing_id = ? AND is_deleted = 0 ORDER BY product_id`).all(id);

  const pinned = new Map(
    db.prepare('SELECT property_id, value_id, image_id FROM variation_images WHERE listing_id = ?')
      .all(id).map((r) => [`${r.property_id}:${r.value_id}`, r.image_id]),
  );

  // One row per distinct property value, since that - not the variation - is
  // what a photo is actually pinned to.
  const seen = new Map();
  for (const p of products) {
    for (const pv of parse(p.property_values, []) ?? []) {
      const propertyId = Number(pv.property_id);
      for (const [i, valueId] of (pv.value_ids ?? []).entries()) {
        const key = `${propertyId}:${valueId}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          propertyId,
          propertyName: pv.property_name ?? pv.formatted_name ?? '',
          valueId: Number(valueId),
          value: pv.values?.[i] ?? pv.formatted_values?.[i] ?? String(valueId),
          imageId: pinned.get(key) ?? null,
          imageUrl: pinned.has(key) ? images.find((im) => im.imageId === pinned.get(key))?.url ?? null : null,
        });
      }
    }
  }

  const options = [...seen.values()];
  const properties = [...new Set(options.map((o) => o.propertyId))];

  return {
    listingId: id,
    images,
    options,
    properties,
    // Etsy pins on one property; say which, so the screen can group by it.
    pinnedProperty: [...new Set(options.filter((o) => o.imageId).map((o) => o.propertyId))][0] ?? null,
    canPinOnOnePropertyOnly: properties.length > 1,
    note: properties.length > 1
      ? 'This listing varies on more than one option, and Etsy allows photos on only one of them.'
      : null,
  };
}
