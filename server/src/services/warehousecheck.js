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
  etsy: { table: 'receipt_transactions', idColumn: 'transaction_id' },
  shopify: { table: 'shopify_order_line_items', idColumn: 'line_item_id' },
};

function itemFor(channel, itemId) {
  const spec = ITEM_TABLES[channel];
  if (!spec) throw badRequest(`Unknown channel "${channel}".`);
  return getDb().prepare(
    `SELECT ${spec.idColumn} AS id, title, sku, image_url, warehouse_photo_id FROM ${spec.table} WHERE ${spec.idColumn} = ?`,
  ).get(itemId);
}

/** Reuse a cached copy of the same listing photo instead of re-downloading it every check. */
async function cachedProductImageId(url) {
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
angle, background and packaging differ, but the same item, colour and style.

Be careful:
- A product shown from a different angle, in different lighting, or already boxed is still a
  match if it is the same item.
- Flag a mismatch only when you can point to a real difference - a different colour, shape,
  pattern, size, or an entirely different product.
- If the warehouse photo is unclear, too dark, or does not show the product clearly enough to
  judge, say you are unsure rather than guessing.

Reply with JSON only:
{"verdict":"match"|"mismatch"|"unsure",
 "confidence":0.0-1.0,
 "summary":"one short line the seller can read at a glance"}`;

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
