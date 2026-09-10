/**
 * Tracking board: bulk tracking capture, carrier polling, and the
 * "nothing has moved in N days" alert the shop runs on.
 */
import crypto from 'node:crypto';
import { call } from '../../etsy/client.js';
import { requireShopId, activeShopId } from '../../etsy/shop.js';
import { getDb, json, audit } from '../../db/index.js';
import { readSetting, getStaleDays, trackingUrl, isTruthy } from '../settings.js';
import { badRequest } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { STATUS, STATUS_LABELS, TERMINAL } from './status.js';
import * as yuntrack from './yuntrack.js';
import * as yuntrackBrowser from './yuntrack-browser.js';
import { run, parseJsonish } from '../ai/index.js';
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
/** An order id is a long run of digits; the order code is 26-0709-01. */
const looksLikeOrderId = (t) => /^#?\d{6,}$/.test(String(t).trim());
const looksLikeOrderCode = (t) => /^\d{2}-\d{4}-\d{1,3}$/.test(String(t).trim());
const looksLikeTracking = (t) => /^[A-Za-z0-9-]{6,40}$/.test(String(t).trim()) && /[A-Za-z]/.test(String(t));

/** Turn an order code (26-0709-01) back into the receipt it belongs to. */
function receiptForCode(code) {
  const row = getDb().prepare(
    'SELECT receipt_id FROM order_codes WHERE shop_id IS ? AND code = ?',
  ).get(activeShopId(), String(code).trim());
  return row?.receipt_id ?? null;
}

/**
 * Read a pasted block of tracking numbers.
 *
 * People paste from all sorts of places, so this is deliberately forgiving:
 *
 *   3799463891  YT2607600700845852            order id, then tracking
 *   #3799463891, YT2607600700845852           with the hash and a comma
 *   YT2607600700845852  3799463891            the other way round
 *   26-0709-01  YT2607600700845852            your own order code
 *   3799463891  YT26076007  Yun Express       with a carrier name that has a space in it
 *
 * Anything it cannot read comes back in `errors` with the line and the reason,
 * rather than being dropped quietly - a tracking number that never arrives is
 * worse than one that is refused loudly.
 */
export function parseTrackingInput(text) {
  const rows = [];
  const errors = [];
  const seen = new Map();
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const [i, line] of lines.entries()) {
    if (/^(receipt|order|sipari)[\s_-]*(id|no|number|kod)?\b/i.test(line)
        && !/\d{6,}/.test(line)) continue; // header row
    const parts = line.split(/[,;\t]|\s{2,}| +/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line: i + 1, text: line, reason: 'Need an order (id or code) and a tracking number' });
      continue;
    }

    // Work out which column is which rather than insisting on an order.
    let idPart = parts[0];
    let codePart = parts[1];
    let rest = parts.slice(2);
    if (!looksLikeOrderId(idPart) && !looksLikeOrderCode(idPart)
        && (looksLikeOrderId(codePart) || looksLikeOrderCode(codePart))) {
      [idPart, codePart] = [codePart, idPart];
    }

    let receiptId = null;
    if (looksLikeOrderCode(idPart)) {
      receiptId = receiptForCode(idPart);
      if (!receiptId) {
        errors.push({ line: i + 1, text: line, reason: `No order here carries the code ${idPart}` });
        continue;
      }
    } else {
      receiptId = Number(String(idPart).replace(/\D/g, ''));
    }

    const trackingCode = String(codePart).trim();
    if (!receiptId) { errors.push({ line: i + 1, text: line, reason: 'Could not read an order id' }); continue; }
    if (!/^[A-Za-z0-9-]{6,40}$/.test(trackingCode)) {
      errors.push({ line: i + 1, text: line, reason: `"${trackingCode}" does not look like a tracking number` });
      continue;
    }

    const upper = trackingCode.toUpperCase();
    if (seen.has(upper)) {
      errors.push({ line: i + 1, text: line, reason: `${upper} is already on line ${seen.get(upper)} of this paste` });
      continue;
    }
    seen.set(upper, i + 1);

    rows.push({
      receiptId,
      trackingCode: upper,
      // Whatever is left is the carrier, spaces and all.
      carrierName: rest.length ? rest.join(' ') : null,
    });
  }
  return { rows, errors };
}

/** Record tracking locally and (optionally) push it to Etsy, which also
 *  marks the receipt shipped and emails the buyer. */
/**
 * Which numbers can be assumed to be moving the moment they are added.
 *
 * A YunExpress code is only issued when the parcel is handed over, so treating
 * it as "pre-shipped" until a scan arrives just hides real orders. The prefixes
 * are a setting, since another courier may behave the same way.
 */
export function startsAsInTransit(code) {
  const prefixes = (readSetting('tracking.in_transit_prefixes') || 'YT')
    .split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
  const upper = String(code || '').toUpperCase();
  return prefixes.some((p) => upper.startsWith(p));
}

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
      const shopIdForEntry = activeShopId();
      db.prepare(`INSERT INTO shipments (shop_id, receipt_id, tracking_code, carrier_name, note_to_buyer, send_bcc)
                  VALUES (?,?,?,?,?,?)
                  ON CONFLICT(receipt_id, tracking_code) DO UPDATE SET carrier_name = excluded.carrier_name`)
        .run(shopIdForEntry, entry.receiptId, entry.trackingCode, carrier, noteToBuyer || null, sendBcc ? 1 : 0);

      // A YunExpress number (YT...) only exists once the parcel is with them,
      // so it starts in transit rather than waiting for the first scan. Other
      // carriers stay pre-shipped until something actually scans.
      const startingStatus = startsAsInTransit(entry.trackingCode) ? STATUS.IN_TRANSIT : STATUS.PRE_SHIPPED;
      db.prepare(`INSERT INTO tracking (shop_id, tracking_code, receipt_id, carrier_name, provider, status)
                  VALUES (?,?,?,?,?,?)
                  ON CONFLICT(shop_id, tracking_code) DO UPDATE SET receipt_id = excluded.receipt_id,
                    carrier_name = COALESCE(excluded.carrier_name, tracking.carrier_name)`)
        .run(shopIdForEntry, entry.trackingCode, entry.receiptId, carrier,
          readSetting('tracking.provider'), startingStatus);

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
  const shopId = activeShopId();
  const existing = db.prepare('SELECT * FROM tracking WHERE shop_id IS ? AND tracking_code = ?').get(shopId, code);

  const insertEvent = db.prepare(`INSERT OR IGNORE INTO tracking_events
    (shop_id, tracking_code, event_at, description, location, status_hint, fingerprint) VALUES (?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const e of parcel.events || []) {
      insertEvent.run(shopId, code, e.at ?? null, e.description ?? '', e.location ?? '', e.statusHint ?? null, fingerprint(e));
    }
  })();

  const latest = db.prepare('SELECT event_at, description, location FROM tracking_events WHERE shop_id IS ? AND tracking_code = ? ORDER BY event_at DESC LIMIT 1').get(shopId, code);
  const eventCount = db.prepare('SELECT COUNT(*) AS c FROM tracking_events WHERE shop_id IS ? AND tracking_code = ?').get(shopId, code).c;

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
    INSERT INTO tracking (shop_id, tracking_code, receipt_id, carrier_name, provider, status, status_detail,
      origin_country, destination_country, last_event_at, last_event_text, last_event_location,
      event_count, days_since_move, is_stale, alert_reason, delivered_at, last_checked_at, check_error, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),NULL,?)
    ON CONFLICT(shop_id, tracking_code) DO UPDATE SET
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
    .run(shopId, code, existing?.receipt_id ?? null, existing?.carrier_name ?? null,
      parcel.manual ? (existing?.provider ?? 'manual') : readSetting('tracking.provider'),
      status, parcel.statusDetail ?? '', parcel.originCountry ?? null, parcel.destinationCountry ?? null,
      lastEventAt, latest?.description ?? existing?.last_event_text ?? null, latest?.location ?? null,
      eventCount, daysSinceMove, isStale ? 1 : 0, alertReason,
      status === STATUS.DELIVERED ? (lastEventAt ?? new Date().toISOString()) : null,
      json(parcel.raw));

  return { code, status, daysSinceMove, isStale, alertReason, eventCount };
}

function recordCheckError(code, message) {
  getDb().prepare("UPDATE tracking SET last_checked_at = datetime('now'), check_error = ? WHERE shop_id IS ? AND tracking_code = ?")
    .run(message, activeShopId(), code);
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
                  WHERE shop_id IS ? AND (? = 1 OR status NOT IN ('delivered','returned'))
                  ORDER BY COALESCE(last_checked_at, '1970') ASC`)
        .all(activeShopId(), includeDelivered ? 1 : 0).map((r) => r.tracking_code);

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
  const rows = db.prepare("SELECT shop_id, tracking_code, status, last_event_at, first_seen_at FROM tracking WHERE status NOT IN ('delivered','returned')").all();
  // Staleness is pure arithmetic and shop-independent, so this runs across
  // every connected shop's parcels regardless of which one is active. The
  // update still matches on (shop_id, tracking_code) -- not tracking_code
  // alone -- because two shops can share a carrier-assigned number, and each
  // occurrence's own last_event_at must drive its own row.
  const upd = db.prepare('UPDATE tracking SET days_since_move = ?, is_stale = ?, alert_reason = ? WHERE shop_id IS ? AND tracking_code = ?');
  db.transaction(() => {
    for (const r of rows) {
      const anchor = r.last_event_at ? new Date(r.last_event_at).getTime() : new Date(`${r.first_seen_at}Z`).getTime();
      const days = Math.floor((Date.now() - anchor) / DAY_MS);
      const stale = days >= staleDays;
      upd.run(days, stale ? 1 : 0,
        stale ? (r.last_event_at ? `No movement for ${days} days` : `No carrier scan after ${days} days`) : '',
        r.shop_id, r.tracking_code);
    }
  })();
  return rows.length;
}

/** Manual override for when the carrier feed is unusable. */
/**
 * What this parcel cost you to send. Kept next to the tracking number because
 * that is where the number arrives from the courier, and pushed on to Airtable
 * from there. Pass cost = null to clear it.
 */
export function setShippingCost(code, { cost, currency } = {}) {
  const db = getDb();
  const shopId = activeShopId();
  const amount = cost === null || cost === undefined || cost === '' ? null : Number(cost);
  if (amount !== null && !Number.isFinite(amount)) throw badRequest(`"${cost}" is not a number.`);
  const ccy = (currency || readSetting('orders.shipping_cost_currency') || 'CNY').toUpperCase();

  const done = db.prepare(`UPDATE tracking SET shipping_cost = ?, shipping_cost_currency = ?
                           WHERE shop_id IS ? AND tracking_code = ?`)
    .run(amount, amount === null ? null : ccy, shopId, code);
  if (!done.changes) {
    // The number may not be on the board yet; keep the cost rather than lose it.
    db.prepare(`INSERT INTO tracking (shop_id, tracking_code, provider, status, shipping_cost, shipping_cost_currency)
                VALUES (?,?, 'manual', 'pre_shipped', ?, ?)
                ON CONFLICT(shop_id, tracking_code) DO UPDATE SET
                  shipping_cost = excluded.shipping_cost, shipping_cost_currency = excluded.shipping_cost_currency`)
      .run(shopId, code, amount, amount === null ? null : ccy);
  }
  audit('tracking.cost', { entity: 'tracking', entityId: code, detail: { cost: amount, currency: ccy } });
  return board({ codes: [code] }).rows[0] ?? null;
}

/** Set the cost on many parcels at once, e.g. after a courier invoice. */
export function setShippingCosts(entries = []) {
  const out = [];
  for (const e of entries) {
    try {
      setShippingCost(e.trackingCode ?? e.code, { cost: e.cost, currency: e.currency });
      out.push({ code: e.trackingCode ?? e.code, ok: true });
    } catch (err) {
      out.push({ code: e.trackingCode ?? e.code, ok: false, error: err.message });
    }
  }
  return { updated: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length, results: out };
}

export function setManualStatus(code, { status, note = '' }) {
  if (!Object.values(STATUS).includes(status)) throw badRequest(`Unknown status "${status}"`);
  const db = getDb();
  const shopId = activeShopId();
  db.prepare(`INSERT INTO tracking (shop_id, tracking_code, status, status_detail, provider, last_event_at, last_event_text, last_checked_at)
              VALUES (?,?,?,?,'manual',datetime('now'),?,datetime('now'))
              ON CONFLICT(shop_id, tracking_code) DO UPDATE SET status = excluded.status,
                status_detail = excluded.status_detail, provider = 'manual',
                last_event_at = datetime('now'), last_event_text = excluded.last_event_text,
                last_checked_at = datetime('now'), is_stale = 0, alert_reason = '', alert_ack = 0`)
    .run(shopId, code, status, note, note || `Set to ${STATUS_LABELS[status]} manually`);
  db.prepare(`INSERT OR IGNORE INTO tracking_events (shop_id, tracking_code, event_at, description, location, status_hint, fingerprint)
              VALUES (?, ?, datetime('now'), ?, '', ?, ?)`)
    .run(shopId, code, note || `Manually set to ${STATUS_LABELS[status]}`, status, fingerprint({ at: Date.now(), description: note, location: '' }));
  audit('tracking.manual', { entity: 'tracking', entityId: code, detail: { status, note } });
  return board({ codes: [code] }).rows[0] ?? null;
}

export const acknowledgeAlert = (code, ack = true) =>
  getDb().prepare('UPDATE tracking SET alert_ack = ? WHERE shop_id IS ? AND tracking_code = ?').run(ack ? 1 : 0, activeShopId(), code);

// ------------------------------------------------------------------- board

/** The tracking board: one row per parcel with its order context. */
export function board({ status = '', alertsOnly = false, search = '', codes = null, limit = 500, offset = 0 } = {}) {
  const db = getDb();
  const where = ['t.shop_id IS ?'];
  const params = [activeShopId()];

  if (status) { where.push('t.status = ?'); params.push(status); }
  if (alertsOnly) where.push("(t.is_stale = 1 OR t.status IN ('exception','not_found','returned')) AND t.alert_ack = 0");
  if (codes?.length) { where.push(`t.tracking_code IN (${codes.map(() => '?').join(',')})`); params.push(...codes); }
  if (search) {
    where.push('(t.tracking_code LIKE ? OR CAST(t.receipt_id AS TEXT) LIKE ? OR r.name LIKE ?)');
    const like = `%${search}%`; params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

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
      shippingCost: r.shipping_cost ?? null,
      shippingCostCurrency: r.shipping_cost_currency ?? null,
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
  getDb().prepare('SELECT event_at, description, location, status_hint FROM tracking_events WHERE shop_id IS ? AND tracking_code = ? ORDER BY event_at DESC')
    .all(activeShopId(), code);

export function trackingSummary() {
  const db = getDb();
  const shop = activeShopId();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM tracking WHERE shop_id IS ? GROUP BY status').all(shop);
  const alerts = db.prepare(`SELECT COUNT(*) AS c FROM tracking WHERE shop_id IS ?
    AND (is_stale = 1 OR status IN ('exception','not_found','returned')) AND alert_ack = 0`).get(shop).c;
  return {
    total: db.prepare('SELECT COUNT(*) AS c FROM tracking WHERE shop_id IS ?').get(shop).c,
    alerts,
    staleDays: getStaleDays(),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
    labels: STATUS_LABELS,
  };
}

// --------------------------------------------------------- AI status reading

const STATUS_SYSTEM = `You read parcel tracking histories and say where each parcel has got to.

You get a list of parcels. Each has its tracking number, the status we currently hold,
how many days since it last moved, and its recent events in the carrier's own words -
which may be in English, Chinese, Turkish or anything else.

Decide the true status of each from its events. Use exactly one of:
pre_shipped, in_transit, out_for_delivery, pickup_waiting, delivered, exception, returned, expired, not_found

Be careful with these, because they are the ones that get read wrong:
- "delivered" needs an actual delivery or signature event. A parcel merely "out for delivery"
  or "arrived at destination" has NOT been delivered.
- A parcel sitting at a pickup point is pickup_waiting, not delivered.
- Customs holds, failed attempts and address problems are exception.
- A parcel with no movement for a long time and no delivery event is still in_transit;
  say so in the note rather than inventing a delivery.

Reply with JSON only, and only for parcels whose status should change:
{"parcels":[{"code":"YT123","status":"delivered","confidence":0.0-1.0,"note":"why, in one short line"}]}`;

/**
 * Ask the AI to read the tracking histories and say which parcels have arrived.
 *
 * The pattern rules in status.js handle the ordinary wording. This is for the
 * rest: a Chinese courier's phrasing, a carrier that says "handed to recipient"
 * instead of "delivered", a history where the useful line is three events back.
 *
 * Nothing is written unless `apply` is set, and even then a low-confidence
 * answer is left alone - a parcel wrongly marked delivered stops it being
 * chased, which is the one mistake here that costs money.
 */
export async function readStatusesWithAi({ codes = [], apply = false, minConfidence = 0.7,
  provider, runner = run } = {}) {
  const db = getDb();
  const shopId = activeShopId();
  const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean);
  if (!list.length) throw badRequest('Pick the tracking numbers to read first.');

  const holes = list.map(() => '?').join(',');
  const parcels = db.prepare(`
    SELECT tracking_code, status, days_since_move, last_event_text, last_event_at
    FROM tracking WHERE shop_id IS ? AND tracking_code IN (${holes})`).all(shopId, ...list);

  if (!parcels.length) return { parcels: [], applied: 0, note: 'None of those tracking numbers are on the board.' };

  const context = {
    parcels: parcels.map((p) => ({
      code: p.tracking_code,
      currentStatus: p.status,
      daysSinceMove: p.days_since_move,
      events: db.prepare(`
        SELECT event_at, description, location FROM tracking_events
        WHERE shop_id IS ? AND tracking_code = ? ORDER BY event_at DESC LIMIT 12`)
        .all(shopId, p.tracking_code)
        .map((e) => `${e.event_at} ${e.description}${e.location ? ` (${e.location})` : ''}`),
    })),
  };

  const result = await runner({
    kind: 'custom', provider, promptOverride: STATUS_SYSTEM, context,
    userInput: 'Read them now. JSON only.', maxTokens: 2000,
  });

  const parsed = parseJsonish(result.text);
  if (!parsed) throw badRequest('The AI did not return a usable answer. Try again, or set the status by hand.');

  const known = new Map(parcels.map((p) => [p.tracking_code.toUpperCase(), p]));
  const valid = Object.values(STATUS);
  const out = [];
  let applied = 0;

  for (const row of parsed.parcels ?? []) {
    const code = String(row.code ?? '').trim().toUpperCase();
    const parcel = known.get(code);
    // A code the AI made up, or a status outside our vocabulary, is dropped
    // rather than written.
    if (!parcel || !valid.includes(row.status)) continue;

    const confidence = Number(row.confidence);
    const sure = Number.isFinite(confidence) ? confidence : 0;
    const changed = row.status !== parcel.status;
    const willApply = apply && changed && sure >= minConfidence;

    if (willApply) {
      setManualStatus(parcel.tracking_code, {
        status: row.status,
        note: `AI: ${String(row.note ?? '').slice(0, 200)}`,
      });
      applied += 1;
    }

    out.push({
      code: parcel.tracking_code,
      was: parcel.status,
      status: row.status,
      changed,
      confidence: sure,
      note: String(row.note ?? '').slice(0, 200),
      applied: willApply,
      heldBack: apply && changed && !willApply ? `confidence ${sure} is below ${minConfidence}` : null,
    });
  }

  audit('tracking.ai_read', { detail: { asked: list.length, answered: out.length, applied } });
  return { parcels: out, applied, provider: result.provider, model: result.model, minConfidence };
}
