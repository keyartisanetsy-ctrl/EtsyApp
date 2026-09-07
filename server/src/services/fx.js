/**
 * Daily exchange rates, kept for the last few months so every order can be
 * valued at the rate of the day it came in - not at today's rate.
 *
 * Rates come from frankfurter.dev (European Central Bank reference rates, free,
 * no key). The ECB publishes on business days only, so a Saturday order has no
 * rate of its own; every lookup therefore falls back to the most recent
 * published day at or before the date asked for, which is also how an
 * accountant would do it.
 *
 * Everything is stored as "1 USD = <rate> <quote>", and any other pair is
 * derived from that, so one fetch covers every currency combination.
 */
import { getDb } from '../db/index.js';
import { outboundFetch } from '../lib/outbound.js';
import { readSetting } from './settings.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('fx');

const API = 'https://api.frankfurter.dev/v1';
export const BASE = 'USD';

/** Currencies worth having on hand: Etsy payout currencies plus the yuan. */
export const TRACKED = ['CNY', 'TRY', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'PLN', 'NOK', 'DKK'];

const iso = (d) => d.toISOString().slice(0, 10);
const dayString = (value) => {
  if (!value) return iso(new Date());
  if (typeof value === 'number') return iso(new Date(value * 1000));
  if (value instanceof Date) return iso(value);
  return String(value).slice(0, 10);
};

export const historyDays = () => Math.max(7, Number(readSetting('fx.history_days')) || 95);

// ------------------------------------------------------------------ storage

function upsert(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO fx_rates (day, base, quote, rate, source, fetched_at)
    VALUES (?,?,?,?,?, datetime('now'))
    ON CONFLICT(day, base, quote) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at`);
  const run = db.transaction ? db.transaction((list) => { for (const r of list) stmt.run(...r); }) : null;
  if (run) run(rows);
  else for (const r of rows) stmt.run(...r);
}

/**
 * Pull the daily series and store it. Called on a schedule and whenever the
 * newest stored day is behind.
 */
export async function refreshRates({ days = historyDays(), symbols = TRACKED } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const url = `${API}/${iso(start)}..${iso(end)}?base=${BASE}&symbols=${symbols.join(',')}`;

  let payload;
  try {
    const res = await outboundFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    log.warn(`could not refresh rates: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const rows = [];
  for (const [day, quotes] of Object.entries(payload.rates ?? {})) {
    for (const [quote, rate] of Object.entries(quotes)) {
      if (Number.isFinite(rate)) rows.push([day, BASE, quote, rate, 'frankfurter/ECB']);
    }
  }
  if (!rows.length) return { ok: false, error: 'no rates returned' };

  upsert(rows);
  const summary = { ok: true, days: Object.keys(payload.rates).length, pairs: rows.length, newest: latestDay() };
  log.info(`rates updated: ${summary.days} days, newest ${summary.newest}`);
  return summary;
}

export function latestDay() {
  return getDb().prepare('SELECT MAX(day) AS d FROM fx_rates').get()?.d ?? null;
}

export function coverage() {
  const row = getDb().prepare('SELECT MIN(day) AS from_day, MAX(day) AS to_day, COUNT(DISTINCT day) AS days FROM fx_rates').get();
  return { from: row?.from_day ?? null, to: row?.to_day ?? null, days: row?.days ?? 0 };
}

/** Make sure we have something usable; refresh when the newest day is stale. */
export async function ensureRates() {
  const newest = latestDay();
  if (newest) {
    const ageDays = (Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000;
    // The ECB skips weekends and holidays, so only chase it after a few days.
    if (ageDays < 3.5) return { ok: true, cached: true, newest };
  }
  return refreshRates();
}

// ------------------------------------------------------------------ lookups

/**
 * "1 USD = ? quote" on that day, or on the most recent published day before it.
 * Returns null when we simply have no data that old.
 */
function usdRateOn(day, quote) {
  if (quote === BASE) return { rate: 1, day };
  const row = getDb().prepare(`
    SELECT rate, day FROM fx_rates
    WHERE base = ? AND quote = ? AND day <= ?
    ORDER BY day DESC LIMIT 1`).get(BASE, quote, day);
  if (row) return { rate: row.rate, day: row.day };

  // Older than anything stored: fall back to the earliest day we do have,
  // which is still far better than refusing to convert.
  const first = getDb().prepare(`
    SELECT rate, day FROM fx_rates WHERE base = ? AND quote = ? ORDER BY day ASC LIMIT 1`).get(BASE, quote);
  return first ? { rate: first.rate, day: first.day } : null;
}

/**
 * How much of `to` one unit of `from` was worth on `day`.
 * rateOn('2026-09-07', 'CNY', 'USD') -> 0.149
 */
export function rateOn(day, from, to) {
  const d = dayString(day);
  const a = String(from || '').toUpperCase();
  const b = String(to || '').toUpperCase();
  if (!a || !b) return null;
  if (a === b) return 1;

  const fromUsd = usdRateOn(d, a);
  const toUsd = usdRateOn(d, b);
  if (!fromUsd || !toUsd || !fromUsd.rate) return null;
  // 1 A = (1/USD→A) USD = (USD→B / USD→A) B
  return toUsd.rate / fromUsd.rate;
}

/** The same lookup, but says which published day it actually used. */
export function rateDetail(day, from, to) {
  const d = dayString(day);
  const rate = rateOn(d, from, to);
  if (rate === null) return null;
  const used = usdRateOn(d, String(from).toUpperCase() === BASE ? String(to).toUpperCase() : String(from).toUpperCase());
  return { rate, asOf: used?.day ?? d, requested: d };
}

/** Convert an amount at the rate of a given day. Returns null if unconvertible. */
export function convert(amount, from, to, day) {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const rate = rateOn(day, from, to);
  if (rate === null) return null;
  return Math.round(n * rate * 1e6) / 1e6;
}

/** The rate table for the UI: one row per day, newest first. */
export function listRates({ quote = 'CNY', limit = 120 } = {}) {
  return getDb().prepare(`
    SELECT day, quote, rate FROM fx_rates
    WHERE base = ? AND quote = ? ORDER BY day DESC LIMIT ?`).all(BASE, String(quote).toUpperCase(), limit)
    .map((r) => ({
      day: r.day,
      quote: r.quote,
      perUsd: r.rate,          // 1 USD = r.rate quote
      inUsd: r.rate ? Math.round((1 / r.rate) * 1e6) / 1e6 : null, // 1 quote = this many USD
    }));
}

/**
 * Today's rates in one small object, for screens that show "and that is $X"
 * next to a price. Carried forward from the last published day, so a Sunday
 * still answers.
 */
export function latest({ symbols = TRACKED, day = null } = {}) {
  const d = dayString(day || new Date());
  const rates = {};
  const asOf = {};
  for (const quote of symbols) {
    const hit = usdRateOn(d, String(quote).toUpperCase());
    if (!hit) continue;
    rates[String(quote).toUpperCase()] = hit.rate;       // 1 USD = rate quote
    asOf[String(quote).toUpperCase()] = hit.day;
  }
  rates.USD = 1;
  return { base: BASE, day: d, rates, asOf, newest: latestDay() };
}
