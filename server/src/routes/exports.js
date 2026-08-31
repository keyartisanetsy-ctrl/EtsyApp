import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { asyncRoute, int, tri, bool } from '../lib/http.js';
import * as excel from '../services/excel.js';

const router = Router();

router.get('/', asyncRoute(async (req, res) => res.json(excel.listExports())));

router.post('/orders', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await excel.exportOrders({
    search: b.search ?? '', done: tri(b.done), shipped: tri(b.shipped), paid: tri(b.paid),
    canceled: tri(b.canceled), hasTracking: tri(b.hasTracking), alertsOnly: bool(b.alertsOnly),
    country: b.country ?? '', sinceDays: int(b.sinceDays), limit: int(b.limit, 5000),
  }));
}));

router.post('/skus', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await excel.exportSkus({
    search: b.search ?? '', state: b.state ?? '', listingId: int(b.listingId),
    missingSku: bool(b.missingSku), missingSupply: bool(b.missingSupply), limit: int(b.limit, 10000),
  }));
}));

router.post('/listings', asyncRoute(async (req, res) => res.json(await excel.exportListings(req.body ?? {}))));
router.post('/tracking', asyncRoute(async (req, res) => res.json(await excel.exportTracking())));
router.post('/tracking-template', asyncRoute(async (req, res) => res.json(await excel.exportTrackingTemplate())));

/** Download a generated workbook. Filename is constrained to the export dir. */
router.get('/download/:filename', asyncRoute(async (req, res) => {
  const safe = path.basename(req.params.filename);
  const file = path.join(config.exportDir, safe);
  if (!file.startsWith(path.resolve(config.exportDir)) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'Export not found' });
  }
  res.download(file, safe);
}));

router.delete('/:filename', asyncRoute(async (req, res) => {
  const safe = path.basename(req.params.filename);
  const file = path.join(config.exportDir, safe);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ deleted: safe });
}));

export default router;
