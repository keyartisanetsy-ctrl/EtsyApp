import { Router } from 'express';
import { asyncRoute, bool } from '../lib/http.js';
import * as er from '../services/etsyrequests.js';

const router = Router();

router.get('/', asyncRoute(async (req, res) => res.json(er.overview())));
router.post('/:id/run', asyncRoute(async (req, res) => res.json(await er.run(req.params.id, { shopIds: Array.isArray(req.body?.shopIds) ? req.body.shopIds.map(Number) : null }))));
router.put('/:id/star', asyncRoute(async (req, res) => res.json({ starred: er.setStar(req.params.id, bool(req.body?.on)) })));
router.put('/:id/auto', asyncRoute(async (req, res) => res.json(er.setAuto(req.params.id, { enabled: bool(req.body?.enabled), minutes: req.body?.minutes }))));
router.put('/limit/daily', asyncRoute(async (req, res) => res.json({ cap: er.setDailyCap(req.body?.cap) })));

export default router;
