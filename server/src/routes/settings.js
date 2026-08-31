import { Router } from 'express';
import { asyncRoute, required } from '../lib/http.js';
import { listSettings, writeSetting, readSetting, SETTING_DEFS } from '../services/settings.js';
import { providerStatus } from '../services/ai/index.js';
import { getDb } from '../db/index.js';
import config from '../config.js';

const router = Router();

router.get('/', asyncRoute(async (req, res) => {
  res.json({
    settings: listSettings(),
    ai: providerStatus(),
    paths: { data: config.dataDir, exports: config.exportDir, uploads: config.uploadDir, db: config.dbFile },
  });
}));

router.put('/', asyncRoute(async (req, res) => {
  const updates = req.body ?? {};
  const applied = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!SETTING_DEFS[key]) continue;
    writeSetting(key, value);
    applied.push(key);
  }
  res.json({ applied, settings: listSettings() });
}));

router.put('/:key', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['value']);
  res.json({ key: req.params.key, value: writeSetting(req.params.key, req.body.value) });
}));

router.get('/audit', asyncRoute(async (req, res) => {
  res.json(getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
}));

router.get('/api-calls', asyncRoute(async (req, res) => {
  const db = getDb();
  res.json({
    recent: db.prepare('SELECT * FROM api_calls ORDER BY id DESC LIMIT 100').all(),
    last24h: db.prepare("SELECT COUNT(*) AS c FROM api_calls WHERE ts > datetime('now','-1 day')").get().c,
    errors24h: db.prepare("SELECT COUNT(*) AS c FROM api_calls WHERE ts > datetime('now','-1 day') AND status >= 400").get().c,
  });
}));

export default router;
