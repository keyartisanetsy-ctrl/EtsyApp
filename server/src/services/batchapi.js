/**
 * Etsy's batch endpoints, and the odds and ends that had no home.
 *
 * Etsy publishes three "give me many at once" endpoints that the per-listing
 * calls make you loop over: listings, their inventory and their shipping. For a
 * hundred listings that is one request instead of a hundred, which is the
 * difference between a sync that takes a second and one that takes two minutes
 * and trips the rate limit.
 *
 * They cap at 100 ids each, so everything here chunks and reassembles.
 */
import { call } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';
import { getDb, json } from '../db/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('batch');

/** Etsy's ceiling for the batch endpoints. */
export const BATCH_MAX = 100;

const chunk = (list, size = BATCH_MAX) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Many listings in one call.
 * `includes` takes the same values as getListing: Images, Videos, Inventory,
 * Shipping, Translations, User, Shop.
 */
export async function listingsByIds(listingIds = [], { includes = ['Images'] } = {}) {
  const ids = [...new Set(listingIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];

  const out = [];
  for (const part of chunk(ids)) {
    const res = await call('getListingsByListingIds', {
      listing_ids: part.join(','),
      ...(includes.length ? { includes } : {}),
    }, { auth: false });
    out.push(...(res?.results ?? []));
  }
  return out;
}

/** Stock and variations for many listings at once. */
export async function inventoryByIds(listingIds = []) {
  const ids = [...new Set(listingIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids)) {
    const res = await call('getListingsInventoryByListingIds', { listing_ids: part.join(',') });
    out.push(...(res?.results ?? []));
  }
  return out;
}

/** Shipping profiles behind many listings at once. */
export async function shippingByIds(listingIds = []) {
  const ids = [...new Set(listingIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids)) {
    const res = await call('getListingsShippingByListingIds', { listing_ids: part.join(',') });
    out.push(...(res?.results ?? []));
  }
  return out;
}

/**
 * Refresh a set of listings in as few calls as Etsy allows.
 *
 * The old path was one getListing per listing. For a catalogue of 300 that is
 * 300 requests; this is 3.
 */
export async function refreshMany(listingIds = [], { withInventory = true, withShipping = false } = {}) {
  const { saveListing, saveImages } = await import('./sync.js');
  const listings = await listingsByIds(listingIds, { includes: ['Images'] });

  for (const l of listings) {
    saveListing(l);
    if (l.images?.length) saveImages(l.listing_id, l.images);
  }

  let inventories = [];
  if (withInventory) {
    inventories = await inventoryByIds(listings.map((l) => l.listing_id));
  }

  let shipping = [];
  if (withShipping) shipping = await shippingByIds(listings.map((l) => l.listing_id));

  log.info(`refreshed ${listings.length} listing(s) in ${Math.ceil(listingIds.length / BATCH_MAX) * (1 + (withInventory ? 1 : 0) + (withShipping ? 1 : 0))} call(s)`);
  return {
    listings: listings.length,
    inventories: inventories.length,
    shipping: shipping.length,
    calls: Math.ceil(listingIds.length / BATCH_MAX) * (1 + (withInventory ? 1 : 0) + (withShipping ? 1 : 0)),
  };
}

/** What Etsy is featuring on the shop front, which is not in the normal feed. */
export async function featured({ limit = 25, offset = 0 } = {}) {
  const res = await call('getFeaturedListingsByShop', { shop_id: requireShopId(), limit, offset });
  return { count: res?.count ?? 0, listings: res?.results ?? [] };
}

/**
 * The listings behind one order, straight from Etsy.
 *
 * Useful when an order names a listing that has since been deleted: the receipt
 * still has the transaction, and this still returns the listing.
 */
export async function listingsForReceipt(receiptId) {
  const res = await call('getListingsByShopReceipt', {
    shop_id: requireShopId(), receipt_id: Number(receiptId), limit: 100,
  });
  return { count: res?.count ?? 0, listings: res?.results ?? [] };
}

/** One variation in full, including its offerings. */
export async function product(listingId, productId) {
  return call('getListingProduct', { listing_id: Number(listingId), product_id: Number(productId) });
}

/** One offering: the price and stock behind a variation. */
export async function offering(listingId, productId, offeringId) {
  return call('getListingOffering', {
    listing_id: Number(listingId), product_id: Number(productId), product_offering_id: Number(offeringId),
  });
}

/**
 * Which permissions the saved token actually carries.
 *
 * Worth having as its own check: when a call fails with "insufficient scope",
 * this says exactly what the token has, rather than leaving you to guess
 * whether reconnecting would help.
 */
export async function scopes() {
  const res = await call('tokenScopes', {}, { method: 'POST' });
  const granted = res?.scopes ?? [];
  const { ALL_SCOPES } = await import('../etsy/operations.generated.js');
  const missing = ALL_SCOPES.filter((s) => !granted.includes(s));
  return {
    granted,
    missing,
    complete: missing.length === 0,
    note: missing.length
      ? `This token is missing ${missing.join(', ')}. Reconnect the shop from Settings to grant them.`
      : 'This token carries every permission the app can use.',
  };
}

/** A public Etsy user, for looking up who left a review. */
export async function user(userId) {
  return call('getUser', { user_id: Number(userId) });
}

/**
 * Everything Etsy knows about one listing, in one place.
 *
 * This is the "show me the whole thing" view: the listing, its images and
 * videos, its inventory, its properties and its translations. It uses the
 * per-listing endpoints that had no caller before, so nothing about a listing
 * is out of reach from inside the app.
 */
export async function fullListing(listingId) {
  const id = Number(listingId);
  const out = { listingId: id };

  const settle = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (err) { out[name] = { error: err.message }; }
  };

  // These are reads, so they can go together.
  await Promise.all([
    settle('listing', () => call('getListing', { listing_id: id, includes: ['Images', 'Videos', 'Inventory', 'Shipping'] })),
    settle('images', async () => (await call('getListingImages', { listing_id: id }))?.results ?? []),
    settle('videos', async () => (await call('getListingVideos', { listing_id: id }))?.results ?? []),
    settle('properties', async () => (await call('getListingProperties', { shop_id: requireShopId(), listing_id: id }))?.results ?? []),
    settle('files', async () => (await call('getAllListingFiles', { shop_id: requireShopId(), listing_id: id }))?.results ?? []),
    settle('personalization', () => call('getListingPersonalization', { shop_id: requireShopId(), listing_id: id })),
  ]);

  return out;
}

/** One image or video on its own, by id. */
export const image = (listingId, imageId) =>
  call('getListingImage', { listing_id: Number(listingId), listing_image_id: Number(imageId) });
export const video = (listingId, videoId) =>
  call('getListingVideo', { listing_id: Number(listingId), video_id: Number(videoId) });
export const file = (listingId, fileId) =>
  call('getListingFile', { shop_id: requireShopId(), listing_id: Number(listingId), listing_file_id: Number(fileId) });
export const property = (listingId, propertyId) =>
  call('getListingProperty', { shop_id: requireShopId(), listing_id: Number(listingId), property_id: Number(propertyId) });
export const section = (sectionId) =>
  call('getShopSection', { shop_id: requireShopId(), shop_section_id: Number(sectionId) });

/** A buyer-taxonomy category's attributes, for research rather than listing. */
export const buyerTaxonomyProperties = (taxonomyId) =>
  call('getPropertiesByBuyerTaxonomyId', { taxonomy_id: Number(taxonomyId) }, { auth: false });

/** Active listings of any shop, for competitor research. */
export async function activeListingsOfShop(shopId, { limit = 100, offset = 0, sortOn = 'created' } = {}) {
  const res = await call('findAllActiveListingsByShop', {
    shop_id: Number(shopId), limit, offset, sort_on: sortOn,
  }, { auth: false });
  return { count: res?.count ?? 0, listings: res?.results ?? [] };
}
