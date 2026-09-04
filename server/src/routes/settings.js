import { Router } from 'express';
import { asyncRoute, required } from '../lib/http.js';
import { listSettings, writeSetting, readSetting, SETTING_DEFS } from '../services/settings.js';
import { providerStatus } from '../services/ai/index.js';
import { getDb } from '../db/index.js';
import config from '../config.js';
import { DESTINATIONS, USER_AGENT } from '../lib/outbound.js';

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

/**
 * What leaves this machine, and what does not. Rendered verbatim in Settings
 * so the claims are inspectable rather than a marketing promise.
 */
router.get('/privacy', asyncRoute(async (req, res) => {
  const proxy = readSetting('privacy.proxy_url');
  res.json({
    userAgent: USER_AGENT,
    headersSent: ['x-api-key (Etsy)', 'Authorization (Etsy)', 'User-Agent', 'Accept', 'Accept-Encoding', 'Content-Type'],
    headersStripped: ['Accept-Language', 'Sec-Fetch-*', 'Origin', 'Referer'],
    neverSent: [
      'Your name, email, or Etsy login',
      'Your computer name, OS, Node version or hardware',
      'Your timezone, locale or keyboard layout',
      'Your local file paths',
      'Any telemetry, analytics or crash reporting - the app contains none',
      'Anything at all to the app author or any third party not listed below',
    ],
    ipAddress: {
      hidden: !!proxy,
      note: proxy
        ? 'Outbound traffic is routed through your configured proxy, so destinations see the proxy address rather than yours.'
        : 'Your IP address is visible to any server you connect to. That is how the internet works and no application setting can change it. '
          + 'Set an outbound proxy below (or use a system-wide VPN) if you need to mask it.',
    },
    proxyConfigured: !!proxy,
    aiEnabled: /^(1|true|yes|on)$/i.test(String(readSetting('privacy.share_ai'))),
    destinations: DESTINATIONS,
    storage: {
      note: 'All shop data stays in a local SQLite file on this machine. Nothing is uploaded anywhere.',
      database: config.dbFile,
    },
  });
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
