import { Router } from 'express';
import { asyncRoute, int } from '../lib/http.js';
import * as undo from '../services/undo.js';

const router = Router();

/** What Ctrl+Z would take back right now, for the button's label. */
router.get('/next', asyncRoute(async (req, res) => res.json(undo.next() ?? { nothing: true })));

/** The whole history, including the steps that cannot be taken back here. */
router.get('/', asyncRoute(async (req, res) => {
  res.json({ history: undo.history({ limit: int(req.query.limit, 50) }), next: undo.next() });
}));

/** Take back the last change, or a named one. */
router.post('/', asyncRoute(async (req, res) => res.json(undo.undo(req.body?.id ?? null))));

router.delete('/', asyncRoute(async (req, res) => res.json(undo.clear())));

export default router;
