/**
 * Etsy requests: the one place that talks to Etsy on its own behalf.
 *
 * Etsy gives this app a fixed number of requests a day, and a bug or a busy day used to spend all of it in the
 * background. So nothing is sent to Etsy unless you ask for it: every kind of request lives here as a button
 * ("Fetch new orders", "Refresh listings"...), it runs for EVERY connected shop in one go, and you decide which ones
 * sit on the dashboard (starred) and which - if any - repeat by themselves, and how often. All repeating is off
 * until you switch it on. A daily safety limit in the Etsy client (see etsy/client.js) keeps even your own clicks
 * from using up Etsy's whole allowance.
 */
import { getSetting, setSetting, audit } from '../db/index.js';
import { listAccounts, withShop, etsyCooldown, etsyUsage, DEFAULT_DAILY_CAP } from '../etsy/client.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as sync from './sync.js';
import * as drafts from './drafts.js';

const log = createLogger('etsy-requests');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * `cost`: roughly how many requests one run spends per shop (a guide for the page, not a promise).
 * `perShop`: run once for every connected shop, each inside that shop's own context.
 * `heavy`: expensive enough to ask "are you sure" first.
 * `minMinutes`: the shortest gap allowed when it is set to repeat by itself.
 */
export const REQUESTS = [
  {
    id: 'orders', group: 'Orders', label: 'Fetch new orders', perShop: true, cost: '1-3 per shop', minMinutes: 5, defaultMinutes: 15,
    note: 'New and changed orders since the last time, for every shop.',
    run: async () => { const r = await sync.syncReceipts({}); return `${n(r?.receipts)} order(s) updated`; },
  },
  {
    id: 'orders_deep', group: 'Orders', label: 'Re-read the last 90 days of orders', perShop: true, cost: '5-30 per shop', heavy: true, minMinutes: 720, defaultMinutes: 1440,
    note: 'Everything of the last 90 days again - use after a gap or if something looks missing.',
    run: async () => { const r = await sync.syncReceipts({ sinceDays: 90 }); return `${n(r?.receipts)} order(s) read`; },
  },
  {
    id: 'ledger', group: 'Money', label: 'Fetch payment ledger', perShop: true, cost: '2-5 per shop', minMinutes: 30, defaultMinutes: 120,
    note: 'What Etsy actually paid out per order, fees and Etsy Ads.',
    run: async () => { const r = await sync.syncLedgerEntries({}); return `${n(r?.entries)} ledger entries`; },
  },
  {
    id: 'listings', group: 'Listings', label: 'Refresh listings (what changed)', perShop: true, cost: '3-10 per shop', minMinutes: 60, defaultMinutes: 360,
    note: 'Every listing is read once; variations are only re-read for listings that changed (and all of them once a day).',
    run: async () => { const r = await sync.syncListings({ auto: true }); return `${r.listings} listings, ${r.products} variations${r.skippedUnchanged ? `, ${r.skippedUnchanged} unchanged left alone` : ''}`; },
  },
  {
    id: 'listings_full', group: 'Listings', label: 'Re-read every listing and variation', perShop: true, cost: '2 per listing', heavy: true, minMinutes: 1440, defaultMinutes: 1440,
    note: 'Slow and expensive: two requests for every single listing of every shop.',
    run: async () => { const r = await sync.syncAll({}); return `${r.listings.listings} listings, ${r.listings.products} variations`; },
  },
  {
    id: 'sections', group: 'Listings', label: 'Fetch shop sections', perShop: true, cost: '1 per shop', minMinutes: 60, defaultMinutes: 1440,
    note: 'The section names of each shop.',
    run: async () => { const r = await sync.syncShopSections(); return `${n(r?.sections ?? r?.count ?? (Array.isArray(r) ? r.length : 0))} section(s)`; },
  },
  {
    id: 'drafts', group: 'Drafts', label: 'Get drafts from Etsy', perShop: true, cost: '1-3 per shop', minMinutes: 30, defaultMinutes: 360,
    note: 'Drafts you started on Etsy, brought to the Draft desk.',
    run: async () => { const r = await drafts.pullFromEtsy({}); return r?.note ?? `${n(r?.added)} new draft(s)`; },
  },
  {
    id: 'finish', group: 'Drafts', label: 'Finish pictures and tags that did not reach Etsy', perShop: false, cost: '1-5 per draft', minMinutes: 15, defaultMinutes: 30,
    note: 'Sends what a draft still owes Etsy (pictures, tags) - only does something when a send was cut short.',
    run: async () => { await drafts.finishAllPending(); return 'checked'; },
  },
];
const byId = new Map(REQUESTS.map((r) => [r.id, r]));

// ---------------------------------------------------------------- settings

const readJson = (key, fallback) => { try { return JSON.parse(getSetting(key, '') || ''); } catch { return fallback; } };
const stars = () => new Set(readJson('etsyreq.stars', ['orders']));
const autos = () => readJson('etsyreq.auto', {});
const lasts = () => readJson('etsyreq.last', {});

export function setStar(id, on) {
  if (!byId.has(id)) throw notFound('Unknown request.');
  const s = stars();
  if (on) s.add(id); else s.delete(id);
  setSetting('etsyreq.stars', JSON.stringify([...s]));
  return [...s];
}

export function setAuto(id, { enabled, minutes } = {}) {
  const def = byId.get(id);
  if (!def) throw notFound('Unknown request.');
  const a = autos();
  const mins = Math.max(def.minMinutes, Math.round(Number(minutes ?? a[id]?.minutes ?? def.defaultMinutes)) || def.defaultMinutes);
  a[id] = { enabled: !!enabled, minutes: mins };
  setSetting('etsyreq.auto', JSON.stringify(a));
  audit('etsyreq.auto', { detail: { id, ...a[id] } });
  return a[id];
}

export function setDailyCap(cap) {
  const v = Math.round(Number(cap));
  if (!Number.isFinite(v) || v < 100 || v > 20000) throw badRequest('The daily limit is a number from 100 to 20,000.');
  setSetting('etsy.daily_cap', String(v));
  return v;
}

const remember = (id, entry) => { const l = lasts(); l[id] = entry; setSetting('etsyreq.last', JSON.stringify(l)); };

// ------------------------------------------------------------------- state

/** Everything the page and the dashboard need: the requests, what is starred / automatic, how each last went, usage. */
export function overview() {
  const st = stars(); const au = autos(); const la = lasts();
  const usage = etsyUsage();
  return {
    usage: { ...usage, defaultCap: DEFAULT_DAILY_CAP, left: Math.max(0, usage.cap - usage.today) },
    shops: listAccounts().map((a) => ({ shopId: a.shopId, shopName: a.shopName })),
    requests: REQUESTS.map((r) => ({
      id: r.id, group: r.group, label: r.label, note: r.note, cost: r.cost, heavy: !!r.heavy, perShop: r.perShop,
      minMinutes: r.minMinutes, starred: st.has(r.id),
      auto: { enabled: !!au[r.id]?.enabled, minutes: au[r.id]?.minutes ?? r.defaultMinutes },
      last: la[r.id] ?? null,
    })),
  };
}

// --------------------------------------------------------------------- run

let running = null; // one request at a time - they would only queue behind each other at Etsy anyway

/** Run one request for every shop (or the given ones). Never throws for a shop's own failure: it is reported per shop. */
export async function run(id, { source = 'you', shopIds = null } = {}) {
  const def = byId.get(id);
  if (!def) throw notFound('Unknown request.');
  if (running) throw badRequest(`"${running}" is still running - wait for it to finish.`);
  const usage = etsyUsage();
  if (usage.cooldownUntil) throw badRequest(`Etsy's request limit for this app is used up until about ${new Date(usage.cooldownUntil).toISOString().slice(11, 16)} UTC. Nothing was sent.`);
  if (usage.today >= usage.cap) throw badRequest(`The daily safety limit (${usage.cap}) is reached. Raise it on this page if you really need more today.`);

  running = def.label;
  const t0 = Date.now();
  const callsBefore = usage.today;
  const shops = [];
  try {
    if (!def.perShop) {
      try { shops.push({ shopName: 'All shops', ok: true, summary: await def.run() }); } catch (err) { shops.push({ shopName: 'All shops', ok: false, error: err.message }); }
    } else {
      for (const a of listAccounts()) {
        if (shopIds && !shopIds.includes(a.shopId)) continue;
        if (etsyCooldown().active) { shops.push({ shopId: a.shopId, shopName: a.shopName, ok: false, error: 'Etsy is not taking requests right now.' }); continue; }
        try {
          // eslint-disable-next-line no-await-in-loop
          const summary = await withShop(a.shopId, () => def.run());
          shops.push({ shopId: a.shopId, shopName: a.shopName, ok: true, summary });
        } catch (err) {
          shops.push({ shopId: a.shopId, shopName: a.shopName, ok: false, error: err.message });
          if (err.status === 429) break; // the allowance is gone: the other shops would only fail the same way
        }
      }
    }
  } finally { running = null; }

  const ok = shops.length > 0 && shops.every((s) => s.ok);
  const entry = {
    at: new Date().toISOString(), ok, source, seconds: Math.round((Date.now() - t0) / 1000),
    calls: Math.max(0, etsyUsage().today - callsBefore), shops,
    summary: shops.map((s) => `${s.shopName}: ${s.ok ? s.summary : `failed - ${s.error}`}`).join(' · ') || 'No shop is connected.',
  };
  remember(id, entry);
  audit('etsyreq.run', { detail: { id, source, ok, calls: entry.calls } });
  return { id, label: def.label, ...entry };
}

// -------------------------------------------------------------- automation

/** Called every minute by the scheduler: runs whatever is set to repeat and is due. Does nothing unless you switched one on. */
export async function autoTick() {
  const au = autos();
  const due = REQUESTS.filter((r) => au[r.id]?.enabled);
  if (!due.length || running) return;
  const la = lasts();
  for (const r of due) {
    const every = Math.max(r.minMinutes, au[r.id].minutes ?? r.defaultMinutes) * 60_000;
    const at = Date.parse(la[r.id]?.at ?? '') || 0;
    if (Date.now() - at < every) continue;
    try { await run(r.id, { source: 'schedule' }); } catch (err) { log.warn(`scheduled "${r.label}" did not run: ${err.message}`); remember(r.id, { ...(la[r.id] ?? {}), at: new Date().toISOString(), ok: false, source: 'schedule', summary: err.message, shops: [] }); }
    return; // one per tick
  }
}
