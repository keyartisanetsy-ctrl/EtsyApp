/**
 * The picture of the exact option a buyer chose.
 *
 * The listing sync already stores both halves of this: `variation_images` says
 * "this value of this property uses image N", and `listing_images` holds the
 * URLs. So for any listing that has been synced, the variant photo is a join
 * away and costs no API call at all.
 *
 * Only when a listing has not been synced (or genuinely has no per-variation
 * photos recorded) do we ask Etsy directly, and then only for the listings
 * behind the orders being pushed.
 *
 * Not every listing has variation images set up. When there is none, callers
 * fall back to the photo Etsy attached to the order line itself, and the
 * listing link is always there as a last resort, so a row is never left with
 * nothing to look at.
 */
import { call } from '../etsy/client.js';
import { getDb } from '../db/index.js';
import { requireShopId } from '../etsy/shop.js';
import { createLogger } from '../lib/logger.js';
import { saveImages } from './sync.js';

const log = createLogger('variant-images');

const parse = (json, fallback) => { try { return JSON.parse(json ?? ''); } catch { return fallback; } };

/** Listing ids among these orders that have no variation-image rows yet. */
function listingsMissingImages(receiptIds) {
  if (!receiptIds.length) return [];
  const holes = receiptIds.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT DISTINCT x.listing_id
    FROM receipt_transactions x
    WHERE x.receipt_id IN (${holes})
      AND x.listing_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM variation_images v WHERE v.listing_id = x.listing_id)`)
    .all(...receiptIds).map((r) => r.listing_id);
}

/**
 * Ask Etsy for one listing's variation images and its image URLs, and store
 * both, so later lookups are a local join.
 */
export async function syncListing(listingId, { forceImages = false } = {}) {
  const db = getDb();

  // Make sure the base photos are on hand -- unconditionally when asked to,
  // otherwise only when nothing is cached yet. This used to run only after
  // finding at least one variation-image pair below, which meant a listing
  // with no per-variation photo assignments on Etsy (most listings: that
  // pairing is opt-in) never got its plain photos fetched here at all, no
  // matter how many times "ask Etsy again" was pressed.
  const known = db.prepare('SELECT COUNT(*) AS c FROM listing_images WHERE listing_id = ?').get(listingId).c;
  if (forceImages || !known) {
    try {
      const res = await call('getListingImages', { listing_id: listingId });
      saveImages(listingId, res?.results ?? []);
    } catch (err) {
      log.warn(`could not read images of listing ${listingId}: ${err.message}`);
    }
  }

  let pairs = [];
  try {
    const res = await call('getListingVariationImages', { shop_id: requireShopId(), listing_id: listingId });
    pairs = res?.results ?? [];
  } catch (err) {
    log.debug(`listing ${listingId} has no variation images: ${err.message}`);
    return { listingId, mapped: 0 };
  }
  if (!pairs.length) return { listingId, mapped: 0 };

  const ins = db.prepare(`INSERT OR REPLACE INTO variation_images (listing_id, property_id, value_id, image_id)
                          VALUES (?,?,?,?)`);
  let mapped = 0;
  for (const p of pairs) {
    if (p.property_id === undefined || p.value_id === undefined) continue;
    ins.run(listingId, p.property_id, p.value_id, p.image_id ?? null);
    mapped += 1;
  }
  return { listingId, mapped };
}

/**
 * Fill the gaps for the listings behind these orders. Listings the catalogue
 * sync already covered cost nothing here.
 */
export async function syncForReceipts(receiptIds = []) {
  const missing = listingsMissingImages(receiptIds);
  let mapped = 0;
  for (const listingId of missing) {
    try {
      mapped += (await syncListing(listingId)).mapped;
    } catch (err) {
      log.warn(`variation images for listing ${listingId}: ${err.message}`);
    }
  }
  return { checked: missing.length, mapped };
}

/**
 * The variant photo for one order line, or null.
 *
 * A receipt transaction's `variations` carry the property/value ids the buyer
 * picked, which is exactly what the stored map is keyed by.
 */
export function imageForTransaction(item) {
  if (!item?.listing_id) return null;
  const variations = Array.isArray(item.variations) ? item.variations : parse(item.variations, []);
  if (!variations?.length) return null;

  const stmt = getDb().prepare(`
    SELECT COALESCE(i.url_fullxfull, i.url_570xN) AS url
    FROM variation_images v
    JOIN listing_images i ON i.listing_image_id = v.image_id
    WHERE v.listing_id = ? AND v.property_id = ? AND v.value_id = ?
      AND COALESCE(i.url_fullxfull, i.url_570xN) IS NOT NULL`);

  for (const v of variations) {
    const propertyId = v.property_id ?? v.propertyId;
    const valueId = v.value_id ?? v.valueId;
    if (propertyId === undefined || valueId === undefined) continue;
    const hit = stmt.get(item.listing_id, propertyId, valueId);
    if (hit?.url) return hit.url;
  }
  return null;
}

/** How many variation images are on hand, for the settings screen. */
export function stats() {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS pairs, COUNT(DISTINCT listing_id) AS listings FROM variation_images`).get();
  const withUrl = getDb().prepare(`
    SELECT COUNT(*) AS c FROM variation_images v
    JOIN listing_images i ON i.listing_image_id = v.image_id`).get().c;
  return { pairs: row?.pairs ?? 0, listings: row?.listings ?? 0, withUrl };
}
