import { Router } from 'express';
import { asyncRoute, bool, int, required } from '../lib/http.js';
import * as taobao from '../services/taobao.js';

const router = Router();

/** The supply book, with margin worked out against what each SKU sells for. */
router.get('/', asyncRoute(async (req, res) => {
  res.json({
    suppliers: taobao.SUPPLIERS,
    coverage: taobao.coverage(),
    items: taobao.list({
      search: req.query.search ?? '',
      supplier: req.query.supplier ?? '',
      missingLink: bool(req.query.missingLink),
      limit: int(req.query.limit, 500),
    }),
  });
}));

/** Read a pasted link without saving it, so the form can fill itself in. */
router.get('/parse', asyncRoute(async (req, res) => {
  required(req.query, ['url']);
  res.json(taobao.parseSupplyUrl(req.query.url));
}));

router.get('/:sku', asyncRoute(async (req, res) => {
  res.json(taobao.getItem(req.params.sku) ?? { sku: req.params.sku, missing: true });
}));

router.put('/:sku', asyncRoute(async (req, res) => {
  res.json(taobao.saveItem({ ...req.body, sku: req.params.sku }));
}));

router.delete('/:sku', asyncRoute(async (req, res) => res.json(taobao.removeItem(req.params.sku))));

/** Bring the old Taobao sheet across in one paste. */
router.post('/import', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['text']);
  res.json(taobao.importRows(req.body.text));
}));

export default router;
