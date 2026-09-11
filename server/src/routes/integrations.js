import { Router } from 'express';
import { asyncRoute, bool } from '../lib/http.js';
import * as ps from '../services/productstudio.js';

const router = Router();

/**
 * Only this machine may add products.
 *
 * The server listens on localhost, but a web page open in your browser is also
 * on localhost and could post here. So a request has to carry the pairing key,
 * and a browser page is turned away by its Origin regardless.
 */
function guard(req, res, next) {
  const origin = req.get('origin');
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
    return res.status(403).json({
      error: 'Products can only be added from a program on this computer, not from a web page.',
    });
  }
  const key = req.get('x-product-studio-key') || req.query.key || req.body?.key;
  if (!ps.checkKey(key)) {
    return res.status(401).json({
      error: 'Wrong or missing pairing key.',
      hint: 'Open Draft desk -> Connect Product Studio in this app and copy the key from there.',
    });
  }
  return next();
}

/** Everything the other app needs to wire its button up. */
router.get('/product-studio', asyncRoute(async (req, res) => res.json(ps.contract())));

/** A new pairing key, if the old one leaked or you want to re-pair. */
router.post('/product-studio/key', asyncRoute(async (req, res) => {
  res.json({ key: ps.pairingKey({ regenerate: true }) });
}));

/**
 * The button: one product in, one draft out.
 * `?dryRun=1` reads the payload and reports the mapping without creating anything.
 */
router.post('/product-studio/product', guard, asyncRoute(async (req, res) => {
  res.status(201).json(await ps.receive(req.body ?? {}, { dryRun: bool(req.query.dryRun) }));
}));

/** Several at once. Each is reported on its own so one bad row does not sink the rest. */
router.post('/product-studio/products', guard, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body?.products ?? [];
  const results = [];
  for (const item of items) {
    try { results.push(await ps.receive(item)); }
    catch (err) { results.push({ error: err.message, title: item?.title ?? null }); }
  }
  res.status(201).json({
    received: items.length,
    created: results.filter((r) => r.ok).length,
    failed: results.filter((r) => r.error).length,
    results,
  });
}));

/** Show how a payload would be read, changing nothing. Handy while wiring up. */
router.post('/product-studio/dry-run', guard, asyncRoute(async (req, res) => {
  res.json(ps.readProduct(req.body ?? {}));
}));

/** The no-code path: read whatever was dropped in the folder. */
router.post('/product-studio/scan', asyncRoute(async (req, res) => res.json(await ps.scanInbox())));

/** The photos and options that arrived with a draft. */
router.get('/product-studio/draft/:id', asyncRoute(async (req, res) => {
  res.json(ps.inboxFor(req.params.id) ?? { draftId: Number(req.params.id), fromProductStudio: false });
}));

export default router;
