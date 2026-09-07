/**
 * Today's exchange rates, shared by every screen that shows a price in one
 * currency and wants to say what it is in dollars.
 *
 * Fetched once per page load and kept in module scope: half a dozen screens ask
 * for it, and asking the server six times for the same small object would be
 * silly. `refreshRates()` clears it after a manual refresh on the Airtable page.
 */
import { useEffect, useState } from 'react';
import api from './api.js';

let cache = null;      // the resolved payload
let inFlight = null;   // so simultaneous mounts share one request

export function clearRateCache() { cache = null; inFlight = null; }

async function load() {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = api.get('/airtable/rates/latest')
      .then((r) => { cache = r; inFlight = null; return r; })
      .catch((err) => { inFlight = null; throw err; });
  }
  return inFlight;
}

/**
 * `{ rates, day, convert(amount, from, to) }`.
 * `convert` returns null when we have no rate, so the caller can stay quiet
 * rather than print a wrong number.
 */
export function useRates() {
  const [data, setData] = useState(cache);

  useEffect(() => {
    let alive = true;
    if (!cache) load().then((r) => { if (alive) setData(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const table = data?.rates ?? null;

  const convert = (amount, from, to = 'USD') => {
    const n = Number(amount);
    if (!Number.isFinite(n) || !table) return null;
    const a = String(from || '').toUpperCase();
    const b = String(to || '').toUpperCase();
    if (!a || !b) return null;
    if (a === b) return n;
    const perUsdFrom = table[a];
    const perUsdTo = table[b];
    if (!perUsdFrom || !perUsdTo) return null;
    // 1 A = (1/perUsdFrom) USD = perUsdTo/perUsdFrom of B
    return Math.round(((n * perUsdTo) / perUsdFrom) * 100) / 100;
  };

  return { rates: table, day: data?.day ?? null, asOf: data?.asOf ?? null, convert, ready: !!table };
}

/** The small grey "≈ $12.40" line. Renders nothing when there is no rate. */
export function useUsd(amount, currency) {
  const { convert, day } = useRates();
  if (currency && String(currency).toUpperCase() === 'USD') return null;
  const usd = convert(amount, currency, 'USD');
  return usd === null ? null : { usd, day };
}
