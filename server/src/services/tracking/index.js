/**
 * Tracking board: bulk tracking capture, carrier polling, and the
 * "nothing has moved in N days" alert the shop runs on.
 */
import crypto from 'node:crypto';
import { call } from '../../etsy/client.js';
import { requireShopId } from '../../etsy/shop.js';
import { getDb, json, audit } from '../../db/index.js';
import { readSetting, getStaleDays, trackingUrl, isTruthy } from '../settings.js';
import { badRequest } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { STATUS, STATUS_LABELS, TERMINAL } from './status.js';
import * as yuntrack from './yuntrack.js';
import * as yuntrackBrowser from './yuntrack-browser.js';
import * as seventeen from './seventeentrack.js';

const log = createLogger('tracking');
export { STATUS, STATUS_LABELS };

const DAY_MS = 86_400_000;

// ------------------------------------------------------------- bulk capture

/**
 * Accepts pasted text or CSV in any of these shapes, one pair per line:
 *   1234567890, LP00432300758472
 *   1234567890  LP00432300758472  YunExpress
 *   1234567890;LP00432300758472
 * Order id may be an Etsy receipt id or an order number the shop already holds.
 */
export function parseTrackingInput(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const [i, line] of lines.entries()) {
    if (/^(receipt|order)[\s_-]*(id|number)?\b/i.test(line)) continue; // header row
    const parts = line.split(/[,;\t]|\s{2,}| +/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) { errors.push({ line: i + 1, text: line, reason: 'Need an order id and a tracking number' }); continue; }

    const receiptId = Number(String(parts[0]).replace(/\D/g, ''));
    const trackingCode = parts[1];
    if (!receiptId) { errors.push({ line: i + 1, text: line, reason: 'Could not read an order id' }); continue; }
    if (!/^[A-Za-z0-9-]{6,40}$/.test(trackingCode)) { errors.push({ line: i + 1, text: line, reason: `"${trackingCode}" does not look like a tracking number` }); continue; }

    rows.push({ receiptId, trackingCode: trackingCode.toUpperCase(), carrierName: parts[2] || null });
  }
  return { rows, errors };
}

/** Record tracking locally and (optionally) push it to Etsy, which also
 *  marks the receipt shipped and emails the buyer. */
export async function addTracking(entries, { pushToEtsy = true, noteToBuyer = '', sendBcc = false, dryRun = false } = {}) {
  const db = getDb();
  const shopId = pushToEtsy ? requireShopId() : null;
  const defaultCarrier = readSetting('orders.default_carrier');
  const results = [];

  for (const entry of entries) {
    const carrier = entry.carrierName || defaultCarrier || null;
    const record = { receiptId: entry.receiptId, trackingCode: entry.trackingCode, carrier, pushed: false };

    if (dryRun) { results.push({ ...record, status: 'dry-run' }); continue; }

    try {
      db.prepare(`INSERT INTO shipments (receipt_id, tracking_code, carrier_name, note_to_buyer, send_bcc)
                  VALUES (?,?,?,?,?)
                  ON CONFLICT(receipt_id, tracking_code) DO UPDATE SET carrier_name = excluded.carrier_name`)
        .run(entry.receiptId, entry.trackingCode, carrier, noteToBuyer || null, sendBcc ? 1 : 0);

      db.prepare(`INSERT INTO tracking (tracking_code, receipt_id, carrier_name, provider, status)
                  VALUES (?,?,?,?,'pre_shipped')
                  ON CONFLICT(tracking_code) DO UPDATE SET receipt_id = excluded.receipt_id,
                    carrier_name = COALESCE(excluded.carrier_name, tracking.carrier_name)`)
        .run(entry.trackingCode, entry.receiptId, carrier, readSetting('tracking.provider'));

      if (pushToEtsy) {
        const body = { tracking_code: entry.trackingCode };
        if (carrier) body.carrier_name = carrier;
        if (noteToBuyer) body.note_to_buyer = noteToBuyer;
        if (sendBcc) body.send_bcc = true;

        await call('createReceiptShipment', { shop_id: shopId, receipt_id: entry.receiptId }, { body });

        db.prepare(`UPDATE shipments SET pushed_to_etsy = 1, pushed_at = datetime('now'), push_error = NULL
                    WHERE receipt_id = ? AND tracking_code = ?`).run(entry.receiptId, entry.trackingCode);
        db.prepare('UPDATE receipts SET was_shipped = 1, is_shipped = 1 WHERE receipt_id = ?').run(entry.receiptId);
        record.pushed = true;
      }
      results.push({ ...record, status: 'ok' });
    } catch (err) {
      db.prepare('UPDATE shipments SET push_error = ? WHERE receipt_id = ? AND tracking_code = ?')
        .run(err.message, entry.receiptId, entry.trackingCode);
      results.push({ ...record, status: 'error', error: err.message });
    }
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  audit('tracking.add', { entity: 'shipment', status: ok === results.length ? 'ok' : 'partial', detail: { count: results.length, ok } });
  log.info(`tracking added: ${ok}/${results.length}`);
  return { total: results.length, succeeded: ok, failed: results.length - ok, results };
}

// ----------------------------------------------------------------- polling

export const PROVIDERS = ['yuntrack', 'yuntrack-browser', 'seventeentrack', 'manual'];

function providerFor(name) {
  switch (name) {
    case 'seventeentrack':
      return { name, fetch: (codes) => seventeen.fetchTracking(codes, { apiKey: readSetting('tracking.seventeentrack_key') }) };

    case 'yuntrack-browser':
      // Drives a real browser over the same parcelTracking page a person opens.
      return {
        name,
        batchSize: 8, // one page load per parcel, so keep batches small
        fetch: (codes) => yuntrackBrowser.fetchTracking(codes, {
          headless: !isTruthy(readSetting('tracking.browser_headed')),
          executablePath: readSetting('tracking.browser_path') || undefined,
        }),
      };

    case 'manual':
      return { name, fetch: async (codes) => codes.map((c) => ({ code: c, status: null, events: [], manual: true })) };

    default:
      return {
        name: 'yuntrack',
        fetch: (codes) => yuntrack.fetchTracking(codes, {
          endpoint: readSetting('tracking.api_endpoint') || `${yuntrack.API_ROOT}/Track/Query`,
        }),
      };
  }
}

const fingerprint = (e) =>
  crypto.createHash('sha1').update(`${e.at ?? ''}|${e.description ?? ''}|${e.location ?? ''}`).digest('hex');

/** Write one parcel's result, recompute movement age, and raise/clear alerts. */
export function applyParcel(parcel, { staleDays = getStaleDays() } = {}) {
  const db = getDb();
  const code = parcel.code;
  const existing = db.prepare('SELECT * FROM tracking WHERE tracking_code = ?').get(code);

  const insertEvent = db.prepare(`INSERT OR IGNORE INTO tracking_events
    (tracking_code, event_at, description, location, status_hint, fingerprint) VALUES (?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const e of parcel.events || []) {
      insertEvent.run(code, e.at ?? null, e.description ?? '', e.location ?? '', e.statusHint ?? null, fingerprint(e));
    }
  })();

  const latest = db.prepare('SELECT event_at, description, location FROM tracking_events WHERE tracking_code = ? ORDER BY event_at DESC LIMIT 1').get(code);
  const eventCount = db.prepare('SELECT COUNT(*) AS c FROM tracking_events WHERE tracking_code = ?').get(code).c;

  const status = parcel.status ?? existing?.status ?? STATUS.PRE_SHIPPED;
  const lastEventAt = latest?.event_at ?? existing?.last_event_at ?? null;

  // Age from the last movement; with no scan at all, from when we first saw it.
  const anchor = lastEventAt ? new Date(lastEventAt).getTime()
    : existing?.first_seen_at ? new Date(`${existing.first_seen_at}Z`).getTime() : Date.now();
  const daysSinceMove = Math.floor((Date.now() - anchor) / DAY_MS);

  const terminal = TERMINAL.has(status);
  const isStale = !terminal && daysSinceMove >= staleDays;

  let alertReason = '';
  if (status === STATUS.EXCEPTION) alertReason = parcel.statusDetail || 'Carrier reported an exception';
  else if (status === STATUS.NOT_FOUND && daysSinceMove >= staleDays) alertReason = `No carrier data after ${daysSinceMove} days`;
  else if (isStale) alertReason = `No movement for ${daysSinceMove} days`;

  db.prepare(`
    INSERT INTO tracking (tracking_code, receipt_id, carrier_name, provider, status, status_detail,
      origin_country, destination_country, last_event_at, last_event_text, last_event_location,
      event_count, days_since_move, is_stale, alert_reason, delivered_at, last_checked_at, check_error, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),NULL,?)
    ON CONFLICT(tracking_code) DO UPDATE SET
      status = excluded.status, status_detail = excluded.status_detail,
      origin_country = COALESCE(excluded.origin_country, tracking.origin_country),
      destination_country = COALESCE(excluded.destination_country, tracking.destination_country),
      last_event_at = excluded.last_event_at, last_event_text = excluded.last_event_text,
      last_event_location = excluded.last_event_location, event_count = excluded.event_count,
      days_since_move = excluded.days_since_move, is_stale = excluded.is_stale,
      alert_reason = excluded.alert_reason,
      delivered_at = COALESCE(tracking.delivered_at, excluded.delivered_at),
      last_checked_at = datetime('now'), check_error = NULL, raw = excluded.raw,
      -- a fresh scan after an acknowledged alert re-arms the alert
      alert_ack = CASE WHEN excluded.last_event_at IS NOT tracking.last_event_at THEN 0 ELSE tracking.alert_ack END`)
    .run(code, existing?.receipt_id ?? null, existing?.carrier_name ?? null,
      parcel.manual ? (existing?.provider ?? 'manual') : readSetting('tracking.provider'),
      status, parcel.statusDetail ?? '', parcel.originCountry ?? null, parcel.destinationCountry ?? null,
      lastEventAt, latest?.description ?? existing?.last_event_text ?? null, latest?.location ?? null,
      eventCount, daysSinceMove, isStale ? 1 : 0, alertReason,
      status === STATUS.DELIVERED ? (lastEventAt ?? new Date().toISOString()) : null,
      json(parcel.raw));

  return { code, status, daysSinceMove, isStale, alertReason, eventCount };
}

function recordCheckError(code, message) {
  getDb().prepare("UPDATE tracking SET last_checked_at = datetime('now'), check_error = ? WHERE tracking_code = ?")
    .run(message, code);
}

/**
 * Poll the carrier for the given codes (default: everything not yet finished).
 * Providers are queried in batches; a provider failure never loses local state.
 */
export async function syncTracking({ codes = null, batchSize = 30, includeDelivered = false } = {}) {
  const db = getDb();
  const list = codes?.length
    ? codes
    : db.prepare(`SELECT tracking_code FROM tracking
                  WHERE (? = 1 OR status NOT IN ('delivered','returned'))
                  ORDER BY COALESCE(last_checked_at, '1970') ASC`)
        .all(includeDelivered ? 1 : 0).map((r) => r.tracking_code);

  if (!list.length) return { checked: 0, updated: [], errors: [] };

  const provider = providerFor(readSetting('tracking.provider'));
  const size = provider.batchSize ?? batchSize;
  const updated = [];
  const errors = [];
  let blocked = null;

  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    try {
      const parcels = await provider.fetch(batch);
      for (const parcel of parcels) updated.push(applyParcel(parcel));
    } catch (err) {
      for (const code of batch) { recordCheckError(code, err.message); errors.push({ code, error: err.message }); }
      log.warn(`provider ${provider.name} failed for ${batch.length} parcels: ${err.message}`);
      // A WAF block or a missing browser will fail identically for every
      // remaining batch, so stop and report it once.
      if (err.blocked || /Playwright/i.test(err.message)) {
        blocked = err.message;
        for (const code of list.slice(i + size)) { recordCheckError(code, err.message); errors.push({ code, error: err.message }); }
        break;
      }
    }
  }

  // Recompute staleness for everything, so alerts appear even when the
  // provider is unreachable and the only signal is elapsed time.
  refreshStaleFlags();

  audit('tracking.sync', { entity: 'tracking', status: errors.length ? 'partial' : 'ok', detail: { checked: list.length, errors: errors.length } });
  return { checked: list.length, provider: provider.name, updated, errors, blocked };
}

/** Time-based alerting; independent of whether the carrier API answered. */
export function refreshStaleFlags(staleDays = getStaleDays()) {
  const db = getDb();
  const rows = db.prepare("SELECT tracking_code, status, last_event_at, first_seen_at FROM tracking WHERE status NOT IN ('delivered','returned')").all();
  const upd = db.prepare('UPDATE tracking SET days_since_move = ?, is_stale = ?, alert_reason = ? WHERE tracking_code = ?');
  db.transaction(() => {
    for (const r of rows) {
      const anchor = r.last_event_at ? new Date(r.last_event_at).getTime() : new Date(`${r.first_seen_at}Z`).getTime();
      const days = Math.floor((Date.now() - anchor) / DAY_MS);
      const stale = days >= staleDays;
      upd.run(days, stale ? 1 : 0,
        stale ? (r.last_event_at ? `No movement for ${days} days` : `No carrier scan after ${days} days`) : '',
        r.tracking_code);
    }
  })();
  return rows.length;
}

/** Manual override for when the carrier feed is unusable. */
export function setManualStatus(code, { status, note = '' }) {
  if (!Object.values(STATUS).includes(status)) throw badRequest(`Unknown status "${status}"`);
  const db = getDb();
  db.prepare(`INSERT INTO tracking (tracking_code, status, status_detail, provider, last_event_at, last_event_text, last_checked_at)
              VALUES (?,?,?,'manual',datetime('now'),?,datetime('now'))
              ON CONFLICT(tracking_code) DO UPDATE SET status = excluded.status,
                status_detail = excluded.status_detail, provider = 'manual',
                last_event_at = datetime('now'), last_event_text = excluded.last_event_text,
                last_checked_at = datetime('now'), is_stale = 0, alert_reason = '', alert_ack = 0`)
    .run(code, status, note, note || `Set to ${STATUS_LABELS[status]} manually`);
  db.prepare(`INSERT OR IGNORE INTO tracking_events (tracking_code, event_at, description, location, status_hint, fingerprint)
              VALUES (?, datetime('now'), ?, '', ?, ?)`)
    .run(code, note || `Manually set to ${STATUS_LABELS[status]}`, status, fingerprint({ at: Date.now(), description: note, location: '' }));
  audit('tracking.manual', { entity: 'tracking', entityId: code, detail: { status, note } });
  return board({ codes: [code] }).rows[0] ?? null;
}

export const acknowledgeAlert = (code, ack = true) =>
  getDb().prepare('UPDATE tracking SET alert_ack = ? WHERE tracking_code = ?').run(ack ? 1 : 0, code);

// ------------------------------------------------------------------- board

/** The tracking board: one row per parcel with its order context. */
export function board({ status = '', alertsOnly = false, search = '', codes = null, limit = 500, offset = 0 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (status) { where.push('t.status = ?'); params.push(status); }
  if (alertsOnly) where.push("(t.is_stale = 1 OR t.status IN ('exception','not_found','returned')) AND t.alert_ack = 0");
  if (codes?.length) { where.push(`t.tracking_code IN (${codes.map(() => '?').join(',')})`); params.push(...codes); }
  if (search) {
    where.push('(t.tracking_code LIKE ? OR CAST(t.receipt_id AS TEXT) LIKE ? OR r.name LIKE ?)');
    const like = `%${search}%`; params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT t.*, r.name AS buyer_name, r.country_iso, r.created_ts AS order_created_ts,
           r.grandtotal_amount, r.grandtotal_divisor, r.grandtotal_currency,
           f.is_done, f.is_flagged
    FROM tracking t
    LEFT JOIN receipts r ON r.receipt_id = t.receipt_id
    LEFT JOIN order_flags f ON f.receipt_id = t.receipt_id
    ${clause}
    ORDER BY (t.is_stale = 1 AND t.alert_ack = 0) DESC, t.days_since_move DESC, t.last_event_at DESC
    LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM tracking t
    LEFT JOIN receipts r ON r.receipt_id = t.receipt_id ${clause}`).get(...params).c;

  return {
    total, limit, offset,
    staleDays: getStaleDays(),
    rows: rows.map((r) => ({
      trackingCode: r.tracking_code,
      trackingUrl: trackingUrl(r.tracking_code),
      receiptId: r.receipt_id,
      buyerName: r.buyer_name,
      country: r.country_iso,
      carrier: r.carrier_name,
      provider: r.provider,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status] ?? r.status,
      statusDetail: r.status_detail,
      lastEventAt: r.last_event_at,
      lastEventText: r.last_event_text,
      lastEventLocation: r.last_event_location,
      eventCount: r.event_count,
      daysSinceMove: r.days_since_move,
      isStale: !!r.is_stale,
      alert: !!(r.is_stale || ['exception', 'not_found', 'returned'].includes(r.status)) && !r.alert_ack,
      alertReason: r.alert_reason,
      alertAck: !!r.alert_ack,
      deliveredAt: r.delivered_at,
      lastCheckedAt: r.last_checked_at,
      checkError: r.check_error,
      orderCreatedTs: r.order_created_ts,
      orderTotal: r.grandtotal_amount != null ? r.grandtotal_amount / (r.grandtotal_divisor || 100) : null,
      orderCurrency: r.grandtotal_currency,
      orderDone: !!r.is_done,
    })),
  };
}

export const trackingEvents = (code) =>
  getDb().prepare('SELECT event_at, description, location, status_hint FROM tracking_events WHERE tracking_code = ? ORDER BY event_at DESC').all(code);

export function trackingSummary() {
  const db = getDb();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM tracking GROUP BY status').all();
  const alerts = db.prepare("SELECT COUNT(*) AS c FROM tracking WHERE (is_stale = 1 OR status IN ('exception','not_found','returned')) AND alert_ack = 0").get().c;
  return {
    total: db.prepare('SELECT COUNT(*) AS c FROM tracking').get().c,
    alerts,
    staleDays: getStaleDays(),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
    labels: STATUS_LABELS,
  };
}
