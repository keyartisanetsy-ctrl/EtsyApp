import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { asyncRoute, int, bool, list, required } from '../lib/http.js';
import * as tracking from '../services/tracking/index.js';
import { STATUS, STATUS_LABELS } from '../services/tracking/status.js';
import { trackingUrl } from '../services/settings.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', asyncRoute(async (req, res) => {
  res.json(tracking.board({
    status: req.query.status ?? '',
    alertsOnly: bool(req.query.alertsOnly),
    search: req.query.search ?? '',
    limit: int(req.query.limit, 500),
    offset: int(req.query.offset, 0),
  }));
}));

router.get('/summary', asyncRoute(async (req, res) => res.json(tracking.trackingSummary())));

router.get('/statuses', asyncRoute(async (req, res) => {
  res.json({ statuses: Object.values(STATUS), labels: STATUS_LABELS });
}));

/** Preview a pasted block before committing it. */
router.post('/parse', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['text']);
  res.json(tracking.parseTrackingInput(req.body.text));
}));

/** Bulk add: either { text } to paste, or { entries: [...] } already parsed. */
router.post('/bulk', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  let entries = body.entries;
  let parseErrors = [];
  if (!entries) {
    required(body, ['text']);
    const parsed = tracking.parseTrackingInput(body.text);
    entries = parsed.rows;
    parseErrors = parsed.errors;
  }
  if (!entries.length) return res.status(400).json({ error: 'Nothing to add.', parseErrors });

  const result = await tracking.addTracking(entries, {
    pushToEtsy: body.pushToEtsy !== false,
    noteToBuyer: body.noteToBuyer ?? '',
    sendBcc: !!body.sendBcc,
    dryRun: !!body.dryRun,
  });
  res.json({ ...result, parseErrors });
}));

/** Same, from the filled-in .xlsx template. */
router.post('/bulk/upload', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('Attach the filled-in tracking template as "file".');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(req.file.buffer);
  const sheet = wb.worksheets[0];

  const entries = [];
  const errors = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return; // header
    const receiptId = Number(String(row.getCell(1).value ?? '').replace(/\D/g, ''));
    const codeCell = row.getCell(2).value;
    const code = String(codeCell?.text ?? codeCell ?? '').trim();
    const carrier = String(row.getCell(3).value ?? '').trim() || null;
    if (!receiptId || !code) return; // blank row, skip quietly
    if (!/^[A-Za-z0-9-]{6,40}$/.test(code)) { errors.push({ line: n, reason: `"${code}" does not look like a tracking number` }); return; }
    entries.push({ receiptId, trackingCode: code.toUpperCase(), carrierName: carrier });
  });

  if (!entries.length) return res.status(400).json({ error: 'No usable rows found in that file.', parseErrors: errors });

  const result = await tracking.addTracking(entries, {
    pushToEtsy: req.body.pushToEtsy !== 'false',
    noteToBuyer: req.body.noteToBuyer ?? '',
    sendBcc: bool(req.body.sendBcc),
  });
  res.json({ ...result, parseErrors: errors });
}));

/** Poll the carrier. Optionally only the codes given. */
router.post('/sync', asyncRoute(async (req, res) => {
  res.json(await tracking.syncTracking({
    codes: list(req.body?.codes),
    includeDelivered: bool(req.body?.includeDelivered),
  }));
}));

/**
 * Read the histories with the AI and say where the parcels really are.
 * `apply: false` (the default) only reports; nothing is written.
 */
router.post('/ai-read', asyncRoute(async (req, res) => {
  res.json(await tracking.readStatusesWithAi({
    codes: list(req.body?.codes),
    apply: bool(req.body?.apply),
    minConfidence: req.body?.minConfidence != null ? Number(req.body.minConfidence) : 0.7,
    provider: req.body?.provider,
  }));
}));

/** Mark parcels delivered (or any other status) in one go, by hand. */
router.post('/status', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['status']);
  const codes = list(req.body.codes) ?? [];
  if (!codes.length) return res.status(400).json({ error: 'Pick the tracking numbers first.' });
  const rows = codes.map((code) => tracking.setManualStatus(code, {
    status: req.body.status, note: req.body.note ?? '',
  }));
  res.json({ updated: rows.length, rows });
}));

router.post('/refresh-alerts', asyncRoute(async (req, res) => {
  res.json({ recalculated: tracking.refreshStaleFlags() });
}));

router.get('/:code', asyncRoute(async (req, res) => {
  const row = tracking.board({ codes: [req.params.code] }).rows[0];
  if (!row) return res.status(404).json({ error: `No tracking record for ${req.params.code}` });
  res.json({ ...row, events: tracking.trackingEvents(req.params.code) });
}));

router.get('/:code/events', asyncRoute(async (req, res) => res.json(tracking.trackingEvents(req.params.code))));

router.get('/:code/link', asyncRoute(async (req, res) => res.json({ url: trackingUrl(req.params.code) })));

router.post('/:code/status', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['status']);
  res.json(tracking.setManualStatus(req.params.code, { status: req.body.status, note: req.body.note ?? '' }));
}));

/** What the parcel cost you to send, typed in next to its tracking number. */
router.post('/:code/cost', asyncRoute(async (req, res) => {
  res.json(tracking.setShippingCost(req.params.code, { cost: req.body?.cost, currency: req.body?.currency }));
}));

/** The same for many parcels, e.g. straight off a courier invoice. */
router.post('/costs', asyncRoute(async (req, res) => {
  res.json(tracking.setShippingCosts(req.body?.entries ?? []));
}));

router.post('/:code/acknowledge', asyncRoute(async (req, res) => {
  tracking.acknowledgeAlert(req.params.code, req.body?.ack !== false);
  res.json({ code: req.params.code, acknowledged: req.body?.ack !== false });
}));

export default router;
