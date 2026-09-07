/**
 * Making up SKUs, either by a rule or by asking the AI.
 *
 * The shape wanted here is a product prefix plus a running number, and a second
 * number for each variation of that product:
 *
 *     KC001-01, KC001-02, KC001-03   (three variants of the first product)
 *     KC002-01, KC002-02             (two variants of the next one)
 *
 * Two rules that matter more than the format:
 *   - a SKU already in use is never handed out again, whichever product it
 *     belongs to, because a duplicate SKU quietly breaks stock and supply
 *     links;
 *   - a variation that already has a SKU keeps it unless you say otherwise,
 *     so running this over the catalogue does not churn codes that are already
 *     printed on labels and sitting in supplier sheets.
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { readSetting } from './settings.js';
import { badRequest } from '../lib/errors.js';
import { run, parseJsonish } from './ai/index.js';

export const DEFAULT_PREFIX = 'KC';
export const DEFAULT_PATTERN = '{PREFIX}{PRODUCT}-{VARIANT}';

const pad = (n, width) => String(n).padStart(width, '0');

/** Fill the pattern for one product/variant pair. */
export function formatSku(prefix, productNo, variantNo, pattern = DEFAULT_PATTERN,
  { productWidth = 3, variantWidth = 2 } = {}) {
  return pattern
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{PRODUCT\}/g, pad(productNo, productWidth))
    .replace(/\{VARIANT\}/g, pad(variantNo, variantWidth));
}

/** Every SKU this shop already uses, so a new one never collides. */
export function usedSkus(shopId = activeShopId()) {
  const rows = getDb().prepare(`
    SELECT DISTINCT p.sku FROM listing_products p
    JOIN listings l ON l.listing_id = p.listing_id
    WHERE l.shop_id IS ? AND p.sku IS NOT NULL AND p.sku <> ''`).all(shopId);
  const fromMeta = getDb().prepare('SELECT sku FROM sku_meta WHERE shop_id IS ?').all(shopId);
  return new Set([...rows.map((r) => r.sku), ...fromMeta.map((r) => r.sku)]);
}

/**
 * The highest product number already used under a prefix, so the next product
 * carries on from it instead of starting at 1 and colliding.
 */
export function highestProductNumber(prefix, shopId = activeShopId()) {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`, 'i');
  let top = 0;
  for (const sku of usedSkus(shopId)) {
    const m = re.exec(sku);
    if (m) top = Math.max(top, Number(m[1]) || 0);
  }
  return top;
}

/**
 * Propose SKUs for whole listings.
 *
 * Nothing is written: this returns what it would do, so it can be shown and
 * approved first. `apply` then writes exactly what was approved.
 */
export function planByRule({ listingIds = [], prefix = null, pattern = null,
  overwrite = false, startAt = null, shopId = activeShopId() } = {}) {
  const db = getDb();
  if (!listingIds.length) throw badRequest('Pick at least one listing.');

  const usedPrefix = (prefix || readSetting('sku.prefix') || DEFAULT_PREFIX).toUpperCase();
  const usedPattern = pattern || readSetting('sku.pattern') || DEFAULT_PATTERN;
  const taken = usedSkus(shopId);

  let productNo = Number.isFinite(startAt) && startAt > 0
    ? startAt
    : highestProductNumber(usedPrefix, shopId) + 1;

  const holes = listingIds.map(() => '?').join(',');
  const listings = db.prepare(`
    SELECT listing_id, title FROM listings WHERE shop_id IS ? AND listing_id IN (${holes})
    ORDER BY listing_id`).all(shopId, ...listingIds);

  const plan = [];
  for (const listing of listings) {
    const products = db.prepare(`
      SELECT product_id, sku, variation_label FROM listing_products
      WHERE listing_id = ? AND is_deleted = 0 ORDER BY product_id`).all(listing.listing_id);
    if (!products.length) continue;

    const rows = [];
    let variantNo = 1;
    for (const p of products) {
      if (p.sku && !overwrite) {
        // Already labelled: leave it be, and say so rather than silently skipping.
        rows.push({ productId: p.product_id, variation: p.variation_label || '', current: p.sku,
          sku: p.sku, kept: true, reason: 'already has a SKU' });
        continue;
      }
      let candidate = formatSku(usedPrefix, productNo, variantNo, usedPattern);
      while (taken.has(candidate)) {
        variantNo += 1;
        candidate = formatSku(usedPrefix, productNo, variantNo, usedPattern);
      }
      taken.add(candidate);
      rows.push({ productId: p.product_id, variation: p.variation_label || '', current: p.sku || '',
        sku: candidate, kept: false });
      variantNo += 1;
    }

    plan.push({ listingId: listing.listing_id, title: listing.title, rows });
    // Only advance the product number when this listing actually used it.
    if (rows.some((r) => !r.kept)) productNo += 1;
  }

  return {
    mode: 'rule',
    prefix: usedPrefix,
    pattern: usedPattern,
    listings: plan,
    total: plan.reduce((n, l) => n + l.rows.filter((r) => !r.kept).length, 0),
    kept: plan.reduce((n, l) => n + l.rows.filter((r) => r.kept).length, 0),
  };
}

const AI_SYSTEM = `You assign stock codes (SKUs) to a shop's products.

You get a list of listings, each with its title and its variations, plus the codes already in use.

Rules:
- Give every product a short prefix of 2-4 uppercase letters that reflects what it is
  (a keycap set might be KC, a deskmat DM, a ring RG). Products of the same kind share a prefix.
- Number products within a prefix in the order given, and number the variations inside each product
  from 01 upwards, so a three-variant product reads KC001-01, KC001-02, KC001-03.
- Never reuse a code from the "already in use" list.
- Never give two different variations the same code.
- Keep the exact format <PREFIX><3-digit product>-<2-digit variant>.

Reply with JSON only:
{"listings":[{"listingId":123,"prefix":"KC","rows":[{"productId":456,"sku":"KC001-01"}]}]}`;

/**
 * The same plan, but with the AI choosing prefixes from what the products
 * actually are. The answer is checked against the real products and the codes
 * already in use before it is shown, so a hallucinated id or a duplicate is
 * dropped rather than saved.
 */
export async function planByAi({ listingIds = [], provider, shopId = activeShopId(), runner = run } = {}) {
  const db = getDb();
  if (!listingIds.length) throw badRequest('Pick at least one listing.');

  const holes = listingIds.map(() => '?').join(',');
  const listings = db.prepare(`
    SELECT listing_id, title FROM listings WHERE shop_id IS ? AND listing_id IN (${holes})`)
    .all(shopId, ...listingIds);

  const byListing = new Map();
  for (const l of listings) {
    byListing.set(l.listing_id, db.prepare(`
      SELECT product_id, sku, variation_label FROM listing_products
      WHERE listing_id = ? AND is_deleted = 0 ORDER BY product_id`).all(l.listing_id));
  }

  const taken = usedSkus(shopId);
  const context = {
    alreadyInUse: [...taken].slice(0, 200),
    listings: listings.map((l) => ({
      listingId: l.listing_id,
      title: l.title,
      variations: (byListing.get(l.listing_id) ?? []).map((p) => ({
        productId: p.product_id, variation: p.variation_label || '', currentSku: p.sku || null,
      })),
    })),
  };

  const result = await runner({
    kind: 'custom', provider, promptOverride: AI_SYSTEM, context,
    userInput: 'Assign the codes now. JSON only.', maxTokens: 3000,
  });

  const parsed = parseJsonish(result.text);
  if (!parsed) throw badRequest('The AI did not return usable SKUs. Try again, or use the rule instead.');

  const validProducts = new Map();
  for (const [listingId, products] of byListing) {
    for (const p of products) validProducts.set(p.product_id, { listingId, product: p });
  }

  const seen = new Set();
  const dropped = [];
  const perListing = new Map();

  for (const l of parsed.listings ?? []) {
    for (const row of l.rows ?? []) {
      const known = validProducts.get(row.productId);
      if (!known) { dropped.push(`unknown variation ${row.productId}`); continue; }
      const sku = String(row.sku ?? '').trim().toUpperCase();
      if (!sku) { dropped.push(`empty code for ${row.productId}`); continue; }
      if (taken.has(sku) && known.product.sku !== sku) { dropped.push(`${sku} is already in use`); continue; }
      if (seen.has(sku)) { dropped.push(`${sku} proposed twice`); continue; }
      seen.add(sku);

      const listingId = known.listingId;
      if (!perListing.has(listingId)) perListing.set(listingId, []);
      perListing.get(listingId).push({
        productId: row.productId,
        variation: known.product.variation_label || '',
        current: known.product.sku || '',
        sku,
        kept: false,
      });
    }
  }

  const plan = listings
    .filter((l) => perListing.has(l.listing_id))
    .map((l) => ({ listingId: l.listing_id, title: l.title, rows: perListing.get(l.listing_id) }));

  return {
    mode: 'ai',
    provider: result.provider,
    model: result.model,
    listings: plan,
    dropped,
    total: plan.reduce((n, l) => n + l.rows.length, 0),
    kept: 0,
  };
}

/**
 * Write an approved plan to the local mirror.
 *
 * This does not touch Etsy: pushing SKUs upstream is a bulk job, which goes
 * through the write queue one listing at a time.
 */
export function applyPlan(plan) {
  const db = getDb();
  const shopId = activeShopId();
  let updated = 0;

  db.transaction(() => {
    for (const listing of plan?.listings ?? []) {
      for (const row of listing.rows ?? []) {
        if (row.kept || !row.sku) continue;
        db.prepare(`UPDATE listing_products SET sku = ? WHERE product_id = ? AND listing_id = ?`)
          .run(row.sku, row.productId, listing.listingId);
        updated += 1;
      }
    }
  })();

  return { updated, shopId };
}
