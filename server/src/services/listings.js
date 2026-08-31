/**
 * Listing lifecycle: create, edit, move between every Etsy state
 * (draft / active / inactive / expired / sold_out), delete, and manage
 * images, videos, files, translations, personalisation and properties.
 */
import fs from 'node:fs';
import { call, callAll } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';
import { getDb, parse, json, audit } from '../db/index.js';
import { saveListing, saveImages, syncVariationImages, LISTING_STATES } from './sync.js';
import { getDiscountPercent } from './settings.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('listings');
export { LISTING_STATES };

/** Etsy only accepts active/inactive on updateListing; the rest are derived. */
export const SETTABLE_STATES = ['active', 'inactive'];

export const WHO_MADE = ['i_did', 'someone_else', 'collective'];
export const WHEN_MADE = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007',
  '2000_2006', '1990s', '1980s', '1970s', '1960s', '1950s', '1940s', '1930s', '1920s', '1910s',
  '1900s', '1800s', '1700s', 'before_1700'];
export const LISTING_TYPES = ['physical', 'download', 'both'];

// ------------------------------------------------------------------- browse

export function localListings({
  search = '', state = '', sectionId = null, missingTags = false, missingImages = false,
  sort = 'updated', dir = 'desc', limit = 100, offset = 0,
} = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (state) { where.push('l.state = ?'); params.push(state); }
  if (sectionId) { where.push('l.shop_section_id = ?'); params.push(sectionId); }
  if (missingTags) where.push("(l.tags IS NULL OR l.tags = '[]' OR json_array_length(l.tags) < 13)");
  if (missingImages) where.push('l.first_image_url IS NULL');
  if (search) {
    where.push('(l.title LIKE ? OR CAST(l.listing_id AS TEXT) LIKE ? OR l.tags LIKE ? OR l.description LIKE ?)');
    const like = `%${search}%`; params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortable = { updated: 'l.updated_ts', created: 'l.created_ts', title: 'l.title', price: 'l.price_amount', views: 'l.views', favorers: 'l.num_favorers', quantity: 'l.quantity' };
  const orderBy = sortable[sort] || 'l.updated_ts';
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const pct = getDiscountPercent();

  const rows = db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM listing_products p WHERE p.listing_id = l.listing_id AND p.is_deleted = 0) AS variation_count,
           (SELECT COUNT(*) FROM listing_products p WHERE p.listing_id = l.listing_id AND p.is_deleted = 0 AND (p.sku IS NULL OR p.sku = '')) AS missing_sku_count,
           (SELECT COUNT(*) FROM listing_images i WHERE i.listing_id = l.listing_id) AS image_count
    FROM listings l ${clause} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM listings l ${clause}`).get(...params).c;
  const counts = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) AS c FROM listings GROUP BY state').all().map((r) => [r.state, r.c]),
  );

  return {
    total, limit, offset, discountPercent: pct,
    countsByState: counts,
    rows: rows.map((l) => {
      const price = l.price_amount != null ? l.price_amount / (l.price_divisor || 100) : null;
      return {
        listingId: l.listing_id,
        title: l.title,
        state: l.state,
        url: l.url,
        price,
        priceDiscounted: price != null ? Math.round(price * (1 - pct / 100) * 100) / 100 : null,
        currency: l.price_currency,
        quantity: l.quantity,
        tags: parse(l.tags, []),
        materials: parse(l.materials, []),
        taxonomyId: l.taxonomy_id,
        sectionId: l.shop_section_id,
        shippingProfileId: l.shipping_profile_id,
        returnPolicyId: l.return_policy_id,
        views: l.views,
        favorers: l.num_favorers,
        createdTs: l.created_ts,
        updatedTs: l.updated_ts,
        endsTs: l.ends_ts,
        firstImageUrl: l.first_image_url,
        imageCount: l.image_count,
        variationCount: l.variation_count,
        missingSkuCount: l.missing_sku_count,
      };
    }),
  };
}

export function localListing(listingId) {
  const db = getDb();
  const l = db.prepare('SELECT * FROM listings WHERE listing_id = ?').get(listingId);
  if (!l) throw notFound(`Listing ${listingId} is not in the local mirror. Sync listings first.`);
  const pct = getDiscountPercent();
  const price = l.price_amount != null ? l.price_amount / (l.price_divisor || 100) : null;
  return {
    listingId: l.listing_id,
    title: l.title,
    description: l.description,
    state: l.state,
    url: l.url,
    price,
    priceDiscounted: price != null ? Math.round(price * (1 - pct / 100) * 100) / 100 : null,
    currency: l.price_currency,
    quantity: l.quantity,
    tags: parse(l.tags, []),
    materials: parse(l.materials, []),
    taxonomyId: l.taxonomy_id,
    sectionId: l.shop_section_id,
    shippingProfileId: l.shipping_profile_id,
    returnPolicyId: l.return_policy_id,
    views: l.views,
    favorers: l.num_favorers,
    createdTs: l.created_ts,
    updatedTs: l.updated_ts,
    images: db.prepare('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY rank').all(listingId)
      .map((i) => ({ id: i.listing_image_id, rank: i.rank, url: i.url_570xN || i.url_fullxfull, full: i.url_fullxfull, thumb: i.url_75x75, altText: i.alt_text })),
    videos: db.prepare('SELECT * FROM listing_videos WHERE listing_id = ?').all(listingId)
      .map((v) => ({ id: v.video_id, url: v.video_url, thumbnail: v.thumbnail_url, state: v.video_state })),
    variations: db.prepare('SELECT * FROM listing_products WHERE listing_id = ? AND is_deleted = 0').all(listingId)
      .map((p) => ({
        productId: p.product_id, sku: p.sku, variation: p.variation_label,
        price: p.price_amount != null ? p.price_amount / (p.price_divisor || 100) : null,
        quantity: p.quantity, isEnabled: !!p.is_enabled,
        variationImageUrl: p.variation_image_url,
        properties: parse(p.property_values, []),
      })),
    raw: parse(l.raw, null),
  };
}

// ------------------------------------------------------------------ mutate

/** Fields updateListing accepts. Anything else is rejected up front. */
const UPDATABLE = new Set(['title', 'description', 'materials', 'should_auto_renew', 'shipping_profile_id',
  'return_policy_id', 'shop_section_id', 'item_weight', 'item_length', 'item_width', 'item_height',
  'item_weight_unit', 'item_dimensions_unit', 'is_taxable', 'taxonomy_id', 'tags', 'who_made',
  'when_made', 'featured_rank', 'is_personalizable', 'personalization_is_required',
  'personalization_char_count_max', 'personalization_instructions', 'state', 'is_supply',
  'production_partner_ids', 'type', 'image_ids']);

export function validateListingFields(fields) {
  const out = {};
  const problems = [];

  for (const [k, v] of Object.entries(fields)) {
    if (!UPDATABLE.has(k)) { problems.push(`"${k}" is not an updatable listing field`); continue; }
    out[k] = v;
  }
  if (out.title != null) {
    const t = String(out.title).trim();
    if (!t) problems.push('Title cannot be empty');
    if (t.length > 140) problems.push(`Title is ${t.length} characters; Etsy allows 140`);
    out.title = t;
  }
  if (out.tags) {
    const tags = Array.isArray(out.tags) ? out.tags : String(out.tags).split(',');
    const clean = tags.map((t) => String(t).trim()).filter(Boolean);
    if (clean.length > 13) problems.push(`${clean.length} tags supplied; Etsy allows 13`);
    const long = clean.filter((t) => t.length > 20);
    if (long.length) problems.push(`Tags over 20 characters: ${long.join(', ')}`);
    out.tags = clean;
  }
  if (out.materials) {
    const m = Array.isArray(out.materials) ? out.materials : String(out.materials).split(',');
    out.materials = m.map((x) => String(x).trim()).filter(Boolean).slice(0, 13);
  }
  if (out.state && !SETTABLE_STATES.includes(out.state)) {
    problems.push(`state must be one of ${SETTABLE_STATES.join(' / ')} (Etsy derives draft, expired and sold_out itself)`);
  }
  if (out.who_made && !WHO_MADE.includes(out.who_made)) problems.push(`who_made must be one of ${WHO_MADE.join(' / ')}`);
  if (out.when_made && !WHEN_MADE.includes(out.when_made)) problems.push(`when_made is not a value Etsy accepts`);
  if (out.type && !LISTING_TYPES.includes(out.type)) problems.push(`type must be one of ${LISTING_TYPES.join(' / ')}`);

  if (problems.length) throw badRequest('Listing update rejected before sending to Etsy.', problems);
  return out;
}

export async function updateListing(listingId, fields, { dryRun = false } = {}) {
  const shopId = requireShopId();
  const body = validateListingFields(fields);
  if (!Object.keys(body).length) throw badRequest('Nothing to update.');
  if (dryRun) return { dryRun: true, listingId, body };

  const res = await call('updateListing', { shop_id: shopId, listing_id: listingId }, { body });
  saveListing(res);
  audit('listing.update', { entity: 'listing', entityId: listingId, detail: Object.keys(body) });
  return res;
}

/** Activate / deactivate. Etsy owns draft, expired and sold_out. */
export async function setState(listingId, state) {
  if (!SETTABLE_STATES.includes(state)) {
    throw badRequest(`Etsy only accepts "active" or "inactive" here. "${state}" is a state Etsy assigns itself.`, {
      hint: state === 'draft'
        ? 'A listing can never go back to draft once published. Deactivate it instead.'
        : 'expired and sold_out follow from the listing end date and stock level.',
    });
  }
  return updateListing(listingId, { state });
}

export async function deleteListing(listingId) {
  const res = await call('deleteListing', { listing_id: listingId });
  getDb().prepare('DELETE FROM listings WHERE listing_id = ?').run(listingId);
  audit('listing.delete', { entity: 'listing', entityId: listingId });
  log.info(`deleted listing ${listingId}`);
  return res ?? { deleted: listingId };
}

/** Create a draft. Etsy requires quantity/title/description/price/who_made/when_made/taxonomy_id. */
export async function createDraft(fields) {
  const shopId = requireShopId();
  const required = ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id'];
  const missing = required.filter((k) => fields[k] === undefined || fields[k] === '' || fields[k] === null);
  if (missing.length) throw badRequest(`Etsy needs these to create a draft: ${missing.join(', ')}`);

  const body = { ...fields };
  body.quantity = Number(body.quantity);
  body.price = Number(body.price);
  body.taxonomy_id = Number(body.taxonomy_id);
  if (body.tags) body.tags = (Array.isArray(body.tags) ? body.tags : String(body.tags).split(',')).map((t) => String(t).trim()).filter(Boolean).slice(0, 13);
  if (body.materials) body.materials = (Array.isArray(body.materials) ? body.materials : String(body.materials).split(',')).map((t) => String(t).trim()).filter(Boolean).slice(0, 13);
  if (String(body.title).length > 140) throw badRequest(`Title is ${String(body.title).length} characters; Etsy allows 140`);

  const res = await call('createDraftListing', { shop_id: shopId }, { body });
  saveListing(res);
  audit('listing.create', { entity: 'listing', entityId: res.listing_id, detail: { title: res.title } });
  log.info(`created draft listing ${res.listing_id}`);
  return res;
}

// ------------------------------------------------------------------ images

export async function uploadImage(listingId, { buffer, filename, mime, rank = 1, altText, overwrite = false, isWatermarked = false }) {
  const shopId = requireShopId();
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime || 'image/jpeg' }), filename || 'image.jpg');
  form.append('rank', String(rank));
  if (overwrite) form.append('overwrite', 'true');
  if (isWatermarked) form.append('is_watermarked', 'true');
  if (altText) form.append('alt_text', String(altText).slice(0, 500));

  const res = await call('uploadListingImage', { shop_id: shopId, listing_id: listingId }, { formData: form });
  await refreshImages(listingId);
  audit('listing.image.upload', { entity: 'listing', entityId: listingId, detail: { rank, filename } });
  return res;
}

export async function refreshImages(listingId) {
  const res = await call('getListingImages', { listing_id: listingId });
  saveImages(listingId, res?.results || []);
  return res?.results || [];
}

export async function deleteImage(listingId, imageId) {
  const shopId = requireShopId();
  await call('deleteListingImage', { shop_id: shopId, listing_id: listingId, listing_image_id: imageId });
  getDb().prepare('DELETE FROM listing_images WHERE listing_image_id = ?').run(imageId);
  audit('listing.image.delete', { entity: 'listing', entityId: listingId, detail: { imageId } });
  return { deleted: imageId };
}

/** Reordering is done by re-uploading at the wanted rank with overwrite. */
export async function setVariationImages(listingId, pairs) {
  const shopId = requireShopId();
  const variation_images = pairs.map((p) => ({
    property_id: Number(p.propertyId ?? p.property_id),
    value_id: Number(p.valueId ?? p.value_id),
    image_id: Number(p.imageId ?? p.image_id),
  }));
  const res = await call('updateVariationImages', { shop_id: shopId, listing_id: listingId }, { body: { variation_images } });
  await syncVariationImages(listingId, shopId);
  return res;
}

// ------------------------------------------------ videos / files / extras

export async function uploadVideo(listingId, { buffer, filename, mime, name }) {
  const shopId = requireShopId();
  const form = new FormData();
  form.append('video', new Blob([buffer], { type: mime || 'video/mp4' }), filename || 'video.mp4');
  if (name) form.append('name', name);
  return call('uploadListingVideo', { shop_id: shopId, listing_id: listingId }, { formData: form });
}

export const deleteVideo = (listingId, videoId) =>
  call('deleteListingVideo', { shop_id: requireShopId(), listing_id: listingId, video_id: videoId });

export async function uploadDigitalFile(listingId, { buffer, filename, name, rank = 1 }) {
  const shopId = requireShopId();
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('name', name || filename);
  form.append('rank', String(rank));
  return call('uploadListingFile', { shop_id: shopId, listing_id: listingId }, { formData: form });
}

export const listFiles = (listingId) => call('getAllListingFiles', { shop_id: requireShopId(), listing_id: listingId });
export const deleteFile = (listingId, fileId) =>
  call('deleteListingFile', { shop_id: requireShopId(), listing_id: listingId, listing_file_id: fileId });

export const setPersonalization = (listingId, opts) =>
  call('updateListingPersonalization', { shop_id: requireShopId(), listing_id: listingId }, {
    body: {
      is_personalizable: opts.isPersonalizable !== false,
      personalization_is_required: !!opts.isRequired,
      personalization_char_count_max: opts.charCountMax ?? 256,
      personalization_instructions: opts.instructions ?? '',
    },
  });

export const removePersonalization = (listingId) =>
  call('deleteListingPersonalization', { shop_id: requireShopId(), listing_id: listingId });

export const getTranslation = (listingId, language) =>
  call('getListingTranslation', { shop_id: requireShopId(), listing_id: listingId, language });

export const upsertTranslation = async (listingId, language, { title, description, tags }) => {
  const shopId = requireShopId();
  const body = { title, description, ...(tags ? { tags } : {}) };
  try {
    return await call('updateListingTranslation', { shop_id: shopId, listing_id: listingId, language }, { body });
  } catch (err) {
    // No translation exists yet for this language.
    if (err.status === 404) return call('createListingTranslation', { shop_id: shopId, listing_id: listingId, language }, { body });
    throw err;
  }
};

export const listProperties = (listingId) => call('getListingProperties', { shop_id: requireShopId(), listing_id: listingId });
export const setProperty = (listingId, propertyId, body) =>
  call('updateListingProperty', { shop_id: requireShopId(), listing_id: listingId, property_id: propertyId }, { body });
export const deleteProperty = (listingId, propertyId) =>
  call('deleteListingProperty', { shop_id: requireShopId(), listing_id: listingId, property_id: propertyId });

/** Pull one listing fresh from Etsy, including everything attached to it. */
export async function refreshListing(listingId) {
  const listing = await call('getListing', { listing_id: listingId, includes: ['Images', 'Videos', 'Inventory', 'Shipping'] });
  saveListing(listing);
  try { await syncVariationImages(listingId); } catch { /* optional */ }
  return localListing(listingId);
}
