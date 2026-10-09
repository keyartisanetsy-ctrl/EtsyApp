import { Router } from 'express';
import multer from 'multer';
import { asyncRoute, int, bool } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import * as packing from '../services/packing.js';
import * as quick from '../services/quickmatch.js';
import * as holds from '../services/holds.js';
import * as dispatch from '../services/orderdispatch.js';
import * as ordersupply from '../services/ordersupply.js';
import * as itemsupply from '../services/itemsupply.js';
import * as memory from '../services/packingmemory.js';
import { providerStatus } from '../services/ai/index.js';
import { readSetting, writeSetting } from '../services/settings.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const channelsOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((c) => c.trim()).filter(Boolean);

// ---------------------------------------------------------------- parcels

router.get('/parcels', asyncRoute(async (req, res) => {
  res.json(packing.listParcels({ status: req.query.status ?? 'all', limit: int(req.query.limit, 300) }));
}));

/** A new arrival: the warehouse photo (optional) and the line they sent, e.g. "中通 3324 1件". */
router.post('/parcels', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'photos', maxCount: 11 }, { name: 'labels', maxCount: 4 }]), asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  // The first photo is the arrival's own; any others (more angles, the carrier's label) are kept with it.
  const product = [...(req.files?.photo ?? []), ...(req.files?.photos ?? [])];
  const labels = req.files?.labels ?? [];
  const attachmentId = product[0] ? packing.saveParcelPhoto(product[0]) : null;
  const parcel = packing.createParcel({
    text: b.text ?? '',
    carrier: b.carrier === undefined || b.carrier === '' ? undefined : b.carrier,
    last4: b.last4 === undefined || b.last4 === '' ? undefined : b.last4,
    quantity: b.quantity === undefined || b.quantity === '' ? undefined : b.quantity,
    attachmentId,
    warehouse: b.warehouse ?? '',
    note: b.note ?? '',
    receivedOn: b.receivedOn,
  });
  if (product.length > 1) packing.addParcelPhotos(parcel.id, product.slice(1));
  const stockSku = String(b.stockSku ?? '').trim();
  if (labels.length) packing.addParcelPhotos(parcel.id, labels, { kind: 'label' });
  // An order code typed with the arrival is applied at once. The arrival is kept
  // whatever happens: a code that fits nothing, or an order with several items,
  // comes back as a message / a choice next to it, not as a lost photo.
  // "Add to stock" typed with the arrival: all of its pieces go onto the shelf under that SKU, no order involved.
  if (stockSku) {
    try { res.status(201).json(packing.stockParcel(parcel.id, { sku: stockSku }).parcel); } catch (err) { res.status(201).json({ ...packing.getParcel(parcel.id), stockError: err.message }); }
    return;
  }
  const code = String(b.code ?? '').trim();
  if (!code) { res.status(201).json(product.length > 1 || labels.length ? packing.getParcel(parcel.id) : parcel); return; }
  try {
    const out = await quick.assignByCode(parcel.id, { code, channels: channelsOf(b.channels), from: b.from, to: b.to });
    res.status(201).json(out.needsItem ? { ...packing.getParcel(parcel.id), needsItem: out.needsItem } : out.parcel);
  } catch (err) {
    res.status(201).json({ ...packing.getParcel(parcel.id), codeError: err.message });
  }
}));

router.patch('/parcels/:id', asyncRoute(async (req, res) => {
  res.json(packing.updateParcel(req.params.id, req.body ?? {}));
}));

router.delete('/parcels/:id', asyncRoute(async (req, res) => {
  res.json(packing.deleteParcel(req.params.id));
}));

/** Ask the AI which unshipped order's product this parcel's photo shows. */
router.post('/parcels/:id/match', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await packing.matchParcel(req.params.id, {
    channels: channelsOf(b.channels), from: b.from, to: b.to, provider: b.provider, model: b.model,
  }));
}));

/** The free matcher: tracking, order state, text read off the photo, and colours. No AI, no credits. */
router.post('/parcels/:id/quick', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await quick.quickMatch(req.params.id, {
    channels: channelsOf(b.channels), from: b.from, to: b.to,
    assign: ['tracking', 'sure', 'never'].includes(b.assign) ? b.assign : 'tracking',
  }));
}));

/** What the browser's OCR read off the photo, kept for the free matcher. */
router.post('/parcels/:id/text', asyncRoute(async (req, res) => {
  res.json(packing.setParcelText(req.params.id, req.body?.text ?? ''));
}));

/**
 * Put the arrival on the order with this code (26-0710-01). Replies with the
 * parcel, or - when the order has several items and it cannot tell which this
 * is - `needsItem`, the items to choose from. An empty code releases the arrival.
 */
router.post('/parcels/:id/assign-code', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await quick.assignByCode(req.params.id, {
    code: b.code, itemId: b.itemId ?? null, channels: channelsOf(b.channels), from: b.from, to: b.to,
  }));
}));

router.post('/parcels/:id/confirm', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel || b.orderId == null || b.itemId == null) throw badRequest('channel, orderId and itemId are required.');
  res.json(packing.confirmMatch(req.params.id, {
    channel: b.channel, orderId: b.orderId, itemId: b.itemId, source: b.source, score: b.score,
  }));
}));

router.post('/parcels/:id/unmatch', asyncRoute(async (req, res) => {
  res.json(packing.unmatchParcel(req.params.id));
}));

// ------------------------------------------------- one photo, several customers

/** Ask the AI where each product sits in the photo. Boxes only - nothing is cut or saved. */
router.post('/parcels/:id/detect', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await packing.detectRegions(req.params.id, {
    provider: b.provider, model: b.model, auto: bool(b.auto), channels: channelsOf(b.channels), from: b.from, to: b.to,
  }));
}));

/**
 * Cut the photo into one arrival per box. The browser sends the boxes, one
 * cropped photo per box (`crops`, same order) and what is left of the photo
 * (`remainder`) - it is the browser that does the cutting.
 */
router.post('/parcels/:id/split', upload.fields([{ name: 'crops', maxCount: 12 }, { name: 'remainder', maxCount: 1 }]),
  asyncRoute(async (req, res) => {
    let regions;
    try { regions = JSON.parse(req.body?.regions ?? '[]'); } catch { throw badRequest('The boxes could not be read.'); }
    res.status(201).json(packing.splitParcel(req.params.id, {
      regions,
      crops: req.files?.crops ?? [],
      remainder: req.files?.remainder?.[0] ?? null,
      done: /^(1|true|yes)$/i.test(String(req.body?.done ?? '')),
    }));
  }));

/** Put a split photo back together as it arrived. */
router.post('/parcels/:id/unsplit', asyncRoute(async (req, res) => {
  res.json(packing.unsplitParcel(req.params.id));
}));

// ------------------------------------------------- several photos of one package

/** More photos for this arrival: another side, the carrier's label (kind=label), the other tray. */
router.post('/parcels/:id/photos', upload.array('photos', 12), asyncRoute(async (req, res) => {
  res.status(201).json(packing.addParcelPhotos(req.params.id, req.files ?? [], { kind: req.body?.kind }));
}));
router.delete('/parcels/:id/photos/:photoId', asyncRoute(async (req, res) => {
  res.json(packing.removeParcelPhoto(req.params.id, req.params.photoId));
}));
router.post('/parcels/:id/photos/:photoId/text', asyncRoute(async (req, res) => {
  res.json(packing.setPhotoText(req.params.id, req.params.photoId, req.body?.text ?? ''));
}));
/** Make one extra photo an arrival of its own again. */
router.post('/parcels/:id/photos/:photoId/detach', asyncRoute(async (req, res) => {
  res.json(packing.detachParcelPhoto(req.params.id, req.params.photoId));
}));
/** Gather other arrivals' photos onto this one - they were one package. */
router.post('/parcels/:id/merge', asyncRoute(async (req, res) => {
  res.json(packing.mergeParcels(req.params.id, req.body?.sourceIds ?? []));
}));

// ------------------------------------- sharing pieces out, counting, the shelf

/** How many pieces the photo(s) show - of one product when `channel` + `itemId` name it. */
router.post('/parcels/:id/count', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await packing.countPieces(req.params.id, { provider: b.provider, model: b.model, channel: b.channel, itemId: b.itemId }));
}));
/** Say how many pieces the arrival really has (the line the warehouse typed is kept). */
router.post('/parcels/:id/set-count', asyncRoute(async (req, res) => {
  res.json(packing.setCount(req.params.id, req.body?.quantity));
}));
/** Share the arrival's pieces out: `parts` [{channel, orderId, itemId, qty}] and `stock` {sku, qty}. */
router.post('/parcels/:id/allocate', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json(packing.allocateParcel(req.params.id, { parts: b.parts, stock: b.stock }));
}));
/** Give a share's pieces back to the arrival they came from. */
router.post('/parcels/:id/unallocate', asyncRoute(async (req, res) => {
  res.json(packing.unallocateParcel(req.params.id));
}));
/** Put pieces of the arrival into the real stock of a SKU. */
router.post('/parcels/:id/stock', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.sku ?? '').trim()) throw badRequest('Say which SKU these pieces are.');
  res.status(201).json(packing.stockParcel(req.params.id, { sku: b.sku, qty: b.qty }));
}));
router.post('/parcels/:id/unstock', asyncRoute(async (req, res) => {
  res.json(packing.unstockParcel(req.params.id));
}));
router.get('/skus', asyncRoute(async (req, res) => {
  res.json({ skus: packing.skuSearch(req.query.q ?? '') });
}));

// ----------------------------------------- what the photo reader has been told

const IMAGE_ENGINES = ['openai', 'anthropic', 'gemini', 'openrouter'];

router.get('/brain', asyncRoute(async (req, res) => {
  const status = providerStatus();
  res.json({
    engines: IMAGE_ENGINES.map((id) => ({ id, configured: !!status[id]?.configured, model: status[id]?.model ?? '' })),
    engine: readSetting('ai.warehouse.provider') || '',
    model: readSetting('ai.warehouse.model') || '',
    instructions: memory.instructions(),
    lessons: memory.listLessons(),
    looks: memory.lookCount(),
  });
}));

router.put('/brain', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (b.engine !== undefined) {
    if (b.engine && !IMAGE_ENGINES.includes(b.engine)) throw badRequest('Unknown engine.');
    writeSetting('ai.warehouse.provider', b.engine || '');
  }
  if (b.model !== undefined) writeSetting('ai.warehouse.model', String(b.model || '').trim());
  if (b.instructions !== undefined) memory.setInstructions(b.instructions);
  res.json({ ok: true });
}));

router.delete('/brain/lessons', asyncRoute(async (req, res) => {
  res.json(memory.clearLessons());
}));

// ------------------------------------------------------ orders & the queue

router.get('/queue', asyncRoute(async (req, res) => {
  res.json(packing.packingQueue({ channels: channelsOf(req.query.channels), from: req.query.from, to: req.query.to }));
}));

/** Items still short of their quantity, for assigning a parcel by hand. */
router.get('/open-items', asyncRoute(async (req, res) => {
  res.json(packing.openDemand({ channels: channelsOf(req.query.channels), from: req.query.from, to: req.query.to }));
}));

router.post('/orders/pack', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel || b.orderId == null) throw badRequest('channel and orderId are required.');
  res.json(packing.packOrder({ channel: b.channel, orderId: b.orderId, packed: b.packed === undefined ? true : bool(b.packed) }));
}));

/**
 * Let a held order's parcels go although the order is not complete (the missing
 * piece will not come through the warehouse), or put the hold back.
 */
router.post('/orders/hold', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel || b.orderId == null) throw badRequest('channel and orderId are required.');
  res.json({ hold: holds.setHoldRelease(b.channel, b.orderId, b.release === undefined ? true : bool(b.release)) });
}));

/**
 * The Taobao order number and cost of an order, typed from the Packing page.
 * `airtable` says what to do with Airtable: 'none' (just save), 'check' (send it
 * unless that would overwrite something - then report the conflicts), 'change'
 * or 'keep' (the answer to such a report: overwrite, or leave what is there).
 */
router.post('/orders/supply', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel || b.orderId == null) throw badRequest('channel and orderId are required.');
  const airtable = ['none', 'check', 'change', 'keep'].includes(b.airtable) ? b.airtable : 'none';
  res.json(await ordersupply.saveAndReflect(b.channel, b.orderId,
    { taobaoOrder: b.taobaoOrder, cost: b.cost, currency: b.currency }, { airtable }));
}));

/**
 * The Taobao item (id or link) and price of one order item - what it is saved as, and every shop
 * that sells its SKU. GET shows it; POST saves it to all of those shops (and Shopify's cost per
 * item). `decision`: 'check' (report other shops that hold something different), 'change', 'keep'.
 */
router.get('/items/supply', asyncRoute(async (req, res) => {
  if (!req.query.channel || req.query.itemId == null) throw badRequest('channel and itemId are required.');
  res.json(itemsupply.describe(String(req.query.channel), req.query.itemId, { sku: req.query.sku ?? '' }));
}));

router.post('/items/supply', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel || b.itemId == null) throw badRequest('channel and itemId are required.');
  const decision = ['check', 'change', 'keep'].includes(b.decision) ? b.decision : 'check';
  res.json(await itemsupply.save(b.channel, b.itemId, { taobao: b.taobao, price: b.price, currency: b.currency, sku: b.sku }, { decision }));
}));

/**
 * Hand a waiting order over by hand: its package code and YunExpress tracking number. Takes it off the queue and writes both
 * into its Airtable row (nothing goes to Etsy or Shopify). `airtable`: 'check' | 'change' | 'keep' | 'none'.
 */
router.post('/orders/dispatch', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel || b.orderId == null) throw badRequest('channel and orderId are required.');
  res.json(await dispatch.assign(b.channel, b.orderId, { trackingNumber: b.trackingNumber, code: b.code, carrier: b.carrier || undefined, airtable: b.airtable ?? 'check' }));
}));
router.get('/orders/dispatch', asyncRoute(async (req, res) => {
  if (!req.query.channel || req.query.orderId == null) throw badRequest('channel and orderId are required.');
  res.json(dispatch.describe(String(req.query.channel), req.query.orderId));
}));
router.delete('/orders/dispatch', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(dispatch.undo(b.channel, b.orderId));
}));

router.post('/export', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await packing.exportPackingSheet({ from: b.from, to: b.to, status: b.status ?? 'all' }));
}));

export default router;
