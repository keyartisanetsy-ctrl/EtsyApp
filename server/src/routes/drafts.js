import { Router } from 'express';
import { asyncRoute, bool } from '../lib/http.js';
import * as drafts from '../services/drafts.js';

const router = Router();

/** Everything on the desk. */
router.get('/', asyncRoute(async (req, res) => {
  res.json({ drafts: drafts.list({ includePushed: bool(req.query.includePushed) }), editable: drafts.EDITABLE });
}));

/** Bring down whatever Etsy has in draft. */
router.post('/pull', asyncRoute(async (req, res) => {
  res.json(await drafts.pullFromEtsy({ includeInactive: bool(req.body?.includeInactive) }));
}));

/** Start one here. Etsy sees nothing until it is pushed. */
router.post('/', asyncRoute(async (req, res) => res.json(drafts.createLocal(req.body ?? {}))));

router.get('/:id', asyncRoute(async (req, res) => res.json(drafts.get(Number(req.params.id)))));

/** Stage an edit. Send a field as null to drop your change and go back to Etsy's value. */
router.patch('/:id', asyncRoute(async (req, res) => res.json(drafts.stage(Number(req.params.id), req.body ?? {}))));

/** What pushing would do, and anything that would stop it. */
router.get('/:id/preview', asyncRoute(async (req, res) => res.json(drafts.preview(Number(req.params.id)))));

/** Send it to Etsy. */
router.post('/:id/push', asyncRoute(async (req, res) => {
  res.json(await drafts.push(Number(req.params.id), { activate: bool(req.body?.activate) }));
}));

router.post('/:id/revert', asyncRoute(async (req, res) => res.json(drafts.revert(Number(req.params.id)))));
router.delete('/:id', asyncRoute(async (req, res) => res.json(drafts.remove(Number(req.params.id)))));

export default router;
