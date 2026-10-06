/**
 * Warehouse-photo check: is the parcel about to ship actually the product
 * that was ordered?
 *
 * The seller can always compare the warehouse photo against the listing
 * photo by eye - that is the default. This adds an optional second opinion
 * from a vision-capable AI, the same "ask, store the verdict" shape as
 * addresscheck.js, so a wrong item is caught before it ships rather than
 * after a buyer complains.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { outboundFetch } from '../lib/outbound.js';
import { sha256 } from '../lib/crypto.js';
import { readSetting } from './settings.js';
import { run, parseJsonish } from './ai/index.js';

const ITEM_TABLES = {
  etsy: { table: 'receipt_transactions', idColumn: 'transaction_id', orderColumn: 'receipt_id' },
  shopify: { table: 'shopify_order_line_items', idColumn: 'line_item_id', orderColumn: 'order_id' },
};

function itemFor(channel, itemId) {
  const spec = ITEM_TABLES[channel];
  if (!spec) throw badRequest(`Unknown channel "${channel}".`);
  return getDb().prepare(
    `SELECT ${spec.idColumn} AS id, title, sku, image_url, warehouse_photo_id FROM ${spec.table} WHERE ${spec.idColumn} = ?`,
  ).get(itemId);
}

/** Every item on one order, for the "one shared warehouse photo" check below. */
function itemsForOrder(channel, orderId) {
  const spec = ITEM_TABLES[channel];
  if (!spec) throw badRequest(`Unknown channel "${channel}".`);
  return getDb().prepare(
    `SELECT ${spec.idColumn} AS id, title, sku, image_url, warehouse_photo_id FROM ${spec.table} WHERE ${spec.orderColumn} = ?`,
  ).all(orderId);
}

/** Reuse a cached copy of the same listing photo instead of re-downloading it every check. */
export async function cachedProductImageId(url) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM attachments WHERE purpose = 'product-image-cache' AND filename = ?").get(url);
  if (existing) return existing.id;

  const res = await outboundFetch(url, { headers: { Accept: 'image/*' } });
  if (!res.ok) throw badRequest(`Could not download the product photo (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/jpeg';

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const id = `att_${crypto.randomBytes(8).toString('hex')}`;
  const dest = path.join(config.uploadDir, `${id}${mime.includes('png') ? '.png' : '.jpg'}`);
  fs.writeFileSync(dest, buf);
  db.prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
    .run(id, url, mime, buf.length, dest, sha256(buf), 'product-image-cache');
  return id;
}

const AI_SYSTEM = `You check whether two product photos show the same item, for an online shop
about to ship a parcel.

The FIRST image is a photo taken at the warehouse of the item about to be packed. The SECOND
image is the shop's own listing photo of the product that was ordered. Decide whether the
warehouse photo is plausibly the same product - not a pixel-identical match, since lighting,
angle, background and packaging differ, but the same item.

Look past the general category of product and check the actual details, the same way a careful
seller would before sealing the box:
- Shape and silhouette - the overall form and outline, not just "it's a similar-looking thing".
- Proportions and size - relative dimensions, thickness, length, how parts relate to each other.
- Material and texture - fabric vs. leather vs. plastic vs. metal, matte vs. glossy, etc.
- Colour and pattern - exact shade, any print, stripes, gradient, or trim, not just "both blue".
- Small features - a clasp, buckle, seam, stitching pattern, logo, engraving, printed text, or
  any personalization the buyer chose - these often distinguish two otherwise similar items.
- Quantity and set contents - the right number of pieces, and the right pieces, if it is a set.

Be careful:
- A product shown from a different angle, in different lighting, or already boxed is still a
  match if all of the above genuinely line up.
- Flag a mismatch when you can point to a real difference in any of the details above - do not
  wave it through just because it is broadly "the same kind of product".
- If the warehouse photo is unclear, too dark, or does not show enough of the product to judge
  the details above, say you are unsure rather than guessing.

Reply with JSON only:
{"verdict":"match"|"mismatch"|"unsure",
 "confidence":0.0-1.0,
 "summary":"one short line the seller can read at a glance - name the specific detail checked
   or, on a mismatch, the specific detail that differs (shape, colour, size, a missing feature, etc.)"}`;

const GROUP_AI_SYSTEM = `You check whether a single warehouse photo actually shows the products an
online shop is about to ship, for a multi-item order that was packed and photographed together
rather than one photo per product.

The FIRST image is one photo taken at the warehouse of everything about to be packed for this
order - it may show several products side by side, stacked, or already boxed together. Every
image AFTER the first is the shop's own listing photo for one product that was ordered, numbered
in the order given (product 1, product 2, ...).

For EACH numbered product, decide whether you can find it in the warehouse photo. Use the same
care a seller would use checking by eye before sealing the box:
- Shape, silhouette, proportions and size.
- Material, texture, colour and pattern.
- Small features - a clasp, buckle, seam, logo, engraving, printed text or personalization.
- Quantity - if the order calls for more than one of something, look for that many.

Be careful:
- Items overlapping, partly hidden behind each other, boxed, or shot at an angle can still count
  as found if the details above genuinely line up - a group photo is inherently more cluttered
  than a single product shot.
- Mark a product "missing" only when it is plausibly absent, not just harder to see - if the photo
  is unclear or does not show enough to judge one product, mark that one "unsure" rather than
  guessing, without letting it affect the others.
- A product does not need to be centered or alone in the frame to count as found.

Reply with JSON only:
{"items":[{"index":1,"verdict":"found"|"missing"|"unsure","note":"one short line - the detail
  that confirmed it, or the detail that could not be confirmed"}, ...],
 "summary":"one short line covering the whole order, for the seller to read at a glance"}
The "items" array must have exactly as many entries as there are numbered product photos, in the
same order, using the same "index" numbers.`;

/**
 * Compare one item's warehouse photo against its own listing photo.
 * `provider`/`model` let a careful model be picked for the orders that
 * matter, or a quick one for a sweep.
 */
export async function checkItem({ channel, itemId, provider, model, runner = run } = {}) {
  const item = itemFor(channel, itemId);
  if (!item) throw notFound(`Item ${itemId} not found.`);
  if (!item.warehouse_photo_id) throw badRequest('Upload the warehouse photo for this item first.');
  if (!item.image_url) throw badRequest('This item has no listing photo to compare against.');

  const result = {
    channel, itemId: item.id, verdict: 'unsure', confidence: null, summary: '',
    provider: null, model: null, checkedAt: new Date().toISOString(),
  };

  try {
    const productAttachmentId = await cachedProductImageId(item.image_url);
    const chosenProvider = provider || readSetting('ai.warehouse.provider') || undefined;
    const chosenModel = model || readSetting('ai.warehouse.model') || undefined;

    const ai = await runner({
      kind: 'custom',
      provider: chosenProvider,
      model: chosenModel,
      promptOverride: AI_SYSTEM,
      attachmentIds: [item.warehouse_photo_id, productAttachmentId],
      context: { title: item.title || '', sku: item.sku || '' },
      userInput: 'The first image is the warehouse photo, the second the listing photo. Compare them. JSON only.',
      maxTokens: 500,
    });

    const parsed = parseJsonish(ai.text);
    if (parsed) {
      const verdicts = ['match', 'mismatch', 'unsure'];
      result.verdict = verdicts.includes(parsed.verdict) ? parsed.verdict : 'unsure';
      result.confidence = Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null;
      result.summary = String(parsed.summary ?? '').slice(0, 300);
      result.provider = ai.provider;
      result.model = ai.model;
    } else {
      result.summary = 'The AI did not return a usable answer.';
    }
  } catch (err) {
    result.summary = err.message;
  }

  getDb().prepare(`
    INSERT INTO warehouse_checks (channel, item_id, verdict, confidence, summary, provider, model, checked_at)
    VALUES (?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(channel, item_id) DO UPDATE SET
      verdict = excluded.verdict, confidence = excluded.confidence, summary = excluded.summary,
      provider = excluded.provider, model = excluded.model, checked_at = datetime('now')`)
    .run(channel, String(item.id), result.verdict, result.confidence, result.summary, result.provider, result.model);

  return result;
}

/**
 * Compare ONE shared warehouse photo - whichever item on the order already
 * has one attached - against every item's own listing photo in a single AI
 * call, and store a verdict for each item exactly as `checkItem` would. This
 * is for the common case of one packing photo showing everything in a
 * multi-item order, rather than a separate warehouse photo per product.
 */
export async function checkOrder({ channel, orderId, provider, model, runner = run } = {}) {
  const items = itemsForOrder(channel, orderId);
  if (!items.length) throw notFound(`Order ${orderId} not found.`);

  const photoItem = items.find((it) => it.warehouse_photo_id);
  if (!photoItem) throw badRequest('Upload a warehouse photo for at least one item first.');
  const targets = items.filter((it) => it.image_url);
  if (!targets.length) throw badRequest('None of these items has a listing photo to compare against.');

  const results = targets.map((it) => ({
    channel, itemId: it.id, verdict: 'unsure', confidence: null, summary: '',
    provider: null, model: null, checkedAt: new Date().toISOString(),
  }));

  try {
    const productAttachmentIds = [];
    for (const it of targets) productAttachmentIds.push(await cachedProductImageId(it.image_url));
    const chosenProvider = provider || readSetting('ai.warehouse.provider') || undefined;
    const chosenModel = model || readSetting('ai.warehouse.model') || undefined;

    const ai = await runner({
      kind: 'custom',
      provider: chosenProvider,
      model: chosenModel,
      promptOverride: GROUP_AI_SYSTEM,
      attachmentIds: [photoItem.warehouse_photo_id, ...productAttachmentIds],
      context: { products: targets.map((it, i) => ({ index: i + 1, title: it.title || '', sku: it.sku || '' })) },
      userInput: 'The first image is the warehouse photo. Each image after it is one numbered product listing photo, in order. JSON only.',
      maxTokens: 800,
    });

    const parsed = parseJsonish(ai.text);
    const verdictMap = { found: 'match', missing: 'mismatch', unsure: 'unsure' };
    const byIndex = new Map((Array.isArray(parsed?.items) ? parsed.items : []).map((e) => [Number(e.index), e]));
    const overallSummary = parsed?.summary ? String(parsed.summary).slice(0, 300) : '';

    results.forEach((r, i) => {
      if (!parsed) { r.summary = 'The AI did not return a usable answer.'; return; }
      const entry = byIndex.get(i + 1);
      r.verdict = verdictMap[entry?.verdict] || 'unsure';
      r.summary = (entry?.note ? String(entry.note) : overallSummary).slice(0, 300);
      r.provider = ai.provider;
      r.model = ai.model;
    });
  } catch (err) {
    for (const r of results) r.summary = err.message;
  }

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO warehouse_checks (channel, item_id, verdict, confidence, summary, provider, model, checked_at)
    VALUES (?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(channel, item_id) DO UPDATE SET
      verdict = excluded.verdict, confidence = excluded.confidence, summary = excluded.summary,
      provider = excluded.provider, model = excluded.model, checked_at = datetime('now')`);
  db.transaction((rows) => {
    for (const r of rows) upsert.run(channel, String(r.itemId), r.verdict, r.confidence, r.summary, r.provider, r.model);
  })(results);

  return { channel, orderId, warehousePhotoItemId: photoItem.id, results };
}

/** What we last decided about one item's warehouse photo. */
export function getCheck(channel, itemId) {
  const row = getDb().prepare('SELECT * FROM warehouse_checks WHERE channel = ? AND item_id = ?').get(channel, String(itemId));
  if (!row) return null;
  return {
    channel: row.channel,
    itemId: row.item_id,
    verdict: row.verdict,
    confidence: row.confidence,
    summary: row.summary,
    provider: row.provider,
    model: row.model,
    checkedAt: row.checked_at,
  };
}
