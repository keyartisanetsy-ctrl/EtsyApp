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
import { run, parseJsonish, providerStatus } from './ai/index.js';
import * as memory from './packingmemory.js';
import { resolveForTransaction } from './productimages.js';
import { codesFor, shopifyCodesFor, ensureOrderCode, releaseIfUnused, restampStaleCodes } from './ordercode.js';
import { cachedProductImageId } from './warehousecheck.js';
import * as holds from './holds.js';
import { supplyForOrders, supplyFor } from './ordersupply.js';
import { briefFor } from './itemsupply.js';
import { inOrderShop } from '../lib/ordershop.js';
import * as etsyOrders from './orders.js';
import { unshippedByShop } from './orders.js';
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

// ------------------------------------------------------------ several photos

/** The other photos of one arrival (its own photo is inbound_parcels.attachment_id), in the order they were added. */
export function photosOf(parcelId) {
  return getDb().prepare('SELECT * FROM parcel_photos WHERE parcel_id = ? ORDER BY position, id').all(parcelId);
}

/** Every photo of the arrival, its own first: [{ id: attachmentId, kind, text, extraId }]. */
export function allPhotos(row, { kinds = null } = {}) {
  const out = [];
  if (row.attachment_id) out.push({ id: row.attachment_id, kind: 'product', text: row.ocr_text || '', extraId: null });
  for (const x of photosOf(row.id)) out.push({ id: x.attachment_id, kind: x.kind, text: x.ocr_text || '', extraId: x.id });
  return kinds ? out.filter((p) => kinds.includes(p.kind)) : out;
}

/** Everything the browser read off every photo of the arrival, as one piece of text. */
export const readTextOf = (row) => allPhotos(row).map((p) => p.text).filter(Boolean).join(' ').slice(0, 6000);

const MAX_PHOTOS = 12;
const photoKind = (k) => (String(k) === 'label' ? 'label' : 'product');

/**
 * Add photos to an arrival: the same package seen from another side, the carrier's label,
 * the second tray the warehouse put the other half of the same product on. An arrival with
 * no photo of its own takes the first one as its own.
 */
export function addParcelPhotos(id, files, { kind = 'product' } = {}) {
  const db = getDb();
  const row = getRow(id);
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) throw badRequest('Choose at least one photo to add.');
  if (photosOf(row.id).length + (row.attachment_id ? 1 : 0) + list.length > MAX_PHOTOS) {
    throw badRequest(`One arrival can hold up to ${MAX_PHOTOS} photos.`);
  }
  const ids = list.map((f) => saveParcelPhoto(f));
  db.transaction(() => {
    let rest = ids;
    if (!row.attachment_id && photoKind(kind) === 'product') {
      db.prepare('UPDATE inbound_parcels SET attachment_id = ? WHERE id = ?').run(ids[0], row.id);
      rest = ids.slice(1);
    }
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM parcel_photos WHERE parcel_id = ?').get(row.id).p;
    rest.forEach((att, i) => db.prepare('INSERT INTO parcel_photos (parcel_id, attachment_id, kind, position) VALUES (?,?,?,?)')
      .run(row.id, att, photoKind(kind), pos + i + 1));
    db.prepare('UPDATE inbound_parcels SET suggestions = NULL, quick = NULL WHERE id = ? AND match_channel IS NULL').run(row.id);
  })();
  audit('packing.photos_add', { entity: 'parcel', entityId: row.id, detail: { count: ids.length, kind: photoKind(kind) } });
  return getParcel(row.id);
}

export function removeParcelPhoto(id, photoId) {
  const db = getDb();
  const row = getRow(id);
  const x = db.prepare('SELECT * FROM parcel_photos WHERE id = ? AND parcel_id = ?').get(Number(photoId), row.id);
  if (!x) throw notFound('That photo is not on this arrival.');
  db.prepare('DELETE FROM parcel_photos WHERE id = ?').run(x.id);
  removeParcelAttachment(x.attachment_id);
  db.prepare('UPDATE inbound_parcels SET suggestions = NULL, quick = NULL WHERE id = ? AND match_channel IS NULL').run(row.id);
  audit('packing.photo_remove', { entity: 'parcel', entityId: row.id, detail: { photoId: x.id } });
  return getParcel(row.id);
}

/** What the browser read off one of the extra photos. */
export function setPhotoText(id, photoId, text) {
  const db = getDb();
  const row = getRow(id);
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000);
  const x = db.prepare('SELECT * FROM parcel_photos WHERE id = ? AND parcel_id = ?').get(Number(photoId), row.id);
  if (!x) throw notFound('That photo is not on this arrival.');
  db.prepare('UPDATE parcel_photos SET ocr_text = ? WHERE id = ?').run(clean, x.id);
  // A carrier's label read off a photo ("圆通0269共1件") fills in the line the warehouse forgot to type.
  if (x.kind === 'label' && (!row.last4 || !row.carrier)) {
    const carrier = clean.match(/(中通|圆通|圓通|申通|韵达|韻達|顺丰|順豐|极兔|極兔|邮政|郵政|京东|京東|德邦|百世|汇通|匯通|丰网|豐網)/)?.[1] || '';
    const digits = clean.match(/\d{4,}/g);
    const last4 = digits ? digits[digits.length - 1].slice(-4) : '';
    db.prepare('UPDATE inbound_parcels SET carrier = ?, last4 = ? WHERE id = ?').run(row.carrier || carrier, row.last4 || last4, row.id);
  }
  return getParcel(row.id);
}

/** Turn one extra photo back into an arrival of its own (the undo of adding it, or of a merge). */
export function detachParcelPhoto(id, photoId) {
  const db = getDb();
  const row = getRow(id);
  const x = db.prepare('SELECT * FROM parcel_photos WHERE id = ? AND parcel_id = ?').get(Number(photoId), row.id);
  if (!x) throw notFound('That photo is not on this arrival.');
  let childId;
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO inbound_parcels (carrier, last4, quantity, attachment_id, warehouse, note, received_on, ocr_text)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.carrier, row.last4, 1, x.attachment_id, row.warehouse, row.note, row.received_on, x.ocr_text || null);
    childId = Number(info.lastInsertRowid);
    db.prepare('DELETE FROM parcel_photos WHERE id = ?').run(x.id);
    db.prepare('UPDATE inbound_parcels SET suggestions = NULL, quick = NULL WHERE id = ? AND match_channel IS NULL').run(row.id);
  })();
  audit('packing.photo_detach', { entity: 'parcel', entityId: row.id, detail: { photoId: x.id, newParcel: childId } });
  return { parcel: getParcel(row.id), created: getParcel(childId) };
}

/**
 * Two or more arrivals that are really one package (the warehouse photographed a product's
 * parts apart and reported each): their photos are gathered on `targetId`, which keeps its
 * own carrier line and piece count; the others disappear. Only arrivals nobody has matched yet.
 */
export function mergeParcels(targetId, sourceIds) {
  const db = getDb();
  const target = getRow(targetId);
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : [sourceIds]).map(Number))].filter((n) => n && n !== target.id);
  if (!ids.length) throw badRequest('Choose the arrivals to merge into this one.');
  if (target.match_channel) throw badRequest('Unmatch this arrival before merging others into it.');
  const sources = ids.map(getRow);
  for (const src of sources) {
    if (src.match_channel) throw badRequest(`${parcelLabel(src)} is matched already - unmatch it first.`);
    if (src.original_attachment_id || db.prepare('SELECT 1 FROM inbound_parcels WHERE parent_id = ?').get(src.id)) {
      throw badRequest(`${parcelLabel(src)} was split from a photo - restore the original before merging it.`);
    }
  }
  const total = sources.reduce((n, s) => n + photosOf(s.id).length + (s.attachment_id ? 1 : 0), 0) + photosOf(target.id).length + (target.attachment_id ? 1 : 0);
  if (total > MAX_PHOTOS) throw badRequest(`That would be ${total} photos on one arrival - the limit is ${MAX_PHOTOS}.`);

  db.transaction(() => {
    let pos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM parcel_photos WHERE parcel_id = ?').get(target.id).p;
    for (const src of sources) {
      const extras = photosOf(src.id);
      if (src.attachment_id) {
        if (!db.prepare('SELECT attachment_id FROM inbound_parcels WHERE id = ?').get(target.id).attachment_id) {
          db.prepare('UPDATE inbound_parcels SET attachment_id = ?, ocr_text = ? WHERE id = ?').run(src.attachment_id, src.ocr_text || null, target.id);
        } else {
          pos += 1;
          db.prepare('INSERT INTO parcel_photos (parcel_id, attachment_id, kind, ocr_text, position) VALUES (?,?,?,?,?)')
            .run(target.id, src.attachment_id, 'product', src.ocr_text || null, pos);
        }
      }
      for (const x of extras) { pos += 1; db.prepare('UPDATE parcel_photos SET parcel_id = ?, position = ? WHERE id = ?').run(target.id, pos, x.id); }
      db.prepare('DELETE FROM inbound_parcels WHERE id = ?').run(src.id);
    }
    db.prepare('UPDATE inbound_parcels SET suggestions = NULL, quick = NULL WHERE id = ?').run(target.id);
  })();
  audit('packing.merge', { entity: 'parcel', entityId: target.id, detail: { merged: ids } });
  return getParcel(target.id);
}

/** The listing item a parcel is matched to, for showing next to the parcel. */
function loadItemInfo(db, rows) {
  const info = new Map();
  const etsyIds = rows.filter((r) => r.match_channel === 'etsy').map((r) => r.match_item_id);
  const shopifyIds = rows.filter((r) => r.match_channel === 'shopify').map((r) => r.match_item_id);
  if (etsyIds.length) {
    const found = db.prepare(`
      SELECT x.transaction_id, x.title, x.sku, x.quantity, x.image_url, x.listing_id, x.product_id, x.variations,
             r.name AS buyer, r.created_ts, r.shop_id
      FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
      WHERE x.transaction_id IN (${etsyIds.map(() => '?').join(',')})`).all(...etsyIds);
    for (const x of found) {
      info.set(`etsy:${x.transaction_id}`, {
        title: x.title, sku: x.sku || '', variant: variationText(x.variations), quantity: x.quantity, buyer: x.buyer,
        orderedAt: x.created_ts ? new Date(x.created_ts * 1000).toISOString() : null,
        imageUrl: resolveForTransaction(x)?.best?.url || x.image_url || null,
        itemSupply: briefFor('etsy', x.shop_id, x.sku),
      });
    }
  }
  if (shopifyIds.length) {
    const found = db.prepare(`
      SELECT x.line_item_id, x.title, x.sku, x.variant_title, x.quantity, x.image_url, o.customer_name, o.created_at_shopify, o.shop_id
      FROM shopify_order_line_items x JOIN shopify_orders o ON o.order_id = x.order_id
      WHERE x.line_item_id IN (${shopifyIds.map(() => '?').join(',')})`).all(...shopifyIds);
    for (const x of found) {
      info.set(`shopify:${x.line_item_id}`, {
        title: x.title, sku: x.sku || '', variant: x.variant_title || '', quantity: x.quantity, buyer: x.customer_name,
        orderedAt: x.created_at_shopify, imageUrl: x.image_url || null,
        itemSupply: briefFor('shopify', x.shop_id, x.sku),
      });
    }
  }
  return info;
}

/** Bring an order's hold in line with its parcels after anything about them changed. Never lets a hold problem undo a match. */
function touchHold(channel, orderId) {
  if (!channel || orderId == null) return;
  try { holds.refreshHold(channel, String(orderId)); } catch (err) { console.warn(`[holds] ${channel} ${orderId}: ${err.message}`); }
}

function shapeParcel(r, item = null, children = 0, hold = null, supply = null, extras = []) {
  return {
    id: r.id,
    typed: r.raw_text || null,
    carrier: r.carrier,
    last4: r.last4,
    quantity: r.quantity,
    // Once every piece of a photo has been split out, the row still reads as
    // the delivery it was ("2件"), not as an empty one.
    label: parcelLabel(r.quantity === 0 && r.original_quantity ? { ...r, quantity: r.original_quantity } : r),
    photoUrl: photoUrl(r.attachment_id),
    // More photos of the same package (another side, the carrier's label, a second tray).
    extraPhotos: extras.map((x) => ({ id: x.id, url: photoUrl(x.attachment_id), kind: x.kind, hasText: !!(x.ocr_text && x.ocr_text.trim()) })),
    photoCount: (r.attachment_id ? 1 : 0) + extras.length,
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
      // The Taobao order number and cost of the order this parcel belongs to (typed here or on the Orders page).
      supply,
    } : null,
    suggestions: parse(r.suggestions, null),
    quick: parse(r.quick, null),
    hasText: !!(r.ocr_text && r.ocr_text.trim()),
    // Set while the order this arrival is matched to is not all here yet (or once it was and has been released).
    hold: r.match_channel ? hold : null,
  };
}

export function getParcel(id) {
  const db = getDb();
  const row = getRow(id);
  const kids = db.prepare('SELECT COUNT(*) AS c FROM inbound_parcels WHERE parent_id = ?').get(row.id).c;
  return shapeParcel(row, loadItemInfo(db, [row]).get(`${row.match_channel}:${row.match_item_id}`) ?? null, kids,
    row.match_channel ? holds.holdFor(row.match_channel, row.match_order_id) : null,
    row.match_channel ? supplyFor(row.match_channel, row.match_order_id) : null, photosOf(row.id));
}

/**
 * Make the orders carry what the packing list says about them, whatever order things were done in: the arrival's
 * photo on the item (when the item has none), its carrier line on the order's inbound tracking, and the order's
 * current code on the arrival. Cheap, and safe to run whenever the list is opened.
 */
export function syncMatchedParcels() {
  const db = getDb();
  let fixed = 0;
  try { fixed += restampStaleCodes(); } catch (err) { console.warn(`[codes] restamp: ${err.message}`); }
  for (const p of db.prepare('SELECT * FROM inbound_parcels WHERE match_channel IS NOT NULL').all()) {
    try {
      const photo = p.match_channel === 'etsy'
        ? db.prepare('SELECT warehouse_photo_id AS v FROM receipt_transactions WHERE transaction_id = ?').get(Number(p.match_item_id))?.v
        : db.prepare('SELECT warehouse_photo_id AS v FROM shopify_order_line_items WHERE line_item_id = ?').get(String(p.match_item_id))?.v;
      if (p.attachment_id && !photo) { setItemPhoto(p.match_channel, p.match_order_id, p.match_item_id, p.attachment_id); fixed += 1; }
      const token = trackingToken(p);
      if (token) {
        const list = splitTracking(currentSupplyTracking(p.match_channel, p.match_order_id));
        if (!list.includes(token)) { writeSupplyTracking(p.match_channel, p.match_order_id, [...list, token].join(', ')); fixed += 1; }
      }
      const code = p.match_channel === 'etsy'
        ? db.prepare('SELECT code FROM order_codes WHERE receipt_id = ?').get(Number(p.match_order_id))?.code
        : db.prepare('SELECT code FROM shopify_order_codes WHERE order_id = ?').get(String(p.match_order_id))?.code;
      if (code && code !== p.match_code) { db.prepare('UPDATE inbound_parcels SET match_code = ? WHERE id = ?').run(code, p.id); fixed += 1; }
    } catch { /* the order may be gone from the local mirror */ }
  }
  return { fixed };
}

export function listParcels({ status = 'all', limit = 300 } = {}) {
  const db = getDb();
  try { syncMatchedParcels(); } catch { /* the list still opens */ }
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
  const onHold = holds.allHolds();
  const supplies = supplyForOrders(rows.filter((r) => r.match_channel).map((r) => ({ channel: r.match_channel, orderId: r.match_order_id })));
  const noSupply = { taobaoOrder: '', cost: null, currency: null };
  const kids = new Map(db.prepare(`SELECT parent_id, COUNT(*) AS c FROM inbound_parcels
                                   WHERE parent_id IS NOT NULL GROUP BY parent_id`).all().map((r) => [r.parent_id, r.c]));
  const counts = db.prepare(`
    SELECT SUM(match_channel IS NULL AND quantity > 0) AS unmatched,
           SUM(match_channel IS NOT NULL AND packed_at IS NULL) AS matched,
           SUM(packed_at IS NOT NULL) AS packed, COUNT(*) AS total
    FROM inbound_parcels`).get();
  const extraMap = new Map();
  for (const x of db.prepare('SELECT * FROM parcel_photos ORDER BY position, id').all()) {
    if (!extraMap.has(x.parcel_id)) extraMap.set(x.parcel_id, []);
    extraMap.get(x.parcel_id).push(x);
  }
  return {
    counts: { unmatched: counts.unmatched || 0, matched: counts.matched || 0, packed: counts.packed || 0, total: counts.total || 0 },
    rows: rows.map((r) => shapeParcel(r, items.get(`${r.match_channel}:${r.match_item_id}`) ?? null, kids.get(r.id) ?? 0,
      onHold.get(`${r.match_channel}:${r.match_order_id}`) ?? null,
      r.match_channel ? supplies.get(`${r.match_channel}:${r.match_order_id}`) ?? noSupply : null, extraMap.get(r.id) ?? [])),
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
    INSERT INTO inbound_parcels (carrier, last4, quantity, attachment_id, warehouse, note, received_on, raw_text)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(fields.carrier, fields.last4, fields.quantity, attachmentId, String(warehouse).trim(), String(note).trim(), day,
      String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null);
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
    UPDATE inbound_parcels SET carrier = ?, last4 = ?, quantity = ?, warehouse = ?, note = ?, received_on = ?,
      raw_text = CASE WHEN carrier = ? AND last4 = ? AND quantity = ? THEN raw_text ELSE NULL END WHERE id = ?`)
    .run(next.carrier, next.last4, next.quantity, next.warehouse, next.note, next.received_on,
      next.carrier, next.last4, next.quantity, row.id);
  // Its tracking digits or piece count may be what a hold was written from.
  if (row.match_channel) touchHold(row.match_channel, row.match_order_id);
  return getParcel(row.id);
}

export function deleteParcel(id) {
  const db = getDb();
  const row = getRow(id);
  if (row.match_channel) undoMatchEffects(row);
  // Arrivals that were split out of this photo are real deliveries of their own; they stay.
  db.prepare('UPDATE inbound_parcels SET parent_id = NULL WHERE parent_id = ?').run(row.id);
  const extras = photosOf(row.id);
  db.prepare('DELETE FROM parcel_photos WHERE parcel_id = ?').run(row.id);
  db.prepare('DELETE FROM inbound_parcels WHERE id = ?').run(row.id);
  memory.forgetLooks(row.id);
  if (row.match_channel) { touchHold(row.match_channel, row.match_order_id); releaseIfUnused(row.match_channel, row.match_order_id); }
  for (const att of new Set([row.attachment_id, row.original_attachment_id, ...extras.map((x) => x.attachment_id)].filter(Boolean))) removeParcelAttachment(att);
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

  // every connected shop, not only the one that is open: an order is waiting for its parcel whichever shop it came from
  const etsyShops = db.prepare('SELECT shop_id, COALESCE(NULLIF(label, \'\'), shop_name) AS name FROM etsy_accounts ORDER BY id').all();
  if (only ? only.channel === 'etsy' : range.channels.includes('etsy')) for (const shop of etsyShops) {
    const etsyShop = shop.shop_id;
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
        channel: 'etsy', shopId: etsyShop, shopName: shop.name || '', orderId: String(r.receipt_id), orderRef: codes[r.receipt_id] || String(r.receipt_id),
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

  const stores = db.prepare('SELECT id, COALESCE(NULLIF(label, \'\'), shop_name, shop_domain) AS name FROM shopify_accounts ORDER BY id').all();
  if (only ? only.channel === 'shopify' : range.channels.includes('shopify')) for (const store of stores) {
    const shopifyShop = store.id;
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
        channel: 'shopify', shopId: shopifyShop, shopName: store.name || '', orderId: r.order_id, orderRef: codes[r.order_id] || r.name || r.order_id,
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

// ------------------------------------------------------------------ engines

/**
 * The engines to try for a photo job, in order: the one asked for (or the one chosen for warehouse photos in
 * Settings), then every other engine that has a key and can read images - so a down, rate-limited or
 * out-of-credit engine does not stop the work when another is ready.
 */
export function engineChain(preferred) {
  const wanted = preferred || readSetting('ai.warehouse.provider') || undefined;
  let status;
  try { status = providerStatus(); } catch { return [wanted]; }
  const ready = Object.keys(status).filter((p) => p !== 'active' && status[p]?.configured && status[p]?.supportsImages);
  const chain = [];
  if (wanted && ready.includes(wanted)) chain.push(wanted);
  for (const p of [status.active, ...ready]) if (ready.includes(p) && !chain.includes(p)) chain.push(p);
  return chain.length ? chain : [wanted];
}

/** Run one photo job on the first engine that works. Returns the AI answer with `tried` = the engines that failed first. */
async function runVision(opts, { provider, model, runner = run, fallback = true } = {}) {
  const chain = engineChain(provider);
  const tried = [];
  let last = null;
  for (let i = 0; i < chain.length; i += 1) {
    const engine = chain[i];
    try {
      const useModel = i === 0 ? (model || readSetting('ai.warehouse.model') || undefined) : undefined;
      // eslint-disable-next-line no-await-in-loop
      const out = await runner({ ...opts, provider: engine, model: useModel });
      return { ...out, tried };
    } catch (err) {
      last = err;
      tried.push({ engine: engine || 'default', error: String(err.message || err).slice(0, 200) });
      if (!fallback || /switched off|Privacy/i.test(String(err.message))) break;
    }
  }
  throw last ?? new Error('No AI engine could look at this photo.');
}

// ----------------------------------------------------------------- matching

const MATCH_SYSTEM = `You help a dropshipping shop work out which customer order a parcel belongs to.

The FIRST image - or the first few, the input says how many - are photos a warehouse worker took of
items that have just arrived at the warehouse: usually boxed or bagged products on a floor or table,
often under poor lighting, sometimes still in a retail box or a delivery bag. When there are several
they all show the SAME package (another side of it, the carrier's label, the other half of a product the
warehouse split across two trays), so read them together. One photo can show more than one product,
because one delivery may hold things bought for different customers. Every image AFTER those is the shop's
own listing photo of one product customers have ordered, numbered in the order given (listing 1, listing 2, ...).

Warehouses often split ONE customer product into parts (a main kit in one tray and its accessory set in
another, or a product apart from its box). Parts that belong together count as that one listing being there.

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
  const photos = allPhotos(parcel);
  const guide = memory.guidance();
  const ai = await runVision({
    kind: 'custom',
    promptOverride: guide ? `${MATCH_SYSTEM}\n\n${guide}` : MATCH_SYSTEM,
    attachmentIds: [...photos.map((p) => ({ id: p.id, detail: 'high' })), ...batch.map((p) => ({ id: p.attachmentId, detail }))],
    // Picking a picture out of a few is not a task to think hard about.
    effort: 'fast',
    context: { listings: batch.map((p, i) => ({ index: i + 1, title: p.title, sku: p.sku })) },
    userInput: `The first ${photos.length} image${photos.length === 1 ? ' is' : 's are'} the warehouse photo${photos.length === 1 ? '' : 's'} of one package`
      + `${photos.some((p) => p.kind === 'label') ? ` (${photos.filter((p) => p.kind === 'label').length} of them show a label)` : ''}. `
      + 'Each image after that is one numbered listing photo, in order. JSON only.',
    maxTokens: 900,
  }, { provider, model, runner });
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
  return { scored, unreadable: !!parsed.unreadable, provider: ai.provider, model: ai.model, tried: ai.tried };
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
      result.tried = good.flatMap((r) => r.tried ?? []).slice(0, 4);

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

function lookupItem(channel, orderId, itemId, receivedOn = null) {
  const db = getDb();
  if (channel === 'etsy') {
    const row = db.prepare(`
      SELECT r.receipt_id, r.created_ts, x.transaction_id, x.warehouse_photo_id
      FROM receipt_transactions x JOIN receipts r ON r.receipt_id = x.receipt_id
      WHERE x.transaction_id = ? AND x.receipt_id = ?`)
      .get(Number(itemId), Number(orderId));
    if (!row) throw notFound(`Item ${itemId} is not on Etsy order ${orderId}.`);
    // The order's first parcel is what gives it a code (today's date, next number of the day).
    return { code: ensureOrderCode('etsy', row.receipt_id, { receivedOn }) || String(row.receipt_id), warehousePhotoId: row.warehouse_photo_id };
  }
  if (channel === 'shopify') {
    const row = db.prepare(`
      SELECT o.order_id, o.name, x.line_item_id, x.warehouse_photo_id
      FROM shopify_order_line_items x JOIN shopify_orders o ON o.order_id = x.order_id
      WHERE x.line_item_id = ? AND x.order_id = ?`)
      .get(String(itemId), String(orderId));
    if (!row) throw notFound(`Item ${itemId} is not on Shopify order ${orderId}.`);
    return { code: ensureOrderCode('shopify', row.order_id, { receivedOn }) || row.name || row.order_id, warehousePhotoId: row.warehouse_photo_id };
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
  return inOrderShop(channel, orderId, () => applyMatchEffectsHere(parcel, channel, orderId, itemId, existingPhotoId));
}

function applyMatchEffectsHere(parcel, channel, orderId, itemId, existingPhotoId) {
  if (parcel.attachment_id && !existingPhotoId) setItemPhoto(channel, orderId, itemId, parcel.attachment_id);
  const token = trackingToken(parcel);
  if (token) {
    const list = splitTracking(currentSupplyTracking(channel, orderId));
    if (!list.includes(token)) writeSupplyTracking(channel, orderId, [...list, token].join(', '));
  }
}

function undoMatchEffects(parcel) {
  return inOrderShop(parcel.match_channel, parcel.match_order_id, () => undoMatchEffectsHere(parcel));
}

function undoMatchEffectsHere(parcel) {
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

/**
 * Remember how the warehouse's photo of this product looked, so the free matcher can recognise the
 * next one by it. Only from matches that can be trusted: ones a person made or confirmed, or that
 * the tracking number settled - never a guess the colours alone made.
 */
function learnLook(parcel, channel, itemId, source, score) {
  try {
    if (source === 'quick' && !(Number(score) >= 0.96)) return;
    const db = getDb();
    const line = channel === 'etsy'
      ? db.prepare('SELECT sku, image_url FROM receipt_transactions WHERE transaction_id = ?').get(Number(itemId))
      : db.prepare('SELECT sku, image_url FROM shopify_order_line_items WHERE line_item_id = ?').get(String(itemId));
    const key = memory.itemKey({ sku: line?.sku, imageUrl: line?.image_url });
    memory.forgetLooks(parcel.id);
    if (!key) return;
    for (const p of allPhotos(parcel, { kinds: ['product'] })) memory.rememberLook({ key, attachmentId: p.id, parcelId: parcel.id });
  } catch (err) { console.warn(`[packing] could not remember the look of parcel ${parcel.id}: ${err.message}`); }
}

export function confirmMatch(id, { channel, orderId, itemId, source = 'manual', score = null } = {}) {
  const db = getDb();
  const parcel = getRow(id);
  if (!channel || orderId == null || itemId == null) throw badRequest('channel, orderId and itemId are required.');
  const target = lookupItem(channel, orderId, itemId, parcel.received_on);
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
  learnLook(parcel, channel, itemId, source, score);
  // Look at the order this parcel now belongs to (and the one it left): if the rest of it
  // has not arrived, this parcel is put on hold; if it is the last piece, the hold is released.
  if (parcel.match_channel) { touchHold(parcel.match_channel, parcel.match_order_id); releaseIfUnused(parcel.match_channel, parcel.match_order_id); }
  touchHold(channel, orderId);
  audit('packing.match', { entity: 'parcel', entityId: parcel.id, detail: { channel, orderId, itemId, code: target.code, source, score } });
  return getParcel(parcel.id);
}

export function unmatchParcel(id) {
  const parcel = getRow(id);
  if (!parcel.match_channel) return getParcel(parcel.id);
  undoMatchEffects(parcel);
  memory.forgetLooks(parcel.id);
  getDb().prepare(`
    UPDATE inbound_parcels SET match_channel = NULL, match_order_id = NULL, match_item_id = NULL, match_code = NULL,
      match_source = NULL, match_score = NULL, matched_at = NULL, packed_at = NULL WHERE id = ?`).run(parcel.id);
  touchHold(parcel.match_channel, parcel.match_order_id);
  releaseIfUnused(parcel.match_channel, parcel.match_order_id);
  audit('packing.unmatch', { entity: 'parcel', entityId: parcel.id });
  return getParcel(parcel.id);
}

// -------------------------------------------------------------------- split

const MAX_REGIONS = 12;
const DETECT_LISTING_PHOTOS = 24;
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
 * One photo can show products bought for several customers. Each product becomes
 * its own arrival - same carrier line, one piece, with just that product's
 * cropped photo - so it can be matched to its own customer's order and sit on
 * its own row of the packing sheet. What is left of the photo (the browser has
 * already taken the boxed parts out of it) stays with the original arrival,
 * which keeps the untouched photo and its piece count so the split can be undone.
 * When nothing is left (`done`), the original arrival is just the container.
 *
 * A product the warehouse laid out in several places (a kit in one tray, its accessory set in
 * another) is several boxes with the same `group`: they become ONE arrival holding all those
 * crops, not one arrival per part. Boxes with no group are a product each.
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

  const given = Array.isArray(regions) ? regions : [];
  const boxes = given.map(cleanBox);
  if (!boxes.length || boxes.length > MAX_REGIONS) throw badRequest(`Split between 1 and ${MAX_REGIONS} boxes at a time.`);
  if (crops.length !== boxes.length) throw badRequest('Every box needs its cropped photo.');
  for (const f of [...crops, remainder].filter(Boolean)) {
    if (!String(f.mimetype || '').startsWith('image/')) throw badRequest('Split photos have to be images.');
  }

  // Boxes that share a group are one product; every other box is a product of its own.
  const products = [];
  const byGroup = new Map();
  boxes.forEach((box, i) => {
    const g = Math.floor(Number(given[i]?.group));
    if (Number.isFinite(g) && g > 0) {
      if (!byGroup.has(g)) { byGroup.set(g, { boxIdx: [] }); products.push(byGroup.get(g)); }
      byGroup.get(g).boxIdx.push(i);
    } else products.push({ boxIdx: [i] });
  });

  // `done` is the browser saying nothing is left in the photo once the boxes are
  // out. Whether the original arrival stays open follows what the photo shows,
  // not the piece count the warehouse typed, which can be off.
  const piecesLeft = done ? 0 : Math.max(1, parent.quantity - products.length);
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
    for (const product of products) {
      const [first, ...more] = product.boxIdx;
      const info = db.prepare(`
        INSERT INTO inbound_parcels (carrier, last4, quantity, attachment_id, warehouse, note, received_on, parent_id, source_box)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(parent.carrier, parent.last4, 1, cropIds[first], parent.warehouse, parent.note, parent.received_on, parent.id, JSON.stringify(boxes[first]));
      const childId = Number(info.lastInsertRowid);
      more.forEach((idx, n) => db.prepare('INSERT INTO parcel_photos (parcel_id, attachment_id, kind, position) VALUES (?,?,?,?)')
        .run(childId, cropIds[idx], 'product', n + 1));
      childIds.push(childId);
    }
    db.prepare('UPDATE inbound_parcels SET attachment_id = ?, quantity = ?, suggestions = NULL, raw_text = NULL WHERE id = ?')
      .run(remainderId ?? parent.attachment_id, piecesLeft, parent.id);
  })();
  removeParcelAttachment(previousRemainder);

  // What the seller grouped by hand is what the AI is told next time.
  for (const product of products) {
    const names = product.boxIdx.map((i) => String(given[i]?.label ?? '').trim()).filter(Boolean);
    if (product.boxIdx.length > 1 && names.length > 1) {
      memory.addLesson(`In one warehouse photo, "${names.join('" and "')}" were parts of ONE customer product (the warehouse had split it) - the seller grouped them.`);
    }
  }
  const lone = products.filter((q) => q.boxIdx.length === 1).map((q) => String(given[q.boxIdx[0]]?.label ?? '').trim()).filter(Boolean);
  if (lone.length > 1 && lone.length === products.length) {
    memory.addLesson(`In one warehouse photo, "${lone.join('", "')}" were separate customer products - the seller split them apart.`);
  }

  audit('packing.split', { entity: 'parcel', entityId: parent.id, detail: { children: childIds, boxes, groups: products.map((q) => q.boxIdx) } });
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
    const kidExtras = photosOf(kid.id);
    db.prepare('DELETE FROM parcel_photos WHERE parcel_id = ?').run(kid.id);
    db.prepare('DELETE FROM inbound_parcels WHERE id = ?').run(kid.id);
    memory.forgetLooks(kid.id);
    removeParcelAttachment(kid.attachment_id);
    for (const x of kidExtras) removeParcelAttachment(x.attachment_id);
    if (kid.match_channel) touchHold(kid.match_channel, kid.match_order_id);
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

The FIRST image is the photo, taken at a warehouse of items that have just arrived - usually boxed or
bagged products on a floor or table, sometimes several at once because one delivery can hold things
bought for different customers. Any images AFTER the first are the shop's own listing photos of products
customers have ordered, numbered in the order given (listing 1, listing 2, ...) with their titles in the
context; they are only there to help you decide which parts belong to one product.

Return a bounding box for EACH separate item you can see. Coordinates are percentages of the whole photo:
x and y are the top-left corner, measured from the photo's top-left; w and h are the box's width
and height - every number from 0 to 100.

Rules:
- One box per separate physical item. A set sold together, or one item in its own retail box, is ONE
  box. Two different products side by side are two.
- A product inside a display case, frame, clamshell, jar or bag is ONE product: box the whole case
  or frame - never the thing inside it as well.
- Box only the product and the box or bag it came in - not the table, the floor, a hand, a shelf,
  a label, a receipt, tape, foam, a ruler, a phone, text on the photo, or loose packing material.
  These are not products and get no box.
- Only box what you are sure is a product. When something might be rubbish or packing, leave it out
  and give anything you do box a confidence you honestly believe.
- Boxes should not overlap one another. When items touch, put the line between them where the
  gap or the edge of the nearer item is.
- If you can only see one product, return one box around it.
- Order the boxes left to right, then top to bottom.

GROUPS - the part that matters most. Warehouses often split ONE customer's product across several
trays or spots in the photo (the main kit in one tray, its accessory set or spare parts in another, the
item apart from its box). Give every box a "group" number: boxes that are parts of the SAME customer
product share a number, boxes of different products get different numbers. Number groups 1, 2, 3 in
order of first appearance. Use the listing photos and titles: when two parts of the photo both look like
pieces of the SAME listing (the main keycap set in one tray and the extra/novelty keys of that same theme in
another tray, a kit and the accessories its title mentions), they belong in one group - the listing photo often
shows them together. Two things that match two different listings are two groups. Do not merge two things only
because they look alike - two identical items bought by two customers are two groups.

Reply with JSON only:
{"items":[{"x":0,"y":0,"w":0,"h":0,"group":1,"label":"a few words that identify it, like 'black keyboard' or 'blue-haired figure in a box'","confidence":0.0}],
 "note":"one short sentence on how you grouped them, or why you could not"}`;

const area = (b) => b.w * b.h;
const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
};
/** The share of `inner` that lies inside `outer` (1 = completely inside). */
const insideShare = (inner, outer) => {
  const w = Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y);
  return w <= 0 || h <= 0 ? 0 : (w * h) / area(inner);
};

/** A small margin round every box so a crop never clips the product - skipped for boxes that would then overlap. */
function padBoxes(boxes, pad = 0.012) {
  const padded = boxes.map((b) => {
    const x = clamp01(b.x - pad); const y = clamp01(b.y - pad);
    return { ...b, x, y, w: Math.min(1 - x, b.w + 2 * pad), h: Math.min(1 - y, b.h + 2 * pad) };
  });
  return boxes.map((b, i) => (padded.some((p, j) => j !== i && overlap(padded[i], p) > 0) ? b : padded[i]));
}

/**
 * Ask the AI where each product sits in this arrival's photo. Only a
 * suggestion - the boxes come back to the browser to be moved, resized,
 * added or removed before anything is cut.
 *
 * `auto` is the stricter mode used when the photo is split without anyone
 * looking: only boxes the AI is sure of, each big enough to be a product, none
 * inside another (the keycap inside its display frame is not a second product),
 * nothing that fills the whole photo - and it says whether there is anything
 * to split at all (two products or more).
 */
export async function detectRegions(id, { provider, model, auto = false, runner = run, channels, from, to } = {}) {
  const parcel = getRow(id);
  if (!parcel.attachment_id) throw badRequest('This arrival has no photo to look at.');
  if (parcel.quantity < 1) throw badRequest('Every piece of this photo has already been split out.');

  // What customers have ordered - titles, and the listing photos of the oldest ones: lets the AI see which
  // parts of the photo together make one listed product (a kit in one tray, its extra keys in another).
  const listings = [];
  const titlesOnly = [];
  try {
    const open = loadDemand(resolveRange({ channels, from, to })).filter((x) => x.remaining > 0);
    const byImage = new Map();
    for (const d of open) {
      const t = String(d.title || '').replace(/\s+/g, ' ').trim().slice(0, 110);
      if (!t) continue;
      const key = d.imageUrl || `title:${t}`;
      if (!byImage.has(key)) byImage.set(key, { imageUrl: d.imageUrl, title: t });
    }
    const distinct = [...byImage.values()];
    const withPhoto = distinct.filter((x) => x.imageUrl).slice(0, DETECT_LISTING_PHOTOS);
    const loaded = await mapLimit(withPhoto, 6, async (c) => {
      try { return { ...c, attachmentId: await cachedProductImageId(c.imageUrl) }; } catch { return null; }
    });
    for (const c of loaded) if (c) listings.push(c);
    const shown = new Set(listings.map((c) => c.title));
    for (const c of distinct) if (!shown.has(c.title) && titlesOnly.length < 30) titlesOnly.push(c.title);
  } catch { /* the photo can still be looked at without the order list */ }

  const guide = memory.guidance();
  const ai = await runVision({
    kind: 'custom',
    promptOverride: guide ? `${DETECT_SYSTEM}\n\n${guide}` : DETECT_SYSTEM,
    attachmentIds: [{ id: parcel.attachment_id, detail: 'high' }, ...listings.map((c) => ({ id: c.attachmentId, detail: 'low' }))],
    effort: 'fast',
    ...(listings.length || titlesOnly.length ? {
      context: {
        ...(listings.length ? { listings: listings.map((c, i) => ({ index: i + 1, title: c.title })) } : {}),
        ...(titlesOnly.length ? { otherProductsOrdered: titlesOnly } : {}),
      },
    } : {}),
    userInput: `The warehouse reported ${parcel.quantity} piece${parcel.quantity === 1 ? '' : 's'} in this photo (that number is often wrong - go by what you see).`
      + `${listings.length ? ` The first image is the warehouse photo; the ${listings.length} after it are numbered listing photos.` : ''} JSON only.`,
    maxTokens: 1200,
  }, { provider, model, runner });
  const parsed = parseJsonish(ai.text);
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('The AI did not return a usable answer.');

  const raw = parsed.items.map((i, n) => ({ ...i, x: Number(i.x), y: Number(i.y), w: Number(i.w), h: Number(i.h), n }))
    .filter((i) => [i.x, i.y, i.w, i.h].every(Number.isFinite));
  // Told percentages, a model sometimes answers in 0-1 fractions; every box then fits inside 1.
  const scale = raw.length && raw.every((i) => i.x + i.w <= 1.05 && i.y + i.h <= 1.05) ? 1 : 100;

  const minConfidence = auto ? 0.5 : 0.3;
  const minSide = auto ? 0.06 : 0.03;
  const found = raw
    .map((i) => {
      const x = clamp01(i.x / scale);
      const y = clamp01(i.y / scale);
      const g = Math.floor(Number(i.group));
      return {
        x, y, w: Math.min(1 - x, i.w / scale), h: Math.min(1 - y, i.h / scale),
        label: String(i.label ?? '').slice(0, 60),
        confidence: Number.isFinite(Number(i.confidence)) ? clamp01(Number(i.confidence)) : null,
        group: Number.isFinite(g) && g > 0 ? g : null,
        n: i.n,
      };
    })
    .filter((b) => b.w >= minSide && b.h >= minSide && (b.confidence == null ? !auto : b.confidence >= minConfidence))
    .filter((b) => !(auto && area(b) > 0.9)) // a box round the whole photo is "nothing found", not a product
    .sort((a, b) => area(b) - area(a));

  // Biggest first: a box that sits inside one already kept (the keycap in its frame) or mostly on top of it is dropped.
  const kept = [];
  for (const b of found) if (!kept.some((k) => overlap(k, b) > 0.5 || insideShare(b, k) > 0.7)) kept.push(b);
  const limited = kept.slice(0, MAX_REGIONS);
  const ordered2 = (auto ? padBoxes(limited) : limited).sort((a, b) => a.x - b.x || a.y - b.y);

  // Groups renumbered 1, 2, 3 in the order the boxes now read; a box the AI gave no group is a product of its own.
  const renumber = new Map();
  let next = 0;
  const regions = ordered2.map((b) => {
    const key = b.group != null ? `g${b.group}` : `own${b.n}`;
    if (!renumber.has(key)) { next += 1; renumber.set(key, next); }
    return { ...cleanBox(b), label: b.label, confidence: b.confidence, group: renumber.get(key) };
  });

  const out = { regions, groups: next, note: String(parsed.note ?? '').slice(0, 240), provider: ai.provider, model: ai.model, tried: ai.tried };
  if (auto) {
    const split = next >= 2 && next <= 6;
    out.auto = {
      split,
      reason: split ? `${next} separate products${regions.length > next ? ` (${regions.length} parts)` : ''}` : next > 6
        ? `${next} products is more than a photo of parcels usually holds - split it by hand`
        : regions.length > 1 ? 'the parts are one product' : regions.length === 1 ? 'one product' : 'no product found',
    };
  }
  return out;
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
/** Orders still to ship, in any connected shop, that were placed before the window starts. */
function olderUnshipped(range) {
  const db = getDb();
  let n = 0;
  if (range.channels.includes('etsy')) {
    n += db.prepare(`
      SELECT COUNT(*) AS c FROM receipts r LEFT JOIN order_flags f ON f.receipt_id = r.receipt_id
      WHERE COALESCE(r.was_shipped,0) = 0 AND COALESCE(r.was_canceled,0) = 0 AND COALESCE(f.is_canceled,0) = 0 AND COALESCE(r.was_paid,1) = 1
        AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.receipt_id = r.receipt_id AND s.tracking_code IS NOT NULL AND s.tracking_code <> '')
        AND r.shop_id IN (SELECT shop_id FROM etsy_accounts) AND r.created_ts < ?`).get(range.fromTs).c;
  }
  if (range.channels.includes('shopify')) {
    n += db.prepare(`
      SELECT COUNT(*) AS c FROM shopify_orders o LEFT JOIN shopify_fulfillments f ON f.order_id = o.order_id
      WHERE o.cancelled_at IS NULL AND COALESCE(f.is_canceled,0) = 0
        AND UPPER(COALESCE(o.fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')
        AND UPPER(COALESCE(o.financial_status,'')) NOT IN ('VOIDED','REFUNDED') AND COALESCE(f.tracking_number,'') = ''
        AND o.shop_id IN (SELECT id FROM shopify_accounts) AND substr(o.created_at_shopify,1,10) < ?`).get(range.from).c;
  }
  return n;
}

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

  const onHold = holds.allHolds();
  const orders = new Map();
  for (const d of demand) {
    const key = `${d.channel}:${d.orderId}`;
    if (!orders.has(key)) {
      orders.set(key, {
        channel: d.channel, shopId: d.shopId, shopName: d.shopName, orderId: d.orderId, ref: d.orderRef, orderedAt: d.orderedAt, buyer: d.buyer, items: [],
        hold: onHold.get(key) ?? null,
      });
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
    connected: {
      etsy: db.prepare('SELECT 1 FROM etsy_accounts LIMIT 1').get() != null,
      shopify: db.prepare('SELECT 1 FROM shopify_accounts LIMIT 1').get() != null,
    },
    summary: { ...summary, orders: list.length, unmatchedParcels: unmatched },
    // every shop the list looks through, and the orders still to ship that are older than the window (so they are not silently missing)
    shops: unshippedByShop().shops.map((x) => ({ channel: x.channel, shopId: x.shopId, name: x.name, unshipped: x.unshipped, oldest: x.oldest })),
    olderThanRange: olderUnshipped(range),
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
  const onHold = holds.allHolds();
  const supplies = supplyForOrders(rows.filter((r) => r.match_channel).map((r) => ({ channel: r.match_channel, orderId: r.match_order_id })));

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Packing', { properties: { defaultRowHeight: 18 } });
  sheet.columns = [
    { header: 'Tracking Code\n(跟踪号码)', key: 'label', width: 26 },
    { header: 'Code\n(编号)', key: 'code', width: 18 },
    { header: 'Image\n(图片)', key: 'image', width: 22 },
    { header: 'Warehouse\n(仓库)', key: 'warehouse', width: 18 },
    { header: 'Message to warehouse\n(留言)', key: 'message', width: 60 },
    // Everything after the five columns the warehouse needs is still in the file, just hidden
    // (select the columns around them and "Unhide" to see it).
    { header: 'Channel', key: 'channel', width: 10, hidden: true },
    { header: 'Item', key: 'item', width: 44, hidden: true },
    { header: 'Customer', key: 'buyer', width: 20, hidden: true },
    { header: 'Status', key: 'status', width: 12, hidden: true },
    { header: 'Received', key: 'received', width: 12, hidden: true },
    { header: 'Note', key: 'note', width: 30, hidden: true },
    { header: 'Taobao order', key: 'taobao', width: 26, hidden: true },
    { header: 'Supply cost', key: 'cost', width: 12, hidden: true },
    { header: 'Cost currency', key: 'currency', width: 10, hidden: true },
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
    // "Tracking Code" is always the line as it was typed. A parcel of an order that was not all here when it
    // arrived carries that order's HOLD code in "Code" for as long as it is to be kept (both parcels of the
    // order do, so the warehouse can tell they go together), with the message to the warehouse beside it;
    // once the order is complete "Code" is the order's own code again.
    const hold = p.match_channel ? onHold.get(`${p.match_channel}:${p.match_order_id}`) ?? null : null;
    const holding = hold?.state === 'active';
    const row = sheet.addRow({
      label: p.raw_text || parcelLabel(p), code: (holding ? hold.code : p.match_code) || '', image: '', warehouse: p.warehouse,
      // An arrival nobody has matched yet says so, rather than leaving the cells blank.
      channel: p.match_channel ? (p.match_channel === 'etsy' ? 'Etsy' : 'Shopify') : '-',
      item: item ? `${item.title}${item.variant ? ` (${item.variant})` : ''}` : p.match_channel ? '(item no longer in the order mirror)' : 'Not matched yet - add its order code',
      buyer: item?.buyer || '',
      status: p.packed_at ? 'Packed' : holding ? 'On hold' : p.match_channel ? 'Matched' : 'Unmatched', received: p.received_on, note: p.note,
      message: hold ? hold.messageZh : '',
      taobao: supplies.get(`${p.match_channel}:${p.match_order_id}`)?.taobaoOrder || '',
      cost: supplies.get(`${p.match_channel}:${p.match_order_id}`)?.cost ?? '',
      currency: supplies.get(`${p.match_channel}:${p.match_order_id}`)?.currency || '',
    });
    if (hold) {
      const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: holding ? 'FFFFF3CD' : 'FFE3F4E1' } };
      row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = fill; });
    }
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
