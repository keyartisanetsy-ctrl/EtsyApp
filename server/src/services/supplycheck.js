/**
 * Supplier stock for a variant, and whether the supplier page is really the
 * product we sell.
 *
 * The stock itself is the existing paid OneBound check (services/taobao.js) -
 * run only when someone presses the button, never in the background. What this
 * adds is the second look at its answer: the supplier API also returns the
 * pictures of the listing it found, and a wrong link (an older listing, a
 * different design from the same shop) is the commonest way a stock check
 * quietly answers the wrong question. So our own picture of the variant is held
 * against the first two pictures the API returns:
 *
 *   colours  free, immediate - the colour fingerprint of imagesig.js;
 *   AI       one quick, small call, only when asked - for when the colours are
 *            not conclusive or the product is one where colours are the same.
 */
import { getDb, audit } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import * as taobao from './taobao.js';
import * as catalog from './catalog.js';
import { cachedProductImageId } from './warehousecheck.js';
import { signatureFor, similarity } from './imagesig.js';
import { run, parseJsonish } from './ai/index.js';
import { readSetting } from './settings.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The supplier page for this variant: its own link when it has one, else the product's. */
export const linkOf = (row) => row.variantSupplyLink || row.supplyLink || '';
export const oursUrl = (row) => row.variantImageUrl || row.coverUrl || '';

/** What the cached stock check says about this variant's link, without spending a call. */
function describe(row, result) {
  const link = linkOf(row);
  const parsed = taobao.parseSupplyUrl(link);
  if (!result) return { link, supplier: parsed.supplier ?? null, itemId: parsed.itemId ?? null, checked: false };
  // The variant the link itself names, when it names one.
  const v = parsed.skuId ? (result.variants ?? []).find((x) => x.skuId === parsed.skuId) : null;
  return {
    link, supplier: result.supplier, itemId: result.itemId, checked: true, checkedAt: result.checkedAt,
    inStock: result.inStock, allVariantsOut: result.allVariantsOut, delisted: !!result.delisted,
    summary: result.summary ?? (result.inStock ? 'In stock' : 'Out of stock'),
    variant: v ? { label: v.label, quantity: v.quantity, outOfStock: v.outOfStock, reason: v.reason } : null,
    variantCount: (result.variants ?? []).length,
    outCount: (result.variants ?? []).filter((x) => x.outOfStock).length,
    images: result.images ?? [],
  };
}

function storedImageCheck(supplier, itemId, url) {
  const r = getDb().prepare('SELECT * FROM supplier_image_checks WHERE supplier = ? AND item_id = ? AND ours_url = ?').get(supplier, itemId, url);
  return r ? { similarity: r.similarity, which: r.which, verdict: r.verdict, byAi: !!r.by_ai, summary: r.summary, checkedAt: r.checked_at } : null;
}

/** The last stock check (and picture check) for many variants at once - free. */
export function cachedFor(keys = []) {
  const out = {};
  for (const key of keys) {
    let row;
    try { row = catalog.getRow(key); } catch { continue; }
    const parsed = taobao.parseSupplyUrl(linkOf(row));
    if (!parsed.ok || !parsed.itemId) { out[key] = { link: linkOf(row), checked: false, noItem: !!linkOf(row) }; continue; }
    const cached = taobao.cachedStock({ supplier: parsed.supplier, itemId: parsed.itemId });
    const d = describe(row, cached);
    const ours = oursUrl(row);
    d.image = ours ? storedImageCheck(parsed.supplier, parsed.itemId, ours) : null;
    out[key] = d;
  }
  return out;
}

// ------------------------------------------------------------- pictures

/** Colour likeness of our picture to the first two of theirs; the verdict follows from the best. */
export async function compareColours(ours, theirs) {
  const urls = (theirs ?? []).slice(0, 2);
  if (!ours) throw badRequest('This variant has no picture of its own to compare.');
  if (!urls.length) throw badRequest('The supplier answer carried no pictures - check the stock again to get them.');
  const mine = signatureFor(await cachedProductImageId(ours));
  if (!mine) throw badRequest('Our picture could not be read (it may not be a JPEG or PNG).');
  let best = null;
  for (let i = 0; i < urls.length; i += 1) {
    try {
      const sig = signatureFor(await cachedProductImageId(urls[i]));
      const sim = sig ? similarity(mine, sig) : null;
      if (sim != null && (!best || sim > best.sim)) best = { sim, which: i + 1 };
    } catch { /* a picture that will not load just does not count */ }
  }
  if (!best) throw badRequest('None of the supplier pictures could be loaded.');
  const verdict = best.sim >= 0.8 ? 'match' : best.sim >= 0.62 ? 'unsure' : 'mismatch';
  return { similarity: round2(best.sim), which: best.which, verdict };
}

const AI_SYSTEM = `You check that a supplier's product page sells the product an online shop sells.

The FIRST image is the shop's own photo of the product. The SECOND image (and a THIRD, if there is
one) are the first pictures the supplier's listing shows. The pictures will differ - lighting,
angle, background, packaging, watermarks - so look at the product itself: its design, colours,
shape, printed artwork, how many pieces it has.

Say whether the supplier listing is the same product (or the same product in the same design).
A different design, character or colourway from the same supplier is a mismatch. If the pictures do
not show enough to tell, say unsure.

Reply with JSON only:
{"verdict":"match"|"mismatch"|"unsure","which":1|2|null,"confidence":0.0-1.0,
 "summary":"one short line: what matched, or what differs"}
"which" is which supplier picture (1 = the second image overall, 2 = the third) looks most like ours.`;

/** One quick AI look at ours against the supplier's first two pictures. */
export async function compareWithAi(ours, theirs, { provider, model, runner = run } = {}) {
  const urls = (theirs ?? []).slice(0, 2);
  if (!ours) throw badRequest('This variant has no picture of its own to compare.');
  if (!urls.length) throw badRequest('The supplier answer carried no pictures - check the stock again to get them.');
  const ids = [await cachedProductImageId(ours)];
  for (const u of urls) { try { ids.push(await cachedProductImageId(u)); } catch { /* skipped */ } }
  if (ids.length < 2) throw badRequest('None of the supplier pictures could be loaded.');
  const ai = await runner({
    kind: 'custom',
    provider: provider || readSetting('ai.warehouse.provider') || undefined,
    model: model || readSetting('ai.warehouse.model') || undefined,
    promptOverride: AI_SYSTEM,
    attachmentIds: ids.map((id) => ({ id, detail: 'low' })),
    effort: 'fast',
    userInput: 'The first image is our photo; the others are the supplier listing\'s first pictures. JSON only.',
    maxTokens: 400,
  });
  const parsed = parseJsonish(ai.text);
  if (!parsed) throw badRequest('The AI did not return a usable answer.');
  const verdict = ['match', 'mismatch', 'unsure'].includes(parsed.verdict) ? parsed.verdict : 'unsure';
  return {
    verdict, which: [1, 2].includes(Number(parsed.which)) ? Number(parsed.which) : null,
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
    summary: String(parsed.summary ?? '').slice(0, 300), provider: ai.provider, model: ai.model,
  };
}

function saveImageCheck(supplier, itemId, url, c, byAi) {
  getDb().prepare(`
    INSERT INTO supplier_image_checks (supplier, item_id, ours_url, similarity, which, verdict, by_ai, summary, checked_at)
    VALUES (?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(supplier, item_id, ours_url) DO UPDATE SET similarity = COALESCE(excluded.similarity, supplier_image_checks.similarity),
      which = excluded.which, verdict = excluded.verdict, by_ai = excluded.by_ai, summary = excluded.summary, checked_at = datetime('now')`)
    .run(supplier, itemId, url, c.similarity ?? null, c.which ?? null, c.verdict, byAi ? 1 : 0, c.summary ?? null);
}

// -------------------------------------------------------------- checking

/**
 * Ask the supplier API (paid) for this variant's link, then hold our picture
 * against the pictures it returns. The picture check is free and never makes
 * the stock answer fail.
 */
export async function check(key, { checker = taobao.checkStockByUrl } = {}) {
  const row = catalog.getRow(key);
  const link = linkOf(row);
  if (!link) throw badRequest('This variant has no supplier link yet.');
  const result = await checker(link);
  const d = describe(row, result);
  const ours = oursUrl(row);
  d.image = null;
  if (ours && (result.images ?? []).length) {
    try {
      const c = await compareColours(ours, result.images);
      saveImageCheck(result.supplier, result.itemId, ours, c, false);
      d.image = storedImageCheck(result.supplier, result.itemId, ours);
    } catch (err) { d.imageError = err.message; }
  } else if (ours) d.imageError = 'The supplier answer carried no pictures to compare.';
  return d;
}

/** The AI's verdict on the same question, for when colours alone are not enough. */
export async function checkImageWithAi(key, opts = {}) {
  const row = catalog.getRow(key);
  const parsed = taobao.parseSupplyUrl(linkOf(row));
  if (!parsed.ok || !parsed.itemId) throw badRequest('This variant has no supplier link yet.');
  const cached = taobao.cachedStock({ supplier: parsed.supplier, itemId: parsed.itemId });
  if (!cached) throw badRequest('Check the stock first - the supplier pictures come with that answer.');
  const ours = oursUrl(row);
  const c = await compareWithAi(ours, cached.images, opts);
  saveImageCheck(parsed.supplier, parsed.itemId, ours, c, true);
  audit('catalog.image_check', { entity: 'supplier_item', entityId: `${parsed.supplier}:${parsed.itemId}`, detail: { key, verdict: c.verdict } });
  return { ...describe(row, cached), image: storedImageCheck(parsed.supplier, parsed.itemId, ours) };
}

