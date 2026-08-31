import { Router } from 'express';
import { asyncRoute, int, bool, list, required } from '../lib/http.js';
import * as bulk from '../services/bulk.js';

const router = Router();

router.get('/actions', asyncRoute(async (req, res) => res.json(bulk.actionCatalogue())));

router.get('/jobs', asyncRoute(async (req, res) => res.json(bulk.listJobs(int(req.query.limit, 30)))));

router.get('/jobs/:id', asyncRoute(async (req, res) => res.json(bulk.getJob(req.params.id))));

router.post('/jobs', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  required(b, ['type', 'targets']);
  res.status(201).json(bulk.createJob({
    type: b.type,
    targets: list(b.targets),
    params: b.params ?? {},
    label: b.label,
    dryRun: bool(b.dryRun),
    concurrency: int(b.concurrency, 2),
  }));
}));

router.post('/jobs/:id/cancel', asyncRoute(async (req, res) => res.json(bulk.cancelJob(req.params.id))));

router.post('/jobs/:id/retry', asyncRoute(async (req, res) => res.status(201).json(bulk.retryFailed(req.params.id))));

export default router;
