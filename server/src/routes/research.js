import { Router } from 'express';
import { asyncRoute, int, num, bool, required } from '../lib/http.js';
import * as research from '../services/research.js';

const router = Router();

router.post('/keyword', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  if (!b.keyword && !b.taxonomyId) throw new Error('Give a keyword or a taxonomy id.');
  res.json(await research.researchKeyword({
    keyword: b.keyword ?? '',
    taxonomyId: b.taxonomyId ?? null,
    minPrice: b.minPrice ?? null,
    maxPrice: b.maxPrice ?? null,
    sample: int(b.sample, 100),
    sortOn: b.sortOn ?? 'score',
    withAi: !!b.withAi,
    provider: b.provider,
    promptId: b.promptId ? Number(b.promptId) : undefined,
    promptOverride: b.promptOverride,
  }));
}));

router.post('/benchmark', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['keyword']);
  res.json(await research.benchmarkAgainstKeyword(req.body.keyword, { sample: int(req.body.sample, 100) }));
}));

router.get('/runs', asyncRoute(async (req, res) => res.json(research.listRuns(int(req.query.limit, 50)))));

router.get('/runs/:id', asyncRoute(async (req, res) => res.json(research.getRun(Number(req.params.id)))));

router.get('/taxonomy/seller', asyncRoute(async (req, res) => {
  const nodes = await research.sellerTaxonomy({ refresh: bool(req.query.refresh) });
  res.json(bool(req.query.flat) ? research.flattenTaxonomy(nodes) : nodes);
}));

router.get('/taxonomy/buyer', asyncRoute(async (req, res) => {
  const nodes = await research.buyerTaxonomy({ refresh: bool(req.query.refresh) });
  res.json(bool(req.query.flat) ? research.flattenTaxonomy(nodes) : nodes);
}));

router.get('/taxonomy/:id/properties', asyncRoute(async (req, res) => {
  res.json(await research.taxonomyProperties(req.params.id));
}));

router.get('/shops', asyncRoute(async (req, res) => {
  required(req.query, ['name']);
  res.json(await research.searchShops(req.query.name, { limit: int(req.query.limit, 25), offset: int(req.query.offset, 0) }));
}));

export default router;
