import { Router } from 'express';
import multer from 'multer';
import { asyncRoute, int, bool } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import * as packing from '../services/packing.js';
import * as quick from '../services/quickmatch.js';
import * as holds from '../services/holds.js';
import * as ordersupply from '../services/ordersupply.js';
import * as itemsupply from '../services/itemsupply.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const channelsOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((c) => c.trim()).filter(Boolean);

// ---------------------------------------------------------------- parcels

router.get('/parcels', asyncRoute(async (req, res) => {
  res.json(packing.listParcels({ status: req.query.status ?? 'all', limit: int(req.query.limit, 300) }));
}));

/** A new arrival: the warehouse photo (optional) and the line they sent, e.g. "中通 3324 1件". */
router.post('/parcels', upload.single('photo'), asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  const attachmentId = req.file ? packing.saveParcelPhoto(req.file) : null;
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
  // An order code typed with the arrival is applied at once. The arrival is kept
  // whatever happens: a code that fits nothing, or an order with several items,
  // comes back as a message / a choice next to it, not as a lost photo.
  const code = String(b.code ?? '').trim();
  if (!code) { res.status(201).json(parcel); return; }
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
  res.json(await packing.detectRegions(req.params.id, { provider: b.provider, model: b.model, auto: bool(b.auto) }));
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

router.post('/export', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await packing.exportPackingSheet({ from: b.from, to: b.to, status: b.status ?? 'all' }));
}));

export default router;
