import { Router } from 'express';
import multer from 'multer';
import { asyncRoute, int, bool } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import * as packing from '../services/packing.js';

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
  res.status(201).json(packing.createParcel({
    text: b.text ?? '',
    carrier: b.carrier === undefined || b.carrier === '' ? undefined : b.carrier,
    last4: b.last4 === undefined || b.last4 === '' ? undefined : b.last4,
    quantity: b.quantity === undefined || b.quantity === '' ? undefined : b.quantity,
    attachmentId,
    warehouse: b.warehouse ?? '',
    note: b.note ?? '',
    receivedOn: b.receivedOn,
  }));
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
  res.json(await packing.detectRegions(req.params.id, { provider: b.provider, model: b.model }));
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

router.post('/export', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await packing.exportPackingSheet({ from: b.from, to: b.to, status: b.status ?? 'all' }));
}));

export default router;
