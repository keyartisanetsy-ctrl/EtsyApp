/**
 * Packing desk: matching what the warehouse in China says has arrived to the
 * order it was bought for.
 *
 * The warehouse reports each arrival over WeChat as a photo plus a line like
 * "中通 3324 1件" (domestic carrier, last digits of its tracking number, piece
 * count). Someone then looks through the orders that have not shipped yet,
 * finds the one whose listing photo matches, and writes that order's short
 * code next to the parcel on the packing sheet. This does the looking: a parcel
 * is recorded here, an AI compares its photo with the listing photos of the
 * unshipped orders in a chosen date range, and confirming a match is what
 * links the two - the order code, the warehouse photo and the inbound tracking
 * number all land on the order from there.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import config from '../config.js';
import { getDb, parse, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { activeShopId } from '../etsy/shop.js';
import { activeShopifyShopId } from '../shopify/shop.js';
import { readSetting } from './settings.js';
import { run, parseJsonish } from './ai/index.js';
import { resolveForTransaction } from './productimages.js';
import { codesFor, shopifyCodesFor } from './ordercode.js';
import { cachedProductImageId } from './warehousecheck.js';
import * as etsyOrders from './orders.js';
import * as shopifyOrders from './shopify.js';

const photoUrl = (id) => (id ? `/api/ai/attachments/${id}` : null);
const isoDay = (d) => d.toISOString().slice(0, 10);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------------ parsing

/**
 * "中通 3324 1件" -> { carrier: '中通', last4: '3324', quantity: 1 }.
 * Forgiving about what the warehouse types: the piece count may be "1件",
 * "2个", "3 pcs" or "x2"; a longer tracking number keeps only its last four
 * digits; a line with just the digits has no carrier.
 */
export function parseParcelText(text = '') {
  let rest = String(text).replace(/[,，;；]/g, ' ').replace(/\s+/g, ' ').trim();
  let quantity = 1;
  const qty = rest.match(/(\d+)\s*(?:件|个|個|pcs?|pieces?)/i) || rest.match(/(?:^|\s)(?:x|×|\*)\s*(\d{1,3})(?!\d)/i);
  if (qty) {
    quantity = Math.max(1, Number(qty[1]));
    rest = rest.replace(qty[0], ' ');
  }
  let last4 = '';
  const digits = rest.match(/\d{3,}/g);
  if (digits) {
    const tail = digits[digits.length - 1];
    last4 = tail.slice(-4);
    rest = rest.replace(tail, ' ');
  }
  return { carrier: rest.replace(/\s+/g, ' ').trim(), last4, quantity };
}

const parcelLabel = (p) => [p.carrier, p.last4, `${p.quantity || 1}件`].filter(Boolean).join(' ');

// ------------------------------------------------------------------ parcels

export function getRow(id) {
  const row = getDb().prepare('SELECT * FROM inbound_parcels WHERE id = ?').get(Number(id));
  if (!row) throw notFound(`Parcel ${id} not found.`);
  return row;
}

/** A photo that arrived by upload or paste, stored like every other attachment. */
export function saveParcelPhoto(file, purpose = 'parcel-photo') {
  if (!String(file?.mimetype || '').startsWith('image/')) throw badRequest('The parcel photo has to be an image.');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const id = `att_${crypto.randomBytes(8).toString('hex')}`;
  const ext = path.extname(file.originalname || '') || (file.mimetype?.includes('png') ? '.png' : '.jpg');
  const dest = path.join(config.uploadDir, `${id}${ext}`);
  fs.writeFileSync(dest, file.buffer);
  getDb().prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
    .run(id, file.originalname || `${id}${ext}`, file.mimetype, file.size ?? file.buffer.length, dest, sha256(file.buffer), purpose);
  return id;
}

/** Remove a parcel-owned photo from disk and the attachments table; anything else is left alone. */
function removeParcelAttachment(id) {
  if (!id) return;
  const db = getDb();
  const a = db.prepare("SELECT * FROM attachments WHERE id = ? AND purpose LIKE 'parcel-%'").get(id);
  if (!a) return;
  try { fs.unlinkSync(a.path); } catch { /* already gone */ }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
}

/** The listing item a parcel is matched to, for showing next to the parcel. */
function loadItemInfo(db, rows) {
  const info = new Map();
  const etsyIds = rows.filter((r) => r.match_channel === 'etsy').map((r) => r.match_item_id);
  const shopifyIds = rows.filter((r) => r.match_channel === 'shopify').map((r) => r.match_item_id);
  if (etsyIds.length) {
    const found = db.prepare(`
      SELECT x.transaction_id, x.title, x.sku, x.quantity, x.image_url, x.listing_id, x.product_id, x.variations,
             r.name AS buyer, r.created_ts
      FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
      WHERE x.transaction_id IN (${etsyIds.map(() => '?').join(',')})`).all(...etsyIds);
    for (const x of found) {
      info.set(`etsy:${x.transaction_id}`, {
        title: x.title, sku: x.sku || '', variant: variationText(x.variations), quantity: x.quantity, buyer: x.buyer,
        orderedAt: x.created_ts ? new Date(x.created_ts * 1000).toISOString() : null,
        imageUrl: resolveForTransaction(x)?.best?.url || x.image_url || null,
      });
    }
  }
  if (shopifyIds.length) {
    const found = db.prepare(`
      SELECT x.line_item_id, x.title, x.sku, x.variant_title, x.quantity, x.image_url, o.customer_name, o.created_at_shopify
      FROM shopify_order_line_items x JOIN shopify_orders o ON o.order_id = x.order_id
      WHERE x.line_item_id IN (${shopifyIds.map(() => '?').join(',')})`).all(...shopifyIds);
    for (const x of found) {
      info.set(`shopify:${x.line_item_id}`, {
        title: x.title, sku: x.sku || '', variant: x.variant_title || '', quantity: x.quantity, buyer: x.customer_name,
        orderedAt: x.created_at_shopify, imageUrl: x.image_url || null,
      });
    }
  }
  return info;
}

function shapeParcel(r, item = null, children = 0) {
  return {
    id: r.id,
    carrier: r.carrier,
    last4: r.last4,
    quantity: r.quantity,
    // Once every piece of a photo has been split out, the row still reads as
    // the delivery it was ("2件"), not as an empty one.
    label: parcelLabel(r.quantity === 0 && r.original_quantity ? { ...r, quantity: r.original_quantity } : r),
    photoUrl: photoUrl(r.attachment_id),
    warehouse: r.warehouse,
    note: r.note,
    receivedOn: r.received_on,
    createdAt: r.created_at,
    status: r.packed_at ? 'packed' : r.match_channel ? 'matched' : r.quantity === 0 ? 'split' : 'unmatched',
    parentId: r.parent_id ?? null,
    children,
    sourceBox: parse(r.source_box, null),
    canRestore: !!r.original_attachment_id,
    originalPhotoUrl: r.original_attachment_id && r.original_attachment_id !== r.attachment_id ? photoUrl(r.original_attachment_id) : null,
    code: r.match_code || null,
    packedAt: r.packed_at,
    match: r.match_channel ? {
      channel: r.match_channel, orderId: r.match_order_id, itemId: r.match_item_id, code: r.match_code,
      source: r.match_source, score: r.match_score, matchedAt: r.matched_at, item,
    } : null,
    suggestions: parse(r.suggestions, null),
    quick: parse(r.quick, null),
    hasText: !!(r.ocr_text && r.ocr_text.trim()),
  };
}

export function getParcel(id) {
  const db = getDb();
  const row = getRow(id);
  const kids = db.prepare('SELECT COUNT(*) AS c FROM inbound_parcels WHERE parent_id = ?').get(row.id).c;
  return shapeParcel(row, loadItemInfo(db, [row]).get(`${row.match_channel}:${row.match_item_id}`) ?? null, kids);
}

export function listParcels({ status = 'all', limit = 300 } = {}) {
  const db = getDb();
  const where = [];
  if (status === 'unmatched') where.push('match_channel IS NULL AND quantity > 0');
  else if (status === 'matched') where.push('match_channel IS NOT NULL AND packed_at IS NULL');
  else if (status === 'packed') where.push('packed_at IS NOT NULL');
  // Newest delivery first, with the arrivals split out of a photo right under it.
  const rows = db.prepare(`
    SELECT * FROM inbound_parcels ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(parent_id, id) DESC, (parent_id IS NOT NULL) ASC, id ASC LIMIT ?`)
    .all(Math.min(1000, Math.max(1, Number(limit) || 300)));
  const items = loadItemInfo(db, rows);
  const kids = new Map(db.prepare(`SELECT parent_id, COUNT(*) AS c FROM inbound_parcels
                                   WHERE parent_id IS NOT NULL GROUP BY parent_id`).all().map((r) => [r.parent_id, r.c]));
  const counts = db.prepare(`
    SELECT SUM(match_channel IS NULL AND quantity > 0) AS unmatched,
           SUM(match_channel IS NOT NULL AND packed_at IS NULL) AS matched,
           SUM(packed_at IS NOT NULL) AS packed, COUNT(*) AS total
    FROM inbound_parcels`).get();
  return {
    counts: { unmatched: counts.unmatched || 0, matched: counts.matched || 0, packed: counts.packed || 0, total: counts.total || 0 },
    rows: rows.map((r) => shapeParcel(r, items.get(`${r.match_channel}:${r.match_item_id}`) ?? null, kids.get(r.id) ?? 0)),
  };
}

export function createParcel({ text = '', carrier, last4, quantity, attachmentId = null, warehouse = '', note = '', receivedOn } = {}) {
  const parsed = parseParcelText(text);
  const fields = {
    carrier: String(carrier ?? parsed.carrier ?? '').trim(),
    last4: String(last4 ?? parsed.last4 ?? '').replace(/\D/g, '').slice(-4),
    quantity: Math.max(1, Math.floor(Number(quantity ?? parsed.quantity) || 1)),
  };
  if (!attachmentId && !fields.last4 && !fields.carrier) {
    throw badRequest('Add the parcel photo, or the carrier line the warehouse sent (like "中通 3324 1件").');
  }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(receivedOn || '') ? receivedOn : isoDay(new Date());
  const info = getDb().prepare(`
    INSERT INTO inbound_parcels (carrier, last4, quantity, attachment_id, warehouse, note, received_on)
    VALUES (?,?,?,?,?,?,?)`)
    .run(fields.carrier, fields.last4, fields.quantity, attachmentId, String(warehouse).trim(), String(note).trim(), day);
  audit('packing.parcel_add', { entity: 'parcel', entityId: info.lastInsertRowid, detail: { ...fields, attachmentId } });
  return getParcel(info.lastInsertRowid);
}

/** What the browser read off the photo. Kept for the free matcher; capped so a noisy read cannot bloat the row. */
export function setParcelText(id, text) {
  const row = getRow(id);
  getDb().prepare('UPDATE inbound_parcels SET ocr_text = ? WHERE id = ?').run(String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000), row.id);
  return getParcel(row.id);
}

export function updateParcel(id, patch = {}) {
  const row = getRow(id);
  const next = {
    carrier: patch.carrier !== undefined ? String(patch.carrier).trim() : row.carrier,
    last4: patch.last4 !== undefined ? String(patch.last4).replace(/\D/g, '').slice(-4) : row.last4,
    // A photo whose pieces were all split out stays at 0; every other arrival is at least 1.
    quantity: patch.quantity !== undefined
      ? Math.max(row.quantity === 0 ? 0 : 1, Math.floor(Number(patch.quantity) || 0)) : row.quantity,
    warehouse: patch.warehouse !== undefined ? String(patch.warehouse).trim() : row.warehouse,
    note: patch.note !== undefined ? String(patch.note).trim() : row.note,
    received_on: /^\d{4}-\d{2}-\d{2}$/.test(patch.receivedOn || '') ? patch.receivedOn : row.received_on,
  };
  getDb().prepare(`
    UPDATE inbound_parcels SET carrier = ?, last4 = ?, quantity = ?, warehouse = ?, note = ?, received_on = ? WHERE id = ?`)
    .run(next.carrier, next.last4, next.quantity, next.warehouse, next.note, next.received_on, row.id);
  return getParcel(row.id);
}

export function deleteParcel(id) {
  const db = getDb();
  const row = getRow(id);
  if (row.match_channel) undoMatchEffects(row);
  // Arrivals that were split out of this photo are real deliveries of their own; they stay.
  db.prepare('UPDATE inbound_parcels SET parent_id = NULL WHERE parent_id = ?').run(row.id);
  db.prepare('DELETE FROM inbound_parcels WHERE id = ?').run(row.id);
  for (const att of new Set([row.attachment_id, row.original_attachment_id].filter(Boolean))) removeParcelAttachment(att);
  audit('packing.parcel_delete', { entity: 'parcel', entityId: row.id });
  return { deleted: row.id };
}

// ------------------------------------------------------------------- demand

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The channels and date window every picking/matching/queue call works inside. */
export function resolveRange({ channels, from, to } = {}) {
  const wanted = (Array.isArray(channels) ? channels : String(channels ?? '').split(','))
    .map((c) => String(c).trim()).filter((c) => c === 'etsy' || c === 'shopify');
  const now = new Date();
  const toDay = to || isoDay(now);
  const fromDay = from || isoDay(new Date(now.getTime() - 30 * 86_400_000));
  if (!DAY.test(fromDay) || !DAY.test(toDay)) throw badRequest('Dates must look like 2026-10-05.');
  if (fromDay > toDay) throw badRequest('"From" is after "to".');
  return {
    channels: wanted.length ? wanted : ['etsy', 'shopify'],
    from: fromDay,
    to: toDay,
    fromTs: Date.parse(`${fromDay}T00:00:00Z`) / 1000,
    toTs: Date.parse(`${toDay}T23:59:59Z`) / 1000,
  };
}

function receivedByItem(db) {
  const rows = db.prepare(`
    SELECT match_channel AS channel, match_item_id AS item, SUM(quantity) AS q
    FROM inbound_parcels WHERE match_item_id IS NOT NULL GROUP BY match_channel, match_item_id`).all();
  return new Map(rows.map((r) => [`${r.channel}:${r.item}`, r.q]));
}

/**
 * Every item that has not gone out yet on the orders placed in the window -
 * the things a parcel could be for. Oldest order first, because the oldest
 * order is the one that has been waiting longest.
 */
/** "Colour: Blue / Size: M" from Etsy's per-line variation list. */
function variationText(json) {
  const list = parse(json, []) ?? [];
  return list.map((v) => [v.formatted_name, v.formatted_value].filter(Boolean).join(': ')).filter(Boolean).join(' / ');
}

/**
 * Every item that has not gone out yet on the orders placed in the window -
 * the things a parcel could be for. Oldest order first, because the oldest
 * order is the one that has been waiting longest.
 *
 * `only` ({ channel, orderId }) asks for one particular order instead,
 * whatever its state or age - for when someone names an order by its code.
 */
export function loadDemand(range, only = null) {
  const db = getDb();
  const received = receivedByItem(db);
  const out = [];

  const etsyShop = activeShopId();
  if ((only ? only.channel === 'etsy' : range.channels.includes('etsy')) && etsyShop != null) {
    const where = only
      ? 'r.shop_id IS ? AND r.receipt_id = ?'
      : `r.shop_id IS ? AND COALESCE(r.was_shipped,0) = 0 AND COALESCE(r.was_canceled,0) = 0
         AND COALESCE(r.was_paid,1) = 1 AND COALESCE(f.is_canceled,0) = 0 AND COALESCE(x.is_digital,0) = 0
         AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.receipt_id = r.receipt_id
                         AND s.tracking_code IS NOT NULL AND s.tracking_code <> '')
         AND r.created_ts BETWEEN ? AND ?`;
    const params = only ? [etsyShop, Number(only.orderId)] : [etsyShop, range.fromTs, range.toTs];
    const rows = db.prepare(`
      SELECT r.receipt_id, r.created_ts, r.name AS buyer, r.message_from_buyer,
             x.transaction_id, x.sku, x.title, x.quantity, x.image_url, x.listing_id, x.product_id, x.variations,
             COALESCE(f.supplier_ordered,0) AS supplier_ordered, f.supplier_order_ref, f.supply_tracking_number,
             sup.title AS supply_title, sup.variant_label AS supply_variant, sup.images AS supply_images
      FROM receipts r
      JOIN receipt_transactions x ON x.receipt_id = r.receipt_id
      LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
      LEFT JOIN supply_items sup ON sup.sku = x.sku AND sup.shop_id IS r.shop_id AND x.sku <> ''
      WHERE ${where}
      ORDER BY r.created_ts ASC, x.transaction_id ASC`).all(...params);
    const codes = codesFor([...new Set(rows.map((r) => r.receipt_id))], etsyShop);
    for (const r of rows) {
      const got = received.get(`etsy:${r.transaction_id}`) || 0;
      out.push({
        channel: 'etsy', orderId: String(r.receipt_id), orderRef: codes[r.receipt_id] || String(r.receipt_id),
        orderedTs: r.created_ts, orderedAt: new Date(r.created_ts * 1000).toISOString(), buyer: r.buyer || '',
        itemId: String(r.transaction_id), sku: r.sku || '', title: r.title || '', variant: variationText(r.variations),
        quantity: r.quantity || 1, received: got, remaining: (r.quantity || 1) - got,
        imageUrl: resolveForTransaction(r)?.best?.url || r.image_url || null,
        purchased: !!(r.supplier_ordered || r.supplier_order_ref), supplyTracking: r.supply_tracking_number || '',
        supplyTitle: [r.supply_title, r.supply_variant].filter(Boolean).join(' '),
        supplyImages: parse(r.supply_images, []) ?? [],
      });
    }
  }

  const shopifyShop = activeShopifyShopId();
  if ((only ? only.channel === 'shopify' : range.channels.includes('shopify')) && shopifyShop != null) {
    const where = only
      ? 'o.shop_id = ? AND o.order_id = ?'
      : `o.shop_id = ? AND o.cancelled_at IS NULL AND COALESCE(f.is_canceled,0) = 0
         AND UPPER(COALESCE(o.fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')
         AND UPPER(COALESCE(o.financial_status,'')) NOT IN ('VOIDED','REFUNDED')
         AND COALESCE(f.tracking_number,'') = ''
         AND substr(o.created_at_shopify,1,10) BETWEEN ? AND ?`;
    const params = only ? [shopifyShop, String(only.orderId)] : [shopifyShop, range.from, range.to];
    const rows = db.prepare(`
      SELECT o.order_id, o.name, o.created_at_shopify, o.customer_name,
             x.line_item_id, x.sku, x.title, x.variant_title, x.quantity, x.image_url,
             f.supplier_order_ref, f.supply_tracking_number
      FROM shopify_orders o
      JOIN shopify_order_line_items x ON x.order_id = o.order_id
      LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
      WHERE ${where}
      ORDER BY o.created_at_shopify ASC, x.line_item_id ASC`).all(...params);
    const codes = shopifyCodesFor([...new Set(rows.map((r) => r.order_id))], shopifyShop);
    for (const r of rows) {
      const got = received.get(`shopify:${r.line_item_id}`) || 0;
      out.push({
        channel: 'shopify', orderId: r.order_id, orderRef: codes[r.order_id] || r.name || r.order_id,
        orderName: r.name || '',
        orderedTs: Math.floor(Date.parse(r.created_at_shopify) / 1000) || 0, orderedAt: r.created_at_shopify,
        buyer: r.customer_name || '', itemId: r.line_item_id, sku: r.sku || '', title: r.title || '',
        variant: r.variant_title || '', quantity: r.quantity || 1, received: got, remaining: (r.quantity || 1) - got,
        imageUrl: r.image_url || null,
        purchased: !!r.supplier_order_ref, supplyTracking: r.supply_tracking_number || '',
        supplyTitle: '', supplyImages: [],
      });
    }
  }

  return out.sort((a, b) => a.orderedTs - b.orderedTs);
}

export const slimDemand = (d) => ({
  channel: d.channel, orderId: d.orderId, orderRef: d.orderRef, orderedAt: d.orderedAt, buyer: d.buyer,
  itemId: d.itemId, sku: d.sku, variant: d.variant, quantity: d.quantity, received: d.received, remaining: d.remaining,
});

// ----------------------------------------------------------------- matching

const MATCH_SYSTEM = `You help a dropshipping shop work out which customer order a parcel belongs to.

The FIRST image is a photo a warehouse worker took of items that have just arrived at the
warehouse - usually boxed or bagged products on a floor or table, often under poor lighting,
sometimes still in a retail box or a delivery bag. It can show more than one product at once,
because one delivery may hold things bought for different customers. Every image AFTER the first
is the shop's own listing photo of one product customers have ordered, numbered in the order
given (listing 1, listing 2, ...).

For EACH numbered listing, say how likely it is that this product is among the items in the
warehouse photo. Judge the specific details, not the general category:
- the character, artwork or design printed on the item or its box, and any logo or readable text
- colours, shape, proportions and size relative to its packaging
- what is in the set, and how many pieces
- a retail box in the warehouse photo may differ from a listing photo that shows the product
  outside its box - then rely on the design, character and colours rather than the framing

Scores: 0.9 or more - clearly that product is in the photo; 0.6 to 0.9 - probably; 0.3 to 0.6 -
something similar but you cannot tell; under 0.3 - not there. Be strict. When the photo shows
several different products, each listing whose product is really there can score high - say in
the reason where in the photo it is (left, right, top, bottom, middle). Two listings should score
alike for the same item only when they are genuinely near-identical variants of one product -
then say so. If the warehouse photo is too dark, blurry or cropped to judge, set "unreadable" to
true and keep scores low rather than guessing.

Reply with JSON only, with an entry for every numbered listing:
{"unreadable":false,
 "matches":[{"index":1,"score":0.0,"reason":"a few words naming the detail that decided it, left empty when the score is under 0.5"}]}`;

// Listing photos are only references, and at "low" detail a picture costs a flat
// 85 tokens however large it is - so a lot of them fit in one cheap call.
const BATCH_SIZE = 16;
const MAX_PRODUCTS = 64;
const FINALISTS = 4;
const CONFIDENT_SCORE = 0.8;
const CONFIDENT_GAP = 0.15;

export async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next; next += 1;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

/**
 * One AI look: the warehouse photo against up to BATCH_SIZE listing photos.
 * The warehouse photo is always seen closely; `detail` is how closely the
 * listings are - "low" for the wide first pass, "high" for the few that make
 * the final.
 */
async function scoreBatch(parcel, batch, { provider, model, runner, detail, usage }) {
  const ai = await runner({
    kind: 'custom',
    provider: provider || readSetting('ai.warehouse.provider') || undefined,
    model: model || readSetting('ai.warehouse.model') || undefined,
    promptOverride: MATCH_SYSTEM,
    attachmentIds: [{ id: parcel.attachment_id, detail: 'high' }, ...batch.map((p) => ({ id: p.attachmentId, detail }))],
    // Picking a picture out of a few is not a task to think hard about.
    effort: 'fast',
    context: { listings: batch.map((p, i) => ({ index: i + 1, title: p.title, sku: p.sku })) },
    userInput: 'The first image is the warehouse photo. Each image after it is one numbered listing photo, in order. JSON only.',
    maxTokens: 900,
  });
  usage.calls += 1;
  usage.input += ai.tokens?.input ?? 0;
  usage.output += ai.tokens?.output ?? 0;

  const parsed = parseJsonish(ai.text);
  if (!parsed || !Array.isArray(parsed.matches)) throw new Error('The AI did not return a usable answer.');
  const scored = [];
  for (const m of parsed.matches) {
    const product = batch[Number(m.index) - 1];
    const score = Number(m.score);
    if (!product || !Number.isFinite(score)) continue;
    scored.push({ product, score: Math.max(0, Math.min(1, score)), reason: String(m.reason ?? '').slice(0, 240) });
  }
  return { scored, unreadable: !!parsed.unreadable, provider: ai.provider, model: ai.model };
}

const byScore = (a, b) => b.score - a.score;
const isSure = (ordered) => {
  const [top, second] = ordered;
  return !!top && top.score >= CONFIDENT_SCORE && (!second || top.score - second.score >= CONFIDENT_GAP);
};

/**
 * Look through the unshipped orders in the window for the product this
 * parcel's photo shows - cheaply first, closely only when it has to be.
 *
 * Listings are grouped by their picture (ten orders for one product are one
 * candidate) and compared in one low-detail pass, usually a single call. When
 * that pass already has a clear winner, that is the answer. When it does not,
 * the few best candidates get a second, high-detail look side by side with
 * the photo - unless several of them already score high, which means the photo
 * holds more than one of the products (or lookalike variants) and a closer
 * look would not choose between them.
 */
export async function matchParcel(id, { channels, from, to, provider, model, runner = run } = {}) {
  const db = getDb();
  const parcel = getRow(id);
  if (!parcel.attachment_id) throw badRequest('This parcel has no photo to match. Add one first.');
  if (parcel.match_channel) throw badRequest('This parcel is already matched - unmatch it first.');
  if (parcel.quantity < 1) throw badRequest('Every piece of this photo has been split out - match the split arrivals instead.');

  const range = resolveRange({ channels, from, to });
  const open = loadDemand(range).filter((d) => d.remaining > 0 && d.imageUrl);
  const byImage = new Map();
  for (const d of open) {
    if (!byImage.has(d.imageUrl)) byImage.set(d.imageUrl, { imageUrl: d.imageUrl, title: d.title, sku: d.sku, demands: [] });
    byImage.get(d.imageUrl).demands.push(d);
  }
  const distinct = [...byImage.values()];
  const candidates = distinct.slice(0, MAX_PRODUCTS);

  const usage = { calls: 0, input: 0, output: 0 };
  const result = {
    ranAt: new Date().toISOString(), channels: range.channels, from: range.from, to: range.to,
    considered: candidates.length, truncated: distinct.length > candidates.length, skipped: 0,
    unreadable: false, confident: false, provider: null, model: null, closeLook: false, items: [], usage,
  };

  if (candidates.length) {
    const cached = await mapLimit(candidates, 6, async (c) => {
      try { return { ...c, attachmentId: await cachedProductImageId(c.imageUrl) }; } catch { return null; }
    });
    const usable = cached.filter(Boolean);
    result.skipped = candidates.length - usable.length;
    result.considered = usable.length;

    if (usable.length) {
      const opts = { provider, model, runner, usage };
      const batches = [];
      for (let i = 0; i < usable.length; i += BATCH_SIZE) batches.push(usable.slice(i, i + BATCH_SIZE));

      let failure = null;
      const rounds = await mapLimit(batches, 3, async (b) => {
        try { return await scoreBatch(parcel, b, { ...opts, detail: 'low' }); } catch (err) { failure = err; return null; }
      });
      const good = rounds.filter(Boolean);
      if (!good.length) throw failure ?? new Error('The AI did not return a usable answer.');

      let ordered = good.flatMap((r) => r.scored).sort(byScore);
      result.unreadable = good.some((r) => r.unreadable);
      result.provider = good[0].provider;
      result.model = good[0].model;

      const contenders = ordered.filter((s) => s.score >= 0.3);
      const several = ordered.filter((s) => s.score >= CONFIDENT_SCORE).length >= 2;
      if (!isSure(ordered) && contenders.length && !several) {
        const finalists = contenders.slice(0, FINALISTS).map((s) => s.product);
        try {
          const close = await scoreBatch(parcel, finalists, { ...opts, detail: 'high' });
          const decided = new Set(close.scored.map((s) => s.product));
          ordered = [...close.scored.sort(byScore), ...ordered.filter((s) => !decided.has(s.product))];
          result.closeLook = true;
          result.unreadable = result.unreadable || close.unreadable;
        } catch { /* the first look still stands */ }
      }

      const ranked = ordered.filter((s) => s.score >= 0.2).slice(0, 5);
      result.items = ranked.map((s) => ({
        imageUrl: s.product.imageUrl, title: s.product.title, sku: s.product.sku,
        score: round2(s.score), reason: s.reason, demands: s.product.demands.slice(0, 8).map(slimDemand),
      }));
      result.confident = !result.unreadable && isSure(result.items);
    }
  }

  db.prepare('UPDATE inbound_parcels SET suggestions = ? WHERE id = ?').run(JSON.stringify(result), parcel.id);
  return getParcel(parcel.id);
}

// ------------------------------------------------------------ confirm/undo

function lookupItem(channel, orderId, itemId) {
  const db = getDb();
  if (channel === 'etsy') {
    const row = db.prepare(`
      SELECT r.receipt_id, r.created_ts, x.transaction_id, x.warehouse_photo_id
      FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
      WHERE x.transaction_id = ? AND x.receipt_id = ? AND r.shop_id IS ?`)
      .get(Number(itemId), Number(orderId), activeShopId());
    if (!row) throw notFound(`Item ${itemId} is not on Etsy order ${orderId}.`);
    return { code: codesFor([row.receipt_id])[row.receipt_id] || String(row.receipt_id), warehousePhotoId: row.warehouse_photo_id };
  }
  if (channel === 'shopify') {
    const row = db.prepare(`
      SELECT o.order_id, o.name, x.line_item_id, x.warehouse_photo_id
      FROM shopify_order_line_items x JOIN shopify_orders o ON o.order_id = x.order_id
      WHERE x.line_item_id = ? AND x.order_id = ? AND o.shop_id = ?`)
      .get(String(itemId), String(orderId), activeShopifyShopId());
    if (!row) throw notFound(`Item ${itemId} is not on Shopify order ${orderId}.`);
    return { code: shopifyCodesFor([row.order_id])[row.order_id] || row.name || row.order_id, warehousePhotoId: row.warehouse_photo_id };
  }
  throw badRequest('channel must be "etsy" or "shopify".');
}

const trackingToken = (p) => [p.carrier, p.last4].filter(Boolean).join(' ').trim();
const splitTracking = (s) => String(s || '').split(/\s*[,;\n]\s*/).map((t) => t.trim()).filter(Boolean);

function currentSupplyTracking(channel, orderId) {
  const db = getDb();
  return channel === 'etsy'
    ? db.prepare('SELECT supply_tracking_number AS v FROM order_flags WHERE receipt_id = ?').get(Number(orderId))?.v
    : db.prepare('SELECT supply_tracking_number AS v FROM shopify_fulfillments WHERE order_id = ?').get(String(orderId))?.v;
}

function writeSupplyTracking(channel, orderId, value) {
  if (channel === 'etsy') etsyOrders.setFlags([Number(orderId)], { supplyTrackingNumber: value });
  else shopifyOrders.setSupplierInfo(String(orderId), { supplyTrackingNumber: value });
}

function setItemPhoto(channel, orderId, itemId, attachmentId) {
  if (channel === 'etsy') etsyOrders.setWarehousePhoto(Number(orderId), Number(itemId), attachmentId);
  else shopifyOrders.setWarehousePhoto(String(orderId), String(itemId), attachmentId);
}

/**
 * What matching does to the order itself: the warehouse photo goes on the item
 * (unless it already has one - never overwritten) and the carrier line goes
 * onto the order's inbound tracking number, so both show on the Orders pages
 * and feed the AI warehouse check without anyone typing them twice.
 */
function applyMatchEffects(parcel, channel, orderId, itemId, existingPhotoId) {
  if (parcel.attachment_id && !existingPhotoId) setItemPhoto(channel, orderId, itemId, parcel.attachment_id);
  const token = trackingToken(parcel);
  if (token) {
    const list = splitTracking(currentSupplyTracking(channel, orderId));
    if (!list.includes(token)) writeSupplyTracking(channel, orderId, [...list, token].join(', '));
  }
}

function undoMatchEffects(parcel) {
  const db = getDb();
  const { match_channel: channel, match_order_id: orderId, match_item_id: itemId } = parcel;
  try {
    const photo = channel === 'etsy'
      ? db.prepare('SELECT warehouse_photo_id AS v FROM receipt_transactions WHERE transaction_id = ?').get(Number(itemId))?.v
      : db.prepare('SELECT warehouse_photo_id AS v FROM shopify_order_line_items WHERE line_item_id = ?').get(String(itemId))?.v;
    if (photo && photo === parcel.attachment_id) setItemPhoto(channel, orderId, itemId, null);

    const token = trackingToken(parcel);
    const sameToken = db.prepare(`
      SELECT carrier, last4 FROM inbound_parcels
      WHERE match_channel = ? AND match_order_id = ? AND id <> ?`).all(channel, String(orderId), parcel.id)
      .some((p) => trackingToken(p) === token);
    if (token && !sameToken) {
      const list = splitTracking(currentSupplyTracking(channel, orderId));
      if (list.includes(token)) writeSupplyTracking(channel, orderId, list.filter((t) => t !== token).join(', '));
    }
  } catch { /* the order may be gone from the local mirror; the parcel can still be released */ }
}

export function confirmMatch(id, { channel, orderId, itemId, source = 'manual', score = null } = {}) {
  const db = getDb();
  const parcel = getRow(id);
  if (!channel || orderId == null || itemId == null) throw badRequest('channel, orderId and itemId are required.');
  const target = lookupItem(channel, orderId, itemId);
  if (parcel.match_channel) undoMatchEffects(parcel);

  // The photo may have just been cleared if this parcel's own photo was on the old item.
  const existingPhoto = target.warehousePhotoId && target.warehousePhotoId !== parcel.attachment_id
    ? target.warehousePhotoId : null;
  db.prepare(`
    UPDATE inbound_parcels SET match_channel = ?, match_order_id = ?, match_item_id = ?, match_code = ?,
      match_source = ?, match_score = ?, matched_at = datetime('now'), packed_at = NULL WHERE id = ?`)
    .run(channel, String(orderId), String(itemId), target.code, ['ai', 'quick'].includes(source) ? source : 'manual',
      score == null ? null : Number(score), parcel.id);
  applyMatchEffects(parcel, channel, orderId, itemId, existingPhoto);
  audit('packing.match', { entity: 'parcel', entityId: parcel.id, detail: { channel, orderId, itemId, code: target.code, source, score } });
  return getParcel(parcel.id);
}

export function unmatchParcel(id) {
  const parcel = getRow(id);
  if (!parcel.match_channel) return getParcel(parcel.id);
  undoMatchEffects(parcel);
  getDb().prepare(`
    UPDATE inbound_parcels SET match_channel = NULL, match_order_id = NULL, match_item_id = NULL, match_code = NULL,
      match_source = NULL, match_score = NULL, matched_at = NULL, packed_at = NULL WHERE id = ?`).run(parcel.id);
  audit('packing.unmatch', { entity: 'parcel', entityId: parcel.id });
  return getParcel(parcel.id);
}

// -------------------------------------------------------------------- split

const MAX_REGIONS = 12;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round4 = (n) => Math.round(n * 10000) / 10000;

/** A box as fractions of the photo's width and height, kept inside the photo and big enough to mean something. */
function cleanBox(b) {
  const x = clamp01(Number(b?.x));
  const y = clamp01(Number(b?.y));
  const w = Math.min(1 - x, Number(b?.w));
  const h = Math.min(1 - y, Number(b?.h));
  if (![x, y, w, h].every(Number.isFinite) || w < 0.02 || h < 0.02) {
    throw badRequest('Every box has to cover a visible part of the photo.');
  }
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/**
 * One photo can show products bought for several customers. Each box becomes
 * its own arrival - same carrier line, one piece, with just that product's
 * cropped photo - so it can be matched to its own customer's order and sit on
 * its own row of the packing sheet. What is left of the photo (the browser has
 * already taken the boxed parts out of it) stays with the original arrival,
 * which keeps the untouched photo and its piece count so the split can be undone.
 * When nothing is left (`done`), the original arrival is just the container.
 *
 * The pixels are cut in the browser, where a canvas reads every image format
 * and applies a phone photo's rotation; the server stores what it is given.
 */
export function splitParcel(id, { regions, crops = [], remainder = null, done = false } = {}) {
  const db = getDb();
  const parent = getRow(id);
  if (parent.match_channel) throw badRequest('This arrival is matched already - unmatch it before splitting its photo.');
  if (!parent.attachment_id) throw badRequest('This arrival has no photo to split.');
  if (parent.quantity < 1) throw badRequest('Every piece of this photo has already been split out.');

  const boxes = (Array.isArray(regions) ? regions : []).map(cleanBox);
  if (!boxes.length || boxes.length > MAX_REGIONS) throw badRequest(`Split between 1 and ${MAX_REGIONS} boxes at a time.`);
  if (crops.length !== boxes.length) throw badRequest('Every box needs its cropped photo.');
  for (const f of [...crops, remainder].filter(Boolean)) {
    if (!String(f.mimetype || '').startsWith('image/')) throw badRequest('Split photos have to be images.');
  }

  // `done` is the browser saying nothing is left in the photo once the boxes are
  // out. Whether the original arrival stays open follows what the photo shows,
  // not the piece count the warehouse typed, which can be off.
  const piecesLeft = done ? 0 : Math.max(1, parent.quantity - boxes.length);
  const cropIds = crops.map((f) => saveParcelPhoto(f, 'parcel-crop'));
  const remainderId = !done && remainder ? saveParcelPhoto(remainder, 'parcel-remainder') : null;
  const previousRemainder = remainderId && parent.original_attachment_id && parent.attachment_id !== parent.original_attachment_id
    ? parent.attachment_id : null;

  const childIds = [];
  db.transaction(() => {
    if (!parent.original_attachment_id) {
      db.prepare('UPDATE inbound_parcels SET original_attachment_id = ?, original_quantity = ? WHERE id = ?')
        .run(parent.attachment_id, parent.quantity, parent.id);
    }
    boxes.forEach((box, i) => {
      const info = db.prepare(`
        INSERT INTO inbound_parcels (carrier, last4, quantity, attachment_id, warehouse, note, received_on, parent_id, source_box)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(parent.carrier, parent.last4, 1, cropIds[i], parent.warehouse, parent.note, parent.received_on, parent.id, JSON.stringify(box));
      childIds.push(Number(info.lastInsertRowid));
    });
    db.prepare('UPDATE inbound_parcels SET attachment_id = ?, quantity = ?, suggestions = NULL WHERE id = ?')
      .run(remainderId ?? parent.attachment_id, piecesLeft, parent.id);
  })();
  removeParcelAttachment(previousRemainder);

  audit('packing.split', { entity: 'parcel', entityId: parent.id, detail: { children: childIds, boxes } });
  return { parent: getParcel(parent.id), children: childIds.map(getParcel) };
}

/**
 * Put a split photo back together: the arrivals cut out of it are removed
 * (and released from any order they were matched to), and the original photo
 * and piece count come back. Works from the original arrival or any of its parts.
 */
export function unsplitParcel(id) {
  const db = getDb();
  let parent = getRow(id);
  if (parent.parent_id) parent = getRow(parent.parent_id);
  if (!parent.original_attachment_id) throw badRequest('This photo has not been split.');

  if (parent.match_channel) { unmatchParcel(parent.id); parent = getRow(parent.id); }
  const kids = db.prepare('SELECT * FROM inbound_parcels WHERE parent_id = ?').all(parent.id);
  for (const kid of kids) {
    if (kid.match_channel) undoMatchEffects(kid);
    db.prepare('DELETE FROM inbound_parcels WHERE id = ?').run(kid.id);
    removeParcelAttachment(kid.attachment_id);
  }

  const original = parent.original_attachment_id;
  const current = parent.attachment_id;
  db.prepare(`UPDATE inbound_parcels SET attachment_id = ?, quantity = ?, original_attachment_id = NULL,
              original_quantity = NULL, suggestions = NULL, packed_at = NULL WHERE id = ?`)
    .run(original, parent.original_quantity ?? parent.quantity + kids.length, parent.id);
  if (current !== original) removeParcelAttachment(current);

  audit('packing.unsplit', { entity: 'parcel', entityId: parent.id, detail: { removed: kids.map((k) => k.id) } });
  return getParcel(parent.id);
}

const DETECT_SYSTEM = `You locate the separate products in a warehouse photo so each one can be cut out and
kept with its own customer's order.

The photo was taken at a warehouse of items that have just arrived - usually boxed or bagged
products on a floor or table, sometimes several at once because one delivery can hold things
bought for different customers.

Return a bounding box for EACH separate product. Coordinates are percentages of the whole photo:
x and y are the top-left corner, measured from the photo's top-left; w and h are the box's width
and height - every number from 0 to 100.

Rules:
- One box per separate product. A set sold together, or one item in its own retail box, is ONE
  product. Two different products side by side are two.
- Box only the product and the box or bag it came in - not the table, the floor, a hand, a shelf,
  or loose packing material.
- Boxes should not overlap one another. When items touch, put the line between them where the
  gap or the edge of the nearer item is.
- If you can only see one product, return one box around it.
- Order the boxes left to right, then top to bottom.

Reply with JSON only:
{"items":[{"x":0,"y":0,"w":0,"h":0,"label":"a few words that identify it, like 'black keyboard' or 'blue-haired figure in a box'","confidence":0.0}]}`;

const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
};

/**
 * Ask the AI where each product sits in this arrival's photo. Only a
 * suggestion - the boxes come back to the browser to be moved, resized,
 * added or removed before anything is cut.
 */
export async function detectRegions(id, { provider, model, runner = run } = {}) {
  const parcel = getRow(id);
  if (!parcel.attachment_id) throw badRequest('This arrival has no photo to look at.');
  if (parcel.quantity < 1) throw badRequest('Every piece of this photo has already been split out.');

  const ai = await runner({
    kind: 'custom',
    provider: provider || readSetting('ai.warehouse.provider') || undefined,
    model: model || readSetting('ai.warehouse.model') || undefined,
    promptOverride: DETECT_SYSTEM,
    attachmentIds: [{ id: parcel.attachment_id, detail: 'high' }],
    effort: 'fast',
    userInput: `The warehouse reported ${parcel.quantity} piece${parcel.quantity === 1 ? '' : 's'} in this photo. JSON only.`,
    maxTokens: 900,
  });
  const parsed = parseJsonish(ai.text);
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('The AI did not return a usable answer.');

  const raw = parsed.items.map((i) => ({ ...i, x: Number(i.x), y: Number(i.y), w: Number(i.w), h: Number(i.h) }))
    .filter((i) => [i.x, i.y, i.w, i.h].every(Number.isFinite));
  // Told percentages, a model sometimes answers in 0-1 fractions; every box then fits inside 1.
  const scale = raw.length && raw.every((i) => i.x + i.w <= 1.05 && i.y + i.h <= 1.05) ? 1 : 100;

  const found = raw
    .map((i) => {
      const x = clamp01(i.x / scale);
      const y = clamp01(i.y / scale);
      return {
        x, y, w: Math.min(1 - x, i.w / scale), h: Math.min(1 - y, i.h / scale),
        label: String(i.label ?? '').slice(0, 60),
        confidence: Number.isFinite(Number(i.confidence)) ? clamp01(Number(i.confidence)) : null,
      };
    })
    .filter((b) => b.w >= 0.03 && b.h >= 0.03 && (b.confidence == null || b.confidence >= 0.3))
    .sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));

  const kept = [];
  for (const b of found) if (!kept.some((k) => overlap(k, b) > 0.6)) kept.push(b);
  const regions = kept.slice(0, MAX_REGIONS).sort((a, b) => a.x - b.x || a.y - b.y)
    .map((b) => ({ ...cleanBox(b), label: b.label, confidence: b.confidence }));

  return { regions, provider: ai.provider, model: ai.model };
}

/** Mark every parcel matched to one order as packed (or take that back). */
export function packOrder({ channel, orderId, packed = true } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM inbound_parcels WHERE match_channel = ? AND match_order_id = ?')
    .all(channel, String(orderId));
  if (!rows.length) throw badRequest('No received parcel is matched to this order yet.');
  db.prepare(`UPDATE inbound_parcels SET packed_at = ${packed ? "datetime('now')" : 'NULL'}
              WHERE match_channel = ? AND match_order_id = ?`).run(channel, String(orderId));
  audit('packing.pack', { entity: 'parcel', detail: { channel, orderId, packed, parcels: rows.length } });
  return { channel, orderId: String(orderId), packed: !!packed, parcels: rows.length };
}

// -------------------------------------------------------------------- queue

/**
 * Every unshipped order in the window with what has arrived for each of its
 * items: ready to pack (everything is here), partly here, still waiting, or
 * already packed and only waiting for its tracking number.
 */
export function packingQueue(params = {}) {
  const db = getDb();
  const range = resolveRange(params);
  const demand = loadDemand(range);

  const parcelRows = db.prepare(`
    SELECT * FROM inbound_parcels WHERE match_item_id IS NOT NULL ORDER BY id`).all();
  const byItem = new Map();
  for (const p of parcelRows) {
    const key = `${p.match_channel}:${p.match_item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({ id: p.id, label: parcelLabel(p), photoUrl: photoUrl(p.attachment_id), quantity: p.quantity, packedAt: p.packed_at });
  }

  const orders = new Map();
  for (const d of demand) {
    const key = `${d.channel}:${d.orderId}`;
    if (!orders.has(key)) {
      orders.set(key, { channel: d.channel, orderId: d.orderId, ref: d.orderRef, orderedAt: d.orderedAt, buyer: d.buyer, items: [] });
    }
    orders.get(key).items.push({
      itemId: d.itemId, sku: d.sku, title: d.title, variant: d.variant, quantity: d.quantity, received: d.received,
      imageUrl: d.imageUrl, parcels: byItem.get(`${d.channel}:${d.itemId}`) ?? [],
    });
  }

  const summary = { ready: 0, partial: 0, waiting: 0, packed: 0 };
  const list = [...orders.values()].map((o) => {
    const complete = o.items.every((i) => i.received >= i.quantity);
    const any = o.items.some((i) => i.received > 0);
    const parcels = o.items.flatMap((i) => i.parcels);
    const allPacked = parcels.length > 0 && parcels.every((p) => p.packedAt);
    const status = complete ? (allPacked ? 'packed' : 'ready') : any ? 'partial' : 'waiting';
    summary[status] += 1;
    return { ...o, status };
  });

  const rank = { ready: 0, partial: 1, waiting: 2, packed: 3 };
  list.sort((a, b) => rank[a.status] - rank[b.status] || String(a.orderedAt).localeCompare(String(b.orderedAt)));
  const unmatched = db.prepare('SELECT COUNT(*) AS c FROM inbound_parcels WHERE match_channel IS NULL AND quantity > 0').get().c;

  return {
    range: { channels: range.channels, from: range.from, to: range.to },
    connected: { etsy: activeShopId() != null, shopify: activeShopifyShopId() != null },
    summary: { ...summary, orders: list.length, unmatchedParcels: unmatched },
    orders: list.slice(0, 500),
  };
}

/** Open demand for the "assign by hand" picker: every item still short of its quantity. */
export function openDemand(params = {}) {
  const range = resolveRange(params);
  return {
    range: { channels: range.channels, from: range.from, to: range.to },
    items: loadDemand(range).filter((d) => d.remaining > 0).slice(0, 500).map((d) => ({ ...slimDemand(d), title: d.title, imageUrl: d.imageUrl })),
  };
}

// ------------------------------------------------------------------- export

const EXT = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif' };

/**
 * The packing sheet in the shape the team already keeps it: Tracking Code,
 * Code, Image, Warehouse - the photo embedded in its cell - with the order
 * and status alongside so the same file also answers "where did this go".
 */
export async function exportPackingSheet({ from, to, status = 'all' } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (DAY.test(from || '')) { where.push('received_on >= ?'); params.push(from); }
  if (DAY.test(to || '')) { where.push('received_on <= ?'); params.push(to); }
  // A photo whose every piece was split out is only a container for its split arrivals.
  where.push('quantity > 0');
  if (status === 'unmatched') where.push('match_channel IS NULL');
  else if (status === 'matched') where.push('match_channel IS NOT NULL AND packed_at IS NULL');
  else if (status === 'packed') where.push('packed_at IS NOT NULL');
  const rows = db.prepare(`SELECT * FROM inbound_parcels ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                           ORDER BY received_on ASC, id ASC`).all(...params);
  const items = loadItemInfo(db, rows);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Packing', { properties: { defaultRowHeight: 18 } });
  sheet.columns = [
    { header: 'Tracking Code\n(跟踪号码)', key: 'label', width: 26 },
    { header: 'Code\n(编号)', key: 'code', width: 18 },
    { header: 'Image\n(图片)', key: 'image', width: 22 },
    { header: 'Warehouse\n(仓库)', key: 'warehouse', width: 18 },
    { header: 'Channel', key: 'channel', width: 10 },
    { header: 'Item', key: 'item', width: 44 },
    { header: 'Customer', key: 'buyer', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Received', key: 'received', width: 12 },
    { header: 'Note', key: 'note', width: 30 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 34;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  let r = 1;
  for (const p of rows) {
    r += 1;
    const item = items.get(`${p.match_channel}:${p.match_item_id}`);
    const row = sheet.addRow({
      label: parcelLabel(p), code: p.match_code || '', image: '', warehouse: p.warehouse,
      // An arrival nobody has matched yet says so, rather than leaving the cells blank.
      channel: p.match_channel ? (p.match_channel === 'etsy' ? 'Etsy' : 'Shopify') : '-',
      item: item ? `${item.title}${item.variant ? ` (${item.variant})` : ''}` : p.match_channel ? '(item no longer in the order mirror)' : 'Not matched yet - add its order code',
      buyer: item?.buyer || '',
      status: p.packed_at ? 'Packed' : p.match_channel ? 'Matched' : 'Unmatched', received: p.received_on, note: p.note,
    });
    row.height = 96;
    row.alignment = { vertical: 'middle', wrapText: true };
    row.getCell('code').font = { bold: true };

    const att = p.attachment_id ? db.prepare('SELECT * FROM attachments WHERE id = ?').get(p.attachment_id) : null;
    const extension = att ? EXT[String(att.mime || '').toLowerCase()] : null;
    if (att && extension && fs.existsSync(att.path)) {
      const imageId = wb.addImage({ buffer: fs.readFileSync(att.path), extension });
      sheet.addImage(imageId, { tl: { col: 2.08, row: r - 1 + 0.06 }, ext: { width: 120, height: 124 } });
    }
  }

  fs.mkdirSync(config.exportDir, { recursive: true });
  const filename = `packing-sheet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.xlsx`;
  const file = path.join(config.exportDir, filename);
  wb.creator = 'Etsy Command Center';
  await wb.xlsx.writeFile(file);
  return { file, filename, bytes: fs.statSync(file).size, rows: rows.length };
}
