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
import { codesFor } from './ordercode.js';
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

function getRow(id) {
  const row = getDb().prepare('SELECT * FROM inbound_parcels WHERE id = ?').get(Number(id));
  if (!row) throw notFound(`Parcel ${id} not found.`);
  return row;
}

/** A photo that arrived by upload or paste, stored like every other attachment. */
export function saveParcelPhoto(file) {
  if (!String(file?.mimetype || '').startsWith('image/')) throw badRequest('The parcel photo has to be an image.');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const id = `att_${crypto.randomBytes(8).toString('hex')}`;
  const ext = path.extname(file.originalname || '') || (file.mimetype?.includes('png') ? '.png' : '.jpg');
  const dest = path.join(config.uploadDir, `${id}${ext}`);
  fs.writeFileSync(dest, file.buffer);
  getDb().prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
    .run(id, file.originalname || `${id}${ext}`, file.mimetype, file.size ?? file.buffer.length, dest, sha256(file.buffer), 'parcel-photo');
  return id;
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
        title: x.title, sku: x.sku || '', variant: '', quantity: x.quantity, buyer: x.buyer,
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

function shapeParcel(r, item = null) {
  return {
    id: r.id,
    carrier: r.carrier,
    last4: r.last4,
    quantity: r.quantity,
    label: parcelLabel(r),
    photoUrl: photoUrl(r.attachment_id),
    warehouse: r.warehouse,
    note: r.note,
    receivedOn: r.received_on,
    createdAt: r.created_at,
    status: r.packed_at ? 'packed' : r.match_channel ? 'matched' : 'unmatched',
    code: r.match_code || null,
    packedAt: r.packed_at,
    match: r.match_channel ? {
      channel: r.match_channel, orderId: r.match_order_id, itemId: r.match_item_id, code: r.match_code,
      source: r.match_source, score: r.match_score, matchedAt: r.matched_at, item,
    } : null,
    suggestions: parse(r.suggestions, null),
  };
}

export function getParcel(id) {
  const db = getDb();
  const row = getRow(id);
  return shapeParcel(row, loadItemInfo(db, [row]).get(`${row.match_channel}:${row.match_item_id}`) ?? null);
}

export function listParcels({ status = 'all', limit = 300 } = {}) {
  const db = getDb();
  const where = [];
  if (status === 'unmatched') where.push('match_channel IS NULL');
  else if (status === 'matched') where.push('match_channel IS NOT NULL AND packed_at IS NULL');
  else if (status === 'packed') where.push('packed_at IS NOT NULL');
  const rows = db.prepare(`
    SELECT * FROM inbound_parcels ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`).all(Math.min(1000, Math.max(1, Number(limit) || 300)));
  const items = loadItemInfo(db, rows);
  const counts = db.prepare(`
    SELECT SUM(match_channel IS NULL) AS unmatched,
           SUM(match_channel IS NOT NULL AND packed_at IS NULL) AS matched,
           SUM(packed_at IS NOT NULL) AS packed, COUNT(*) AS total
    FROM inbound_parcels`).get();
  return {
    counts: { unmatched: counts.unmatched || 0, matched: counts.matched || 0, packed: counts.packed || 0, total: counts.total || 0 },
    rows: rows.map((r) => shapeParcel(r, items.get(`${r.match_channel}:${r.match_item_id}`) ?? null)),
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

export function updateParcel(id, patch = {}) {
  const row = getRow(id);
  const next = {
    carrier: patch.carrier !== undefined ? String(patch.carrier).trim() : row.carrier,
    last4: patch.last4 !== undefined ? String(patch.last4).replace(/\D/g, '').slice(-4) : row.last4,
    quantity: patch.quantity !== undefined ? Math.max(1, Math.floor(Number(patch.quantity) || 1)) : row.quantity,
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
  db.prepare('DELETE FROM inbound_parcels WHERE id = ?').run(row.id);
  if (row.attachment_id) {
    const a = db.prepare("SELECT * FROM attachments WHERE id = ? AND purpose = 'parcel-photo'").get(row.attachment_id);
    if (a) {
      try { fs.unlinkSync(a.path); } catch { /* already gone */ }
      db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    }
  }
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
export function loadDemand(range) {
  const db = getDb();
  const received = receivedByItem(db);
  const out = [];

  const etsyShop = activeShopId();
  if (range.channels.includes('etsy') && etsyShop != null) {
    const rows = db.prepare(`
      SELECT r.receipt_id, r.created_ts, r.name AS buyer,
             x.transaction_id, x.sku, x.title, x.quantity, x.image_url, x.listing_id, x.product_id, x.variations
      FROM receipts r
      JOIN receipt_transactions x ON x.receipt_id = r.receipt_id
      LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
      WHERE r.shop_id IS ? AND COALESCE(r.was_shipped,0) = 0 AND COALESCE(r.was_canceled,0) = 0
        AND COALESCE(r.was_paid,1) = 1 AND COALESCE(f.is_canceled,0) = 0 AND COALESCE(x.is_digital,0) = 0
        AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.receipt_id = r.receipt_id
                        AND s.tracking_code IS NOT NULL AND s.tracking_code <> '')
        AND r.created_ts BETWEEN ? AND ?
      ORDER BY r.created_ts ASC, x.transaction_id ASC`).all(etsyShop, range.fromTs, range.toTs);
    const codes = codesFor([...new Set(rows.map((r) => r.receipt_id))], etsyShop);
    for (const r of rows) {
      const got = received.get(`etsy:${r.transaction_id}`) || 0;
      out.push({
        channel: 'etsy', orderId: String(r.receipt_id), orderRef: codes[r.receipt_id] || String(r.receipt_id),
        orderedTs: r.created_ts, orderedAt: new Date(r.created_ts * 1000).toISOString(), buyer: r.buyer || '',
        itemId: String(r.transaction_id), sku: r.sku || '', title: r.title || '', variant: '',
        quantity: r.quantity || 1, received: got, remaining: (r.quantity || 1) - got,
        imageUrl: resolveForTransaction(r)?.best?.url || r.image_url || null,
      });
    }
  }

  const shopifyShop = activeShopifyShopId();
  if (range.channels.includes('shopify') && shopifyShop != null) {
    const rows = db.prepare(`
      SELECT o.order_id, o.name, o.created_at_shopify, o.customer_name,
             x.line_item_id, x.sku, x.title, x.variant_title, x.quantity, x.image_url
      FROM shopify_orders o
      JOIN shopify_order_line_items x ON x.order_id = o.order_id
      LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
      WHERE o.shop_id = ? AND o.cancelled_at IS NULL AND COALESCE(f.is_canceled,0) = 0
        AND UPPER(COALESCE(o.fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')
        AND UPPER(COALESCE(o.financial_status,'')) NOT IN ('VOIDED','REFUNDED')
        AND COALESCE(f.tracking_number,'') = ''
        AND substr(o.created_at_shopify,1,10) BETWEEN ? AND ?
      ORDER BY o.created_at_shopify ASC, x.line_item_id ASC`).all(shopifyShop, range.from, range.to);
    for (const r of rows) {
      const got = received.get(`shopify:${r.line_item_id}`) || 0;
      out.push({
        channel: 'shopify', orderId: r.order_id, orderRef: r.name || r.order_id,
        orderedTs: Math.floor(Date.parse(r.created_at_shopify) / 1000) || 0, orderedAt: r.created_at_shopify,
        buyer: r.customer_name || '', itemId: r.line_item_id, sku: r.sku || '', title: r.title || '',
        variant: r.variant_title || '', quantity: r.quantity || 1, received: got, remaining: (r.quantity || 1) - got,
        imageUrl: r.image_url || null,
      });
    }
  }

  return out.sort((a, b) => a.orderedTs - b.orderedTs);
}

const slimDemand = (d) => ({
  channel: d.channel, orderId: d.orderId, orderRef: d.orderRef, orderedAt: d.orderedAt, buyer: d.buyer,
  itemId: d.itemId, sku: d.sku, variant: d.variant, quantity: d.quantity, received: d.received, remaining: d.remaining,
});

// ----------------------------------------------------------------- matching

const MATCH_SYSTEM = `You help a dropshipping shop work out which customer order a parcel belongs to.

The FIRST image is a photo a warehouse worker took of an item that has just arrived at the
warehouse - usually a boxed or bagged product on a floor or table, often under poor lighting,
sometimes still in its retail box or a delivery bag. Every image AFTER the first is the shop's
own listing photo of one product customers have ordered, numbered in the order given
(listing 1, listing 2, ...).

For EACH numbered listing, say how likely it is that the item in the warehouse photo is that
same product. Judge the specific details, not the general category:
- the character, artwork or design printed on the item or its box, and any logo or readable text
- colours, shape, proportions and size relative to its packaging
- what is in the set, and how many pieces
- a retail box in the warehouse photo may differ from a listing photo that shows the product
  outside its box - then rely on the design, character and colours rather than the framing

Scores: 0.9 or more - clearly the same product; 0.6 to 0.9 - probably the same; 0.3 to 0.6 -
similar but you cannot tell; under 0.3 - a different product. Be strict: only one listing should
score above 0.8, unless two listings are genuinely near-identical variants - then say so in the
reason and give them similar scores. If the warehouse photo is too dark, blurry or cropped to
judge, set "unreadable" to true and keep scores low rather than guessing.

Reply with JSON only, with an entry for every numbered listing:
{"unreadable":false,
 "matches":[{"index":1,"score":0.0,"reason":"one short line naming the detail that decided it"}]}`;

const BATCH_SIZE = 8;
const MAX_PRODUCTS = 48;
const CONFIDENT_SCORE = 0.8;
const CONFIDENT_GAP = 0.15;

async function mapLimit(list, limit, fn) {
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

async function scoreBatch(parcel, batch, { provider, model, runner }) {
  const ai = await runner({
    kind: 'custom',
    provider: provider || readSetting('ai.warehouse.provider') || undefined,
    model: model || readSetting('ai.warehouse.model') || undefined,
    promptOverride: MATCH_SYSTEM,
    attachmentIds: [parcel.attachment_id, ...batch.map((p) => p.attachmentId)],
    context: { listings: batch.map((p, i) => ({ index: i + 1, title: p.title, sku: p.sku })) },
    userInput: 'The first image is the warehouse photo. Each image after it is one numbered listing photo, in order. JSON only.',
    maxTokens: 1200,
  });
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

/**
 * Look through the unshipped orders in the window for the product this
 * parcel's photo shows. Listings are grouped by their picture first - ten
 * orders for the same product are one candidate, not ten - and compared in
 * batches; when there are several batches the best of each go through one
 * more round together, so the final order comes from a single side-by-side
 * comparison instead of scores that were never seen next to each other.
 */
export async function matchParcel(id, { channels, from, to, provider, model, runner = run } = {}) {
  const db = getDb();
  const parcel = getRow(id);
  if (!parcel.attachment_id) throw badRequest('This parcel has no photo to match. Add one first.');
  if (parcel.match_channel) throw badRequest('This parcel is already matched - unmatch it first.');

  const range = resolveRange({ channels, from, to });
  const open = loadDemand(range).filter((d) => d.remaining > 0 && d.imageUrl);
  const byImage = new Map();
  for (const d of open) {
    if (!byImage.has(d.imageUrl)) byImage.set(d.imageUrl, { imageUrl: d.imageUrl, title: d.title, sku: d.sku, demands: [] });
    byImage.get(d.imageUrl).demands.push(d);
  }
  const distinct = [...byImage.values()];
  const candidates = distinct.slice(0, MAX_PRODUCTS);

  const result = {
    ranAt: new Date().toISOString(), channels: range.channels, from: range.from, to: range.to,
    considered: candidates.length, truncated: distinct.length > candidates.length, skipped: 0,
    unreadable: false, confident: false, provider: null, model: null, items: [],
  };

  if (candidates.length) {
    const cached = await mapLimit(candidates, 4, async (c) => {
      try { return { ...c, attachmentId: await cachedProductImageId(c.imageUrl) }; } catch { return null; }
    });
    const usable = cached.filter(Boolean);
    result.skipped = candidates.length - usable.length;
    result.considered = usable.length;

    if (usable.length) {
      const opts = { provider, model, runner };
      const batches = [];
      for (let i = 0; i < usable.length; i += BATCH_SIZE) batches.push(usable.slice(i, i + BATCH_SIZE));

      let failure = null;
      const rounds = await mapLimit(batches, 2, async (b) => {
        try { return await scoreBatch(parcel, b, opts); } catch (err) { failure = err; return null; }
      });
      const good = rounds.filter(Boolean);
      if (!good.length) throw failure ?? new Error('The AI did not return a usable answer.');

      const byScore = (a, b) => b.score - a.score;
      let ordered = good.flatMap((r) => r.scored).sort(byScore);
      result.unreadable = good.some((r) => r.unreadable);
      result.provider = good[0].provider;
      result.model = good[0].model;

      if (good.length > 1) {
        const finalists = good
          .flatMap((r) => [...r.scored].sort((a, b) => b.score - a.score).slice(0, 3))
          .filter((s) => s.score >= 0.35)
          .sort((a, b) => b.score - a.score)
          .slice(0, BATCH_SIZE)
          .map((s) => s.product);
        if (finalists.length > 1) {
          try {
            const final = await scoreBatch(parcel, finalists, opts);
            const decided = new Set(final.scored.map((s) => s.product));
            ordered = [...final.scored.sort(byScore), ...ordered.filter((s) => !decided.has(s.product))];
          } catch { /* the first-round scores still stand */ }
        }
      }

      const ranked = ordered.filter((s) => s.score >= 0.2).slice(0, 5);
      result.items = ranked.map((s) => ({
        imageUrl: s.product.imageUrl, title: s.product.title, sku: s.product.sku,
        score: round2(s.score), reason: s.reason, demands: s.product.demands.slice(0, 8).map(slimDemand),
      }));
      const [top, second] = result.items;
      result.confident = !!top && !result.unreadable && top.score >= CONFIDENT_SCORE
        && (!second || top.score - second.score >= CONFIDENT_GAP);
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
    return { code: row.name || row.order_id, warehousePhotoId: row.warehouse_photo_id };
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
    .run(channel, String(orderId), String(itemId), target.code, source === 'ai' ? 'ai' : 'manual',
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
  const unmatched = db.prepare('SELECT COUNT(*) AS c FROM inbound_parcels WHERE match_channel IS NULL').get().c;

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
      channel: p.match_channel || '', item: item ? `${item.title}${item.variant ? ` (${item.variant})` : ''}` : '',
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
