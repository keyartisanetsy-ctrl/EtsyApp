/**
 * Variation + SKU management.
 *
 * Etsy has no "patch one variation" endpoint: PUT /listings/{id}/inventory
 * replaces the whole product array. So every edit here is read-modify-write
 * against the live inventory, and the payload is rebuilt from scratch because
 * Etsy rejects the read-only fields it returns on GET (product_id, offering_id,
 * is_deleted, scale_id on a non-scaled property).
 */
import { call } from '../etsy/client.js';
import { requireShopId, activeShopId } from '../etsy/shop.js';
import { getDb, json, parse, audit } from '../db/index.js';
import { saveInventory, syncVariationImages, variationLabel } from './sync.js';
import { toMajor, discounted, listPriceForTarget } from '../lib/money.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getDiscountPercent } from './settings.js';
import { createLogger } from '../lib/logger.js';
import * as undo from './undo.js';

const log = createLogger('inventory');

/** Strip everything Etsy will not accept back on PUT. */
export function toWritablePayload(inventory) {
  const products = (inventory.products || [])
    .filter((p) => !p.is_deleted)
    .map((p) => ({
      sku: p.sku ?? '',
      property_values: (p.property_values || []).map((pv) => {
        const out = {
          property_id: pv.property_id,
          value_ids: pv.value_ids || [],
          values: pv.values || [],
        };
        // scale_id must be omitted entirely when the property is unscaled.
        if (pv.scale_id != null) out.scale_id = pv.scale_id;
        if (pv.property_name) out.property_name = pv.property_name;
        return out;
      }),
      offerings: (p.offerings || [])
        .filter((o) => !o.is_deleted)
        .map((o) => {
          const offering = {
            price: typeof o.price === 'object' ? toMajor(o.price) : Number(o.price),
            quantity: Number(o.quantity ?? 0),
            is_enabled: o.is_enabled !== false,
          };
          if (o.readiness_state_id != null) offering.readiness_state_id = o.readiness_state_id;
          return offering;
        }),
    }));

  const payload = { products };
  for (const key of ['price_on_property', 'quantity_on_property', 'sku_on_property', 'readiness_state_on_property']) {
    if (Array.isArray(inventory[key]) && inventory[key].length) payload[key] = inventory[key];
  }
  return payload;
}

export const fetchInventory = (listingId) => call('getListingInventory', { listing_id: listingId });

/** Push a rebuilt inventory payload and refresh the local mirror. */
export async function writeInventory(listingId, payload) {
  const res = await call('updateListingInventory', { listing_id: listingId }, { body: payload });
  saveInventory(listingId, res);
  try { await syncVariationImages(listingId); } catch { /* variation images are optional */ }
  return res;
}

/**
 * Apply per-product changes. `changes` is keyed by product_id:
 *   { [product_id]: { sku, price, quantity, is_enabled } }
 * Any product not mentioned is written back unchanged.
 */
export async function updateVariations(listingId, changes, { dryRun = false } = {}) {
  const live = await fetchInventory(listingId);
  const payload = toWritablePayload(live);
  const order = (live.products || []).filter((p) => !p.is_deleted);

  const applied = [];
  order.forEach((product, index) => {
    const change = changes[product.product_id] ?? changes[String(product.product_id)];
    if (!change) return;
    const target = payload.products[index];

    if (change.sku !== undefined) {
      target.sku = change.sku === null ? '' : String(change.sku).trim();
    }
    if (change.price !== undefined && change.price !== null && change.price !== '') {
      const price = Number(change.price);
      if (!Number.isFinite(price) || price < 0) throw badRequest(`Invalid price for product ${product.product_id}`);
      target.offerings.forEach((o) => { o.price = Math.round(price * 100) / 100; });
    }
    if (change.quantity !== undefined && change.quantity !== null && change.quantity !== '') {
      const q = Number(change.quantity);
      if (!Number.isInteger(q) || q < 0) throw badRequest(`Invalid quantity for product ${product.product_id}`);
      target.offerings.forEach((o) => { o.quantity = q; });
    }
    if (change.is_enabled !== undefined) {
      target.offerings.forEach((o) => { o.is_enabled = !!change.is_enabled; });
    }
    applied.push({ product_id: product.product_id, ...change });
  });

  if (!applied.length) throw badRequest('No matching variations to update on this listing.');
  if (dryRun) return { dryRun: true, listingId, applied, payload };

  await writeInventory(listingId, payload);
  audit('inventory.update', { entity: 'listing', entityId: listingId, detail: { applied } });
  log.info(`listing ${listingId}: updated ${applied.length} variation(s)`);
  return { listingId, applied, count: applied.length };
}

/** Clear the SKU string on one or more variations (keeps the variation itself). */
export const clearSkus = (listingId, productIds, opts) =>
  updateVariations(listingId, Object.fromEntries(productIds.map((id) => [id, { sku: '' }])), opts);

/**
 * Remove variations from the listing entirely.
 * Etsy needs at least one product, so the last one can never be dropped.
 */
export async function deleteVariations(listingId, productIds, { dryRun = false } = {}) {
  const live = await fetchInventory(listingId);
  const alive = (live.products || []).filter((p) => !p.is_deleted);
  const drop = new Set(productIds.map(Number));
  const remaining = alive.filter((p) => !drop.has(Number(p.product_id)));

  if (!remaining.length) {
    throw badRequest('A listing must keep at least one variation. Delete the listing instead.');
  }
  if (remaining.length === alive.length) throw notFound('None of those variations exist on this listing.');

  const payload = toWritablePayload({ ...live, products: remaining });
  if (dryRun) return { dryRun: true, listingId, removing: alive.length - remaining.length, payload };

  await writeInventory(listingId, payload);
  audit('inventory.delete', { entity: 'listing', entityId: listingId, detail: { productIds } });
  return { listingId, removed: alive.length - remaining.length, remaining: remaining.length };
}

// ------------------------------------------------------------------ the grid

const GRID_SQL = `
  SELECT
    p.product_id, p.listing_id, p.sku, p.variation_label, p.quantity, p.is_enabled,
    p.price_amount, p.price_divisor, p.price_currency, p.property_values,
    p.variation_image_url, p.variation_image_id,
    l.title, l.state, l.url, l.first_image_url, l.first_image_id,
    l.price_amount AS listing_price_amount, l.price_divisor AS listing_price_divisor,
    l.price_currency AS listing_price_currency, l.shop_section_id, l.quantity AS listing_quantity,
    l.updated_ts,
    m.supply_link, m.variant_supply_link, m.supplier_name, m.variant_image_url,
    m.supply_cost, m.supply_currency, m.lead_time_days, m.notes
  FROM listing_products p
  JOIN listings l ON l.listing_id = p.listing_id
  LEFT JOIN sku_meta m ON m.sku = p.sku AND m.shop_id IS l.shop_id AND p.sku <> ''
  WHERE p.is_deleted = 0
`;

/**
 * One row per variation, carrying everything the SKU screen shows:
 * SKU, title, variation, non-discount price, discounted price, supply link,
 * the listing's first image and the variation's own image.
 */
export function skuGrid({
  search = '', state = '', listingId = null, sectionId = null,
  missingSku = false, missingSupply = false, discountPercent = null,
  sort = 'title', dir = 'asc', limit = 500, offset = 0,
} = {}) {
  const db = getDb();
  const where = ['l.shop_id IS ?'];
  const params = [activeShopId()];

  if (state) { where.push('l.state = ?'); params.push(state); }
  if (listingId) { where.push('p.listing_id = ?'); params.push(listingId); }
  if (sectionId) { where.push('l.shop_section_id = ?'); params.push(sectionId); }
  if (missingSku) where.push("(p.sku IS NULL OR p.sku = '')");
  if (missingSupply) where.push("(m.supply_link IS NULL OR m.supply_link = '')");
  if (search) {
    where.push('(p.sku LIKE ? OR l.title LIKE ? OR p.variation_label LIKE ? OR CAST(p.listing_id AS TEXT) LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const sortable = {
    title: 'l.title', sku: 'p.sku', price: 'p.price_amount', quantity: 'p.quantity',
    state: 'l.state', variation: 'p.variation_label', updated: 'l.updated_ts', listing: 'p.listing_id',
  };
  const orderBy = sortable[sort] || 'l.title';
  const order = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const clause = ` AND ${where.join(' AND ')}`;
  const rows = db.prepare(
    `${GRID_SQL}${clause} ORDER BY ${orderBy} ${order}, p.product_id ASC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM listing_products p JOIN listings l ON l.listing_id = p.listing_id
     LEFT JOIN sku_meta m ON m.sku = p.sku AND m.shop_id IS l.shop_id AND p.sku <> '' WHERE p.is_deleted = 0${clause}`,
  ).get(...params).c;

  const pct = discountPercent ?? getDiscountPercent();

  return {
    total,
    limit,
    offset,
    discountPercent: pct,
    rows: rows.map((r) => {
      const currency = r.price_currency || r.listing_price_currency;
      const listPrice = r.price_amount != null
        ? r.price_amount / (r.price_divisor || 100)
        : r.listing_price_amount != null
          ? r.listing_price_amount / (r.listing_price_divisor || 100)
          : null;
      const cost = r.supply_cost ?? null;
      const sale = discounted(listPrice, pct);
      return {
        productId: r.product_id,
        listingId: r.listing_id,
        sku: r.sku || '',
        title: r.title,
        state: r.state,
        listingUrl: r.url,
        variation: r.variation_label || '',
        properties: parse(r.property_values, []),
        quantity: r.quantity ?? r.listing_quantity,
        isEnabled: !!r.is_enabled,
        currency,
        // "Non-discount price" is the price Etsy holds; the sale price is
        // what the buyer pays once the shop's running discount applies.
        priceFull: listPrice,
        priceDiscounted: sale,
        margin: cost != null && sale != null ? Math.round((sale - cost) * 100) / 100 : null,
        marginPercent: cost != null && sale && sale > 0
          ? Math.round(((sale - cost) / sale) * 1000) / 10
          : null,
        supplyLink: r.supply_link || '',
        variantSupplyLink: r.variant_supply_link || '',
        supplierName: r.supplier_name || '',
        // The photo you saved for this variant, else the one Etsy has for it.
        variantImageUrl: r.variant_image_url || r.variation_image_url || '',
        savedVariantImageUrl: r.variant_image_url || '',
        supplyCost: cost,
        supplyCurrency: r.supply_currency || null,
        leadTimeDays: r.lead_time_days ?? null,
        notes: r.notes || '',
        firstImageUrl: r.first_image_url,
        firstImageId: r.first_image_id,
        variationImageUrl: r.variation_image_url,
        variationImageId: r.variation_image_id,
        sectionId: r.shop_section_id,
        updatedTs: r.updated_ts,
      };
    }),
  };
}

/** Reverse pricing helper: what list price hits a target after the discount. */
export const priceForTarget = (target, percent = getDiscountPercent()) =>
  listPriceForTarget(target, percent);

// -------------------------------------------------------------- supply links

export function setSkuMeta(sku, meta = {}) {
  if (!sku) throw badRequest('A SKU is required to attach supply information.');
  const db = getDb();
  const shopId = activeShopId();
  // Keep the previous supply record so a pasted-over link can be taken back.
  const handle = undo.begin({
    label: `Supply record for ${sku}`,
    kind: 'sku.meta',
    targets: [{ table: 'sku_meta', where: 'shop_id IS ? AND sku = ?', params: [shopId, sku] }],
  });
  const existing = db.prepare('SELECT * FROM sku_meta WHERE shop_id IS ? AND sku = ?').get(shopId, sku) || {};
  const merged = {
    supply_link: meta.supplyLink ?? existing.supply_link ?? '',
    variant_supply_link: meta.variantSupplyLink ?? existing.variant_supply_link ?? '',
    supplier_name: meta.supplierName ?? existing.supplier_name ?? '',
    variant_image_url: meta.variantImageUrl ?? existing.variant_image_url ?? '',
    supply_cost: meta.supplyCost === '' ? null : meta.supplyCost ?? existing.supply_cost ?? null,
    // Costs here are what you pay the supplier, which is in yuan far more often
    // than not, so that is the default rather than dollars.
    supply_currency: meta.supplyCurrency ?? existing.supply_currency ?? 'CNY',
    lead_time_days: meta.leadTimeDays === '' ? null : meta.leadTimeDays ?? existing.lead_time_days ?? null,
    notes: meta.notes ?? existing.notes ?? '',
  };
  db.prepare(`
    INSERT INTO sku_meta (shop_id, sku, supply_link, variant_supply_link, supplier_name, variant_image_url,
      supply_cost, supply_currency, lead_time_days, notes, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(shop_id, sku) DO UPDATE SET supply_link=excluded.supply_link,
      variant_supply_link=excluded.variant_supply_link, supplier_name=excluded.supplier_name,
      variant_image_url=excluded.variant_image_url,
      supply_cost=excluded.supply_cost, supply_currency=excluded.supply_currency,
      lead_time_days=excluded.lead_time_days, notes=excluded.notes, updated_at=datetime('now')`)
    .run(shopId, sku, merged.supply_link, merged.variant_supply_link, merged.supplier_name,
         merged.variant_image_url, merged.supply_cost,
         merged.supply_currency, merged.lead_time_days, merged.notes);
  const undoId = undo.commit(handle, { affected: 1 });
  return { sku, ...merged, undoId };
}

export const getSkuMeta = (sku) =>
  getDb().prepare('SELECT * FROM sku_meta WHERE shop_id IS ? AND sku = ?').get(activeShopId(), sku) || null;
export const deleteSkuMeta = (sku) =>
  getDb().prepare('DELETE FROM sku_meta WHERE shop_id IS ? AND sku = ?').run(activeShopId(), sku);

/** Flag SKUs used by more than one variation - usually a copy/paste slip. */
export function duplicateSkus() {
  return getDb().prepare(`
    SELECT p.sku, COUNT(*) AS uses,
           json_group_array(json_object('productId', p.product_id, 'listingId', p.listing_id, 'title', l.title)) AS rows
    FROM listing_products p JOIN listings l ON l.listing_id = p.listing_id
    WHERE p.sku <> '' AND p.is_deleted = 0 AND l.shop_id IS ?
    GROUP BY p.sku HAVING COUNT(*) > 1 ORDER BY uses DESC`)
    // Duplicates are only meaningful within one shop; a coincidence with
    // another connected shop's SKU is not a mistake worth flagging.
    .all(activeShopId()).map((r) => ({ sku: r.sku, uses: r.uses, rows: parse(r.rows, []) }));
}

export { variationLabel };
