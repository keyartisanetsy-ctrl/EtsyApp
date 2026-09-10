/**
 * Raw API explorer.
 *
 * Exposes every one of the 105 documented operations by operationId, so any
 * corner of the reference the purpose-built screens do not cover is still
 * reachable (and inspectable) from inside the app.
 */
import { Router } from 'express';
import { asyncRoute, bool, int } from '../lib/http.js';
import { call, callAll, operationNeedsAuth } from '../etsy/client.js';
import { OPERATIONS, OPERATIONS_BY_TAG, OPERATION_COUNT, ALL_SCOPES } from '../etsy/operations.generated.js';
import { getDb } from '../db/index.js';

const router = Router();

router.get('/operations', asyncRoute(async (req, res) => {
  const tag = req.query.tag;
  const search = String(req.query.search ?? '').toLowerCase();
  let ops = Object.values(OPERATIONS);
  if (tag) ops = ops.filter((o) => o.tag === tag);
  if (search) ops = ops.filter((o) => o.operationId.toLowerCase().includes(search) || o.path.toLowerCase().includes(search) || (o.summary ?? '').toLowerCase().includes(search));
  res.json({
    count: OPERATION_COUNT,
    matched: ops.length,
    tags: Object.keys(OPERATIONS_BY_TAG).sort(),
    scopes: ALL_SCOPES,
    operations: ops.map((o) => ({
      operationId: o.operationId, method: o.method, path: o.path, tag: o.tag,
      summary: o.summary, scopes: o.scopes, needsAuth: operationNeedsAuth(o),
      restricted: o.restricted,
      pathParams: o.pathParams,
      query: o.query.map((q) => ({ name: q.name, type: q.type, enum: q.enum, required: q.required, default: q.default })),
      body: o.body ? { kind: o.body.kind, required: o.body.required, props: o.body.props } : null,
    })),
  });
}));

router.get('/operations/:operationId', asyncRoute(async (req, res) => {
  const op = OPERATIONS[req.params.operationId];
  if (!op) return res.status(404).json({ error: `Unknown operation "${req.params.operationId}"` });
  res.json(op);
}));

router.get('/coverage', asyncRoute(async (req, res) => {
  const db = getDb();
  const called = new Set(db.prepare('SELECT DISTINCT operation_id FROM api_calls WHERE operation_id IS NOT NULL').all().map((r) => r.operation_id));
  res.json({
    total: OPERATION_COUNT,
    everCalled: called.size,
    byTag: Object.fromEntries(Object.entries(OPERATIONS_BY_TAG).map(([tag, list]) => [tag, {
      total: list.length, called: list.filter((id) => called.has(id)).length,
    }])),
  });
}));

/** Invoke any operation. Path/query/body args come from the request body. */
router.post('/call/:operationId', asyncRoute(async (req, res) => {
  const { operationId } = req.params;
  if (!OPERATIONS[operationId]) return res.status(404).json({ error: `Unknown operation "${operationId}"` });
  const args = req.body?.args ?? req.body ?? {};
  const result = bool(req.query.all)
    ? { results: await callAll(operationId, args, { max: int(req.query.max, 500) }) }
    : await call(operationId, args, { body: req.body?.body });
  res.json(result);
}));

export default router;
