/**
 * Etsy requests: the one place that talks to Etsy on its own behalf.
 *
 * Etsy gives this app a fixed number of requests a day, and a bug or a busy day used to spend all of it in the
 * background. So nothing is sent to Etsy unless you ask for it: every kind of request lives here as a button
 * ("Fetch new orders", "Refresh listings"...), it runs for EVERY connected shop in one go, and you decide which ones
 * sit on the dashboard (starred) and which - if any - repeat by themselves, and how often. All repeating is off
 * until you switch it on. What Etsy allows per day is not typed in anywhere: Etsy reports it with every answer
 * (see etsyUsage in etsy/client.js) and the page shows exactly that.
 */
import { getSetting, setSetting, audit } from '../db/index.js';
import { listAccounts, withShop, etsyCooldown, etsyUsage, call, callAll } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';
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
  // ------------------------------------------------------------------ orders
  {
    id: 'orders', group: 'Orders', label: 'Fetch new orders', perShop: true, cost: '1-3 per shop', minMinutes: 5, defaultMinutes: 15,
    recommend: { star: true, auto: true, minutes: 15, why: 'New orders should show up within minutes - and it is only one or two requests per shop.' },
    note: 'New and changed orders since the last time, for every shop.',
    run: async () => { const r = await sync.syncReceipts({}); return `${n(r?.receipts)} order(s) updated`; },
  },
  {
    id: 'orders_deep', group: 'Orders', label: 'Re-read the last 90 days of orders', perShop: true, cost: '5-30 per shop', heavy: true, minMinutes: 720, defaultMinutes: 1440,
    recommend: { star: false, auto: false, why: 'Only after a gap, or when an order looks missing.' },
    note: 'Everything of the last 90 days again - use after a gap or if something looks missing.',
    run: async () => { const r = await sync.syncReceipts({ sinceDays: 90 }); return `${n(r?.receipts)} order(s) read`; },
  },
  {
    id: 'emails', group: 'Orders', label: 'Find missing buyer e-mail addresses', perShop: true, cost: 'up to 60 per shop', heavy: true, minMinutes: 360, defaultMinutes: 1440,
    recommend: { star: false, auto: false, why: 'One request per order without an address - press it when you need the addresses.' },
    note: 'Etsy leaves the address off some orders in its list; this asks for those orders one by one.',
    run: async () => { const r = await sync.enrichReceiptContacts({ limit: 60 }); return `${n(r?.found)} found, ${n(r?.stillMissing)} still without`; },
  },
  // ------------------------------------------------------------------- money
  {
    id: 'ledger', group: 'Money', label: 'Fetch payment ledger', perShop: true, cost: '2-5 per shop', minMinutes: 30, defaultMinutes: 180,
    recommend: { star: false, auto: true, minutes: 180, why: 'The real fees and net per order, a few requests every three hours.' },
    note: 'What Etsy actually paid out per order, fees and Etsy Ads.',
    run: async () => { const r = await sync.syncLedgerEntries({}); return `${n(r?.entries)} ledger entries`; },
  },
  // ---------------------------------------------------------------- listings
  {
    id: 'listings', group: 'Listings', label: 'Refresh listings (what changed)', perShop: true, cost: '3-10 per shop', minMinutes: 60, defaultMinutes: 360,
    recommend: { star: true, auto: true, minutes: 360, why: 'Keeps prices, photos and stock current; variations are only re-read for listings that changed.' },
    note: 'Every listing is read once; variations are only re-read for listings that changed (and all of them once a day).',
    run: async () => { const r = await sync.syncListings({ auto: true }); return `${r.listings} listings, ${r.products} variations${r.skippedUnchanged ? `, ${r.skippedUnchanged} unchanged left alone` : ''}`; },
  },
  {
    id: 'listings_full', group: 'Listings', label: 'Re-read every listing and variation', perShop: true, cost: '2 per listing', heavy: true, minMinutes: 1440, defaultMinutes: 1440,
    recommend: { star: false, auto: false, why: 'Two requests for every single listing - only when something is clearly out of step.' },
    note: 'Slow and expensive: two requests for every single listing of every shop.',
    run: async () => { const r = await sync.syncAll({}); return `${r.listings.listings} listings, ${r.listings.products} variations`; },
  },
  {
    id: 'variation_images', group: 'Listings', label: 'Re-read the photos tied to each variation', perShop: true, cost: '1 per listing', heavy: true, minMinutes: 1440, defaultMinutes: 1440,
    recommend: { star: false, auto: false, why: 'Only after changing variation photos on Etsy itself.' },
    note: 'Which photo belongs to which colour / size, for every listing.',
    run: async () => { const r = await sync.syncAllVariationImages({}); return `${r.checked} listings checked, ${r.mapped} photo links`; },
  },
  {
    id: 'sections', group: 'Listings', label: 'Fetch shop sections', perShop: true, cost: '1 per shop', minMinutes: 60, defaultMinutes: 1440,
    recommend: { star: false, auto: false, why: 'Sections almost never change.' },
    note: 'The section names of each shop.',
    run: async () => { const r = await sync.syncShopSections(); return `${n(r?.sections ?? r?.count ?? (Array.isArray(r) ? r.length : 0))} section(s)`; },
  },
  // -------------------------------------------------------------------- shop
  {
    id: 'shop_info', group: 'Shop', label: 'Shop profile and numbers', perShop: true, cost: '1 per shop', minMinutes: 60, defaultMinutes: 720,
    recommend: { star: true, auto: false, why: 'One request per shop: active listings, favourites, rating - a good one to keep on the dashboard.' },
    note: 'Active listings, favourites and the rating of each shop, straight from Etsy.',
    run: async () => {
      const shopId = requireShopId();
      const r = await call('getShop', { shop_id: shopId });
      const info = {
        at: new Date().toISOString(), listings: n(r?.listing_active_count), favorers: n(r?.num_favorers),
        rating: r?.review_average ?? null, reviews: n(r?.review_count), currency: r?.currency_code ?? null, vacation: !!r?.is_vacation,
      };
      setSetting(`etsy.shopinfo.${shopId}`, JSON.stringify(info));
      return `${info.listings} active listings · ${info.favorers.toLocaleString('en-US')} favourites${info.rating ? ` · ★ ${Number(info.rating).toFixed(2)} (${info.reviews})` : ''}${info.vacation ? ' · ON VACATION' : ''}`;
    },
  },
  {
    id: 'reviews', group: 'Shop', label: 'Latest reviews', perShop: true, cost: '1-2 per shop', minMinutes: 120, defaultMinutes: 1440,
    recommend: { star: true, auto: false, why: 'See new reviews and the average without opening Etsy.' },
    note: 'The newest reviews of each shop with their average rating.',
    run: async () => {
      const shopId = requireShopId();
      const rows = await callAll('getReviewsByShop', { shop_id: shopId }, { max: 100 });
      const rated = rows.filter((x) => Number.isFinite(Number(x.rating)));
      const avg = rated.length ? rated.reduce((t, x) => t + Number(x.rating), 0) / rated.length : null;
      const low = rated.filter((x) => Number(x.rating) <= 3).length;
      const newest = rows.map((x) => Number(x.create_timestamp ?? x.created_timestamp ?? 0)).sort((a, b) => b - a)[0];
      setSetting(`etsy.reviews.${shopId}`, JSON.stringify({ at: new Date().toISOString(), count: rows.length, avg, low, newest }));
      return `${rows.length} review(s)${avg ? ` · ★ ${avg.toFixed(2)}` : ''}${low ? ` · ${low} of 3★ or less` : ''}${newest ? ` · newest ${new Date(newest * 1000).toISOString().slice(0, 10)}` : ''}`;
    },
  },
  {
    id: 'shop_choices', group: 'Shop', label: 'Shipping, return and processing profiles', perShop: true, cost: '5 per shop', minMinutes: 360, defaultMinutes: 1440,
    recommend: { star: false, auto: false, why: 'The Draft desk remembers them for 12 hours; refresh only after changing them on Etsy.' },
    note: 'The choices the Draft desk offers (shipping profile, processing profile, return policy, production partners).',
    run: async () => { const r = await drafts.shopChoices({ refresh: true }); return `${r.shippingProfiles?.length ?? 0} shipping, ${r.processingProfiles?.length ?? 0} processing, ${r.returnPolicies?.length ?? 0} return`; },
  },
  // ------------------------------------------------------------------ drafts
  {
    id: 'drafts', group: 'Drafts', label: 'Get drafts from Etsy', perShop: true, cost: '1-3 per shop', minMinutes: 30, defaultMinutes: 360,
    recommend: { star: true, auto: false, why: 'Press it when you started a draft on Etsy itself.' },
    note: 'Drafts you started on Etsy, brought to the Draft desk.',
    run: async () => { const r = await drafts.pullFromEtsy({}); return r?.note ?? `${n(r?.added)} new draft(s)`; },
  },
  {
    id: 'finish', group: 'Drafts', label: 'Finish pictures and tags that did not reach Etsy', perShop: false, cost: '0 unless a send was cut short', minMinutes: 15, defaultMinutes: 30,
    recommend: { star: false, auto: true, minutes: 30, why: 'Costs nothing while nothing is owed - and completes a cut-short send by itself.' },
    note: 'Sends what a draft still owes Etsy (pictures, tags) - only does something when a send was cut short.',
    run: async () => { await drafts.finishAllPending(); return 'checked'; },
  },
  // ------------------------------------------------------------------ system
  {
    id: 'ping', group: 'Connection', label: 'Check the connection and my allowance', perShop: false, cost: '1', minMinutes: 60, defaultMinutes: 1440,
    recommend: { star: true, auto: false, why: 'One request that also shows how many requests Etsy says are left today.' },
    note: 'Asks Etsy "are we connected?" - and Etsy answers with how many requests this app may still make today.',
    run: async () => {
      await call('ping');
      const u = etsyUsage();
      return u.known ? `connected · Etsy says ${u.remaining.toLocaleString('en-US')} of ${u.limit.toLocaleString('en-US')} requests left today` : 'connected';
    },
  },
];
const byId = new Map(REQUESTS.map((r) => [r.id, r]));

// ---------------------------------------------------------------- settings

const readJson = (key, fallback) => { try { return JSON.parse(getSetting(key, '') || ''); } catch { return fallback; } };
const stars = () => new Set(readJson('etsyreq.stars', REQUESTS.filter((r) => r.recommend?.star).map((r) => r.id)));
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

/** Switch on the recommended stars and/or repeats in one go (everything else is left as it is). */
export function applyRecommended({ stars: doStars = true, auto: doAuto = true } = {}) {
  if (doStars) {
    const st = stars();
    for (const r of REQUESTS) if (r.recommend?.star) st.add(r.id);
    setSetting('etsyreq.stars', JSON.stringify([...st]));
  }
  if (doAuto) for (const r of REQUESTS) if (r.recommend?.auto) setAuto(r.id, { enabled: true, minutes: r.recommend.minutes ?? r.defaultMinutes });
  audit('etsyreq.apply_recommended', { detail: { stars: doStars, auto: doAuto } });
  return overview();
}

const remember = (id, entry) => { const l = lasts(); l[id] = entry; setSetting('etsyreq.last', JSON.stringify(l)); };

// ------------------------------------------------------------------- state

/** Everything the page and the dashboard need: the requests, what is starred / automatic, how each last went, usage. */
export function overview() {
  const st = stars(); const au = autos(); const la = lasts();
  const usage = etsyUsage();
  return {
    usage,
    shops: listAccounts().map((a) => ({ shopId: a.shopId, shopName: a.shopName })),
    requests: REQUESTS.map((r) => ({
      id: r.id, group: r.group, label: r.label, note: r.note, cost: r.cost, heavy: !!r.heavy, perShop: r.perShop,
      minMinutes: r.minMinutes, starred: st.has(r.id), recommend: r.recommend ?? null,
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
  if (usage.known && usage.remaining <= 0) throw badRequest('Etsy says this app has no requests left today. Nothing was sent.');

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
  // repeats leave the last part of Etsy's real daily allowance to your own clicks
  const u = etsyUsage();
  if (u.cooldownUntil || (u.known && u.remaining < Math.max(50, Math.round((u.limit ?? 0) * 0.1)))) return;
  const la = lasts();
  for (const r of due) {
    const every = Math.max(r.minMinutes, au[r.id].minutes ?? r.defaultMinutes) * 60_000;
    const at = Date.parse(la[r.id]?.at ?? '') || 0;
    if (Date.now() - at < every) continue;
    try { await run(r.id, { source: 'schedule' }); } catch (err) { log.warn(`scheduled "${r.label}" did not run: ${err.message}`); remember(r.id, { ...(la[r.id] ?? {}), at: new Date().toISOString(), ok: false, source: 'schedule', summary: err.message, shops: [] }); }
    return; // one per tick
  }
}
