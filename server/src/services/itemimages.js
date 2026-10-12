/**
 * The picture shown for an order item on the packing queue, and a quiet check against Airtable.
 *
 *  - A picture can be chosen by hand for one item (a file, or a link); the queue shows it instead of the listing's.
 *  - If the Airtable row of the item holds a picture that shows a DIFFERENT PRODUCT than the item's own picture - the
 *    customer asked for another item, the product was swapped - the queue says so. Different photos of the same product
 *    (angle, background, crop) are nothing. An empty Airtable cell, or a cell with the very same picture, says nothing,
 *    and neither does anything that could not be checked: this never complains about what it cannot tell.
 */
import { getDb } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as at from '../airtable/client.js';
import { listAllDestinations } from './airtable.js';
import { cachedProductImageId } from './warehousecheck.js';
import { parseJsonish, run } from './ai/index.js';
import { saveParcelPhoto, runVision, packingQueue } from './packing.js';

const log = createLogger('itemimages');
const attUrl = (id) => `/api/ai/attachments/${id}`;
const strip = (u) => String(u || '').split('?')[0].replace(/^https?:\/\//, '');

// ---------------------------------------------------------------- the picture by hand

export function overrides() {
  const out = new Map();
  for (const r of getDb().prepare('SELECT * FROM item_images').all()) out.set(`${r.channel}:${r.item_id}`, r);
  return out;
}

/** Choose the picture of one item: an uploaded file, or a link to one. */
export async function setOverride({ channel, itemId, file = null, url = '' } = {}) {
  if (channel !== 'etsy' && channel !== 'shopify') throw badRequest('channel must be "etsy" or "shopify".');
  if (itemId == null || itemId === '') throw badRequest('Which item?');
  let attachmentId;
  let source = null;
  if (file) attachmentId = saveParcelPhoto(file, 'parcel-itemimage');
  else if (/^https?:\/\//i.test(String(url))) { attachmentId = await cachedProductImageId(String(url).trim()); source = String(url).trim(); }
  else throw badRequest('Choose a picture file, or give a link to one.');
  getDb().prepare(`
    INSERT INTO item_images (channel, item_id, attachment_id, source_url) VALUES (?,?,?,?)
    ON CONFLICT(channel, item_id) DO UPDATE SET attachment_id = excluded.attachment_id, source_url = excluded.source_url, updated_at = datetime('now')`)
    .run(channel, String(itemId), attachmentId, source);
  return { imageUrl: attUrl(attachmentId) };
}

export function clearOverride(channel, itemId) {
  getDb().prepare('DELETE FROM item_images WHERE channel = ? AND item_id = ?').run(channel, String(itemId));
  return { cleared: true };
}

// --------------------------------------------------------------------- the Airtable check

const IMAGE_SOURCES = ['item.variant_image', 'item.variant_image_url', 'item.image_any', 'item.first_image', 'item.image_url'];

/** The picture an Airtable cell holds: a link as text, or the first attachment. */
function urlOf(cell) {
  if (Array.isArray(cell)) return cell.map((c) => c?.url).find((u) => /^https?:\/\//.test(u || '')) || '';
  const m = String(cell ?? '').match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}

const PAIR_SYSTEM = `You compare two pictures of products for an online shop.

The FIRST image is the picture of the product a customer ordered. The SECOND is the picture kept in the shop's order
sheet for that order. They may be different photographs (another angle, background, crop, lighting, with or without
packaging, a different variant colour of the same design shown) - that is NOT a difference.

Say "different" ONLY when the two pictures show different products: another design, character, theme, item type or set,
so that the sheet's picture would make the warehouse pack something other than what was ordered. When they could be
the same product, or you cannot tell, say "same" or "unsure". Never guess a difference.

Reply with JSON only: {"verdict":"same"|"different"|"unsure","confidence":0.0,"summary":"one short line naming what differs, or why they match"}`;

async function comparePair(ours, theirs, { runner = run } = {}) {
  const db = getDb();
  const key = (x) => x.key;
  const known = db.prepare('SELECT * FROM image_pair_checks WHERE a_key = ? AND b_key = ?').get(key(ours), key(theirs));
  if (known) return { verdict: known.verdict, confidence: known.confidence, summary: known.summary };
  const a = ours.attachmentId ?? await cachedProductImageId(ours.url);
  const b = await cachedProductImageId(theirs.url);
  const ai = await runVision({
    kind: 'custom', promptOverride: PAIR_SYSTEM, effort: 'fast', maxTokens: 300,
    attachmentIds: [{ id: a, detail: 'high' }, { id: b, detail: 'high' }],
    userInput: 'The first image is the ordered product; the second is the picture in the order sheet. JSON only.',
  }, { runner });
  const parsed = parseJsonish(ai.text);
  const verdict = ['same', 'different', 'unsure'].includes(parsed?.verdict) ? parsed.verdict : 'unsure';
  const confidence = Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null;
  const summary = String(parsed?.summary ?? '').slice(0, 240);
  db.prepare('INSERT OR REPLACE INTO image_pair_checks (a_key, b_key, verdict, confidence, summary) VALUES (?,?,?,?,?)').run(key(ours), key(theirs), verdict, confidence, summary);
  return { verdict, confidence, summary };
}

/**
 * Items of the packing queue whose Airtable picture shows another product. Only a handful of new AI looks are made per
 * call (each pair is looked at once, ever); `pending` says how many pairs are still to be looked at.
 */
export async function airtableImageWarnings({ channels, from, to, runner = run, maxLooks = 8 } = {}) {
  const db = getDb();
  const queue = packingQueue({ channels, from, to });
  const mine = overrides();
  const wanted = [];
  for (const o of queue.orders) for (const it of o.items) wanted.push({ order: o, item: it });
  if (!wanted.length) return { warnings: [], pending: 0 };

  const dests = listAllDestinations().filter((d) => d.rowMode === 'item');
  const warnings = [];
  let looks = 0;
  let pending = 0;

  for (const dest of dests) {
    const targets = (dest.fieldMap ?? []).filter((e) => IMAGE_SOURCES.includes(e.source)).map((e) => e.target);
    if (!targets.length) continue;
    const rows = wanted.filter((w) => w.order.channel === dest.channel && (dest.allShops || dest.shopId == null || String(dest.shopId) === String(w.order.shopId)));
    const linkOf = new Map();
    for (const w of rows) {
      const l = db.prepare('SELECT record_id FROM airtable_links WHERE destination_id = ? AND CAST(receipt_id AS TEXT) = ? AND CAST(transaction_id AS TEXT) = ?')
        .get(dest.id, String(w.order.orderId), String(w.item.itemId));
      if (l) linkOf.set(`${w.order.channel}:${w.item.itemId}`, l.record_id);
    }
    if (!linkOf.size) continue;

    const ids = [...new Set(linkOf.values())].map((x) => x.replace(/[^A-Za-z0-9]/g, ''));
    const byId = new Map();
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const part = ids.slice(i, i + 40);
        // eslint-disable-next-line no-await-in-loop
        const recs = await at.listRecords(dest.baseId, dest.tableId, { fields: targets, filterByFormula: `OR(${part.map((id) => `RECORD_ID()='${id}'`).join(',')})`, max: part.length + 10 });
        for (const r of recs) byId.set(r.id, r.fields ?? {});
      }
    } catch (err) { log.warn(`could not read Airtable pictures (${dest.label}): ${err.message}`); continue; }

    for (const w of rows) {
      const rid = linkOf.get(`${w.order.channel}:${w.item.itemId}`);
      const fields = rid ? byId.get(rid) : null;
      if (!fields) continue;
      const theirs = targets.map((t) => urlOf(fields[t])).find(Boolean);
      if (!theirs) continue;                                                       // nothing in Airtable: nothing to say
      const custom = mine.get(`${w.order.channel}:${w.item.itemId}`);
      const ourUrl = w.item.imageUrl && !w.item.imageUrl.startsWith('/api/') ? w.item.imageUrl : (custom?.source_url || '');
      if ((ourUrl && strip(ourUrl) === strip(theirs)) || (custom?.source_url && strip(custom.source_url) === strip(theirs))) continue;
      if (!ourUrl && !custom) continue;
      if (looks >= maxLooks && !db.prepare('SELECT 1 FROM image_pair_checks WHERE a_key = ? AND b_key = ?').get(custom ? `att:${custom.attachment_id}` : strip(ourUrl), strip(theirs))) { pending += 1; continue; }
      try {
        const ours = custom ? { key: `att:${custom.attachment_id}`, attachmentId: custom.attachment_id } : { key: strip(ourUrl), url: ourUrl };
        const before = db.prepare('SELECT 1 FROM image_pair_checks WHERE a_key = ? AND b_key = ?').get(ours.key, strip(theirs));
        // eslint-disable-next-line no-await-in-loop
        const v = await comparePair(ours, { key: strip(theirs), url: theirs }, { runner });
        if (!before) looks += 1;
        if (v.verdict === 'different' && (v.confidence ?? 0) >= 0.7) {
          warnings.push({ channel: w.order.channel, orderId: w.order.orderId, itemId: w.item.itemId, airtableImageUrl: theirs, summary: v.summary });
        }
      } catch (err) { log.warn(`picture check skipped: ${err.message}`); }   // quietly: no AI, no network, nothing to say
    }
  }
  return { warnings, pending };
}
