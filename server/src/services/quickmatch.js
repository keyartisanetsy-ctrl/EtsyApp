/**
 * Quick match: finding which order a parcel is for without an AI and without
 * spending a credit. It reads the evidence that is already lying around:
 *
 *   tracking  the last digits and carrier the warehouse sent, against the
 *             inbound tracking number typed on the order - the one signal that
 *             is close to certain;
 *   state     whether the order has been bought from the supplier at all, and
 *             whether the number it carries could be this parcel's;
 *   text      words the browser read off the photo (OCR) against the listing's
 *             title, variation, SKU and the supplier's Chinese title, with
 *             rare words counting for more than common ones;
 *   colours   a fingerprint of the photo against each listing photo (see
 *             imagesig.js), with the background set aside.
 *
 * Every candidate comes back with the evidence behind its score, so a person
 * can see why. Only the tracking number is trusted enough to assign by itself;
 * the rest rank the suggestions, and assign on their own only when the person
 * has asked for that.
 */
import { getDb, parse, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { findOrderByCode } from './ordercode.js';
import { signatureFor, similarity } from './imagesig.js';
import { cachedProductImageId } from './warehousecheck.js';
import * as packing from './packing.js';

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ----------------------------------------------------------------- tracking

const CARRIERS = [
  ['zto', ['中通', 'zto', 'zhongtong']],
  ['yto', ['圆通', '圓通', 'yto', 'yuantong']],
  ['sto', ['申通', 'sto', 'shentong']],
  ['yunda', ['韵达', '韻達', 'yunda']],
  ['sf', ['顺丰', '順豐', 'sf', 'shunfeng']],
  ['jt', ['极兔', '極兔', 'j&t', 'jitu']],
  ['ems', ['邮政', '郵政', 'ems', 'youzheng']],
  ['jd', ['京东', '京東', 'jd']],
  ['deppon', ['德邦', 'deppon']],
  ['best', ['百世', '汇通', '匯通', 'best']],
  ['fw', ['丰网', '豐網']],
];

/** Which carrier a piece of text names ("中通", "ZTO Express"), or null. */
export function carrierId(text) {
  const t = String(text ?? '').toLowerCase();
  for (const [id, names] of CARRIERS) {
    for (const name of names) {
      if (/^[a-z&]+$/.test(name) ? new RegExp(`(^|[^a-z])${name.replace('&', '\\&')}([^a-z]|$)`).test(t) : t.includes(name)) return id;
    }
  }
  return null;
}

/**
 * Could this parcel be the one an order's typed-in inbound tracking is about?
 * `match` means a number on the order ends with the parcel's last digits (and
 * the carrier, where both name one, agrees). `conflict` means the order does
 * carry tracking numbers, none of them this one.
 */
export function trackingEvidence(parcel, supplyTracking) {
  const text = String(supplyTracking ?? '').trim();
  if (!text) return { match: false, conflict: false };
  const last4 = String(parcel.last4 ?? '');
  const wanted = carrierId(parcel.carrier);
  let numbered = false;
  let match = false;
  for (const part of text.split(/[\n,;，；]+/)) {
    const numbers = part.match(/[0-9]{4,}/g);
    if (!numbers) continue;
    numbered = true;
    const theirs = carrierId(part);
    if (last4 && (!wanted || !theirs || wanted === theirs) && numbers.some((n) => n.endsWith(last4))) match = true;
  }
  return { match, conflict: numbered && !match };
}

// --------------------------------------------------------------------- text

const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'from', 'this', 'that', 'new', 'set', 'pcs', 'pack', 'size', 'color', 'colour',
  'free', 'shipping', 'custom', 'personalized', 'personalised', 'handmade', 'gift', 'gifts', 'unique', 'item', 'order', 'one', 'two',
  'piece', 'pieces', 'cute', 'best', 'high', 'quality', 'made', 'china', 'brand', 'product', 'products', 'box', 'bag', 'made', 'type']);

/** The words worth comparing in a piece of text: Latin words and codes, and pairs of Chinese characters. */
export function tokenize(text) {
  const t = String(text ?? '').toLowerCase();
  const latin = new Set();
  for (const w of t.match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(w)) continue;
    if (/^[0-9]+$/.test(w) ? w.length >= 4 : w.length >= 3) latin.add(w);
  }
  const cjk = new Set();
  for (const run of t.match(/[㐀-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) cjk.add(run.slice(i, i + 2));
  }
  return { latin, cjk };
}

/** True when two words differ by at most one letter (an OCR slip), words of 5+ letters only. */
function nearlyEqual(a, b) {
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    diff += 1;
    if (diff > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

const itemText = (d) => [d.title, d.variant, d.sku, d.supplyTitle].filter(Boolean).join(' ');

/**
 * How much of what was read off the photo shows up in each item's own words.
 * A word that is in half the items (a colour, a generic noun) is worth nothing;
 * a word in one or two of them (a brand, a model code) is worth a lot.
 */
export function textScores(readText, demands) {
  const read = tokenize(readText);
  if (!read.latin.size && !read.cjk.size) return null;

  const docs = new Map();
  for (const d of demands) {
    const key = itemText(d);
    if (!docs.has(key)) docs.set(key, tokenize(key));
  }
  const n = docs.size;
  const df = { latin: new Map(), cjk: new Map() };
  for (const tok of docs.values()) {
    for (const kind of ['latin', 'cjk']) for (const w of tok[kind]) df[kind].set(w, (df[kind].get(w) ?? 0) + 1);
  }
  const idf = (kind, w) => Math.log((n + 1) / ((df[kind].get(w) ?? 0) + 0.5));

  const out = new Map();
  for (const d of demands) {
    const tok = docs.get(itemText(d));
    let sum = 0;
    const hits = [];
    for (const w of read.latin) {
      let weight = 0;
      if (tok.latin.has(w)) weight = idf('latin', w);
      else {
        for (const v of tok.latin) if (nearlyEqual(w, v)) { weight = 0.5 * idf('latin', v); break; }
      }
      if (weight >= 0.5) { sum += weight; hits.push(w); }
    }
    for (const w of read.cjk) {
      if (tok.cjk.has(w) && idf('cjk', w) >= 0.5) { sum += 0.8 * idf('cjk', w); hits.push(w); }
    }
    out.set(d.itemId, { score: sum / (sum + 2.5), hits: hits.slice(0, 6) });
  }
  return out;
}

// -------------------------------------------------------------------- scoring

/** Colour similarity (about 0.5 = unrelated, 0.9 = same colours) stretched to 0..1. */
const stretch = (sim) => clamp((sim - 0.5) / 0.4);

/**
 * Score every demand against the parcel. Returns one entry per item, each with
 * its total (0..1) and the evidence behind it. The photo's colours are
 * compared once per distinct listing picture, not once per order.
 */
export async function scoreDemands(parcel, demands, { photoSignature = undefined } = {}) {
  const sig = photoSignature !== undefined ? photoSignature : signatureFor(parcel.attachment_id);
  const readText = [parcel.ocr_text, parcel.note].filter(Boolean).join(' ');
  const texts = textScores(readText, demands);

  // One fingerprint per distinct listing picture (and the supplier's, where the supply book has some).
  const byImage = new Map();
  for (const d of demands) {
    if (!d.imageUrl) continue;
    if (!byImage.has(d.imageUrl)) byImage.set(d.imageUrl, { refs: new Set([d.imageUrl]) });
    for (const u of (d.supplyImages ?? []).slice(0, 2)) if (typeof u === 'string' && /^https?:/.test(u)) byImage.get(d.imageUrl).refs.add(u);
  }
  const visual = new Map();
  if (sig) {
    await packing.mapLimit([...byImage.entries()], 6, async ([imageUrl, { refs }]) => {
      let best = null;
      for (const url of refs) {
        try {
          const sim = similarity(sig, signatureFor(await cachedProductImageId(url)));
          if (sim != null && (best == null || sim > best)) best = sim;
        } catch { /* a photo that cannot be fetched or read just has no say */ }
      }
      if (best != null) visual.set(imageUrl, best);
    });
  }

  return demands.map((d) => {
    const evidence = [];
    const trk = trackingEvidence(parcel, d.supplyTracking);
    const sim = d.imageUrl ? visual.get(d.imageUrl) : undefined;
    const vis = sim == null ? null : stretch(sim);
    const txt = texts?.get(d.itemId) ?? null;

    if (trk.match) evidence.push({ kind: 'tracking', strong: true, label: `tracking ends ${parcel.last4}` });
    if (txt && txt.hits.length) evidence.push({ kind: 'text', label: `text: ${txt.hits.slice(0, 3).join(', ')}`, score: round2(txt.score) });
    if (sim != null) evidence.push({ kind: 'colours', label: `colours ${Math.round(sim * 100)}%`, score: round2(sim) });
    if (d.purchased) evidence.push({ kind: 'state', label: 'bought from supplier' });
    if (trk.conflict) evidence.push({ kind: 'warn', label: 'order has a different tracking number' });

    // Agreement beats either alone, but one strong signal is not thrown away
    // because the other has nothing to say (OCR is often silent).
    const signals = [vis, txt?.score].filter((v) => v != null);
    let base = 0;
    if (signals.length === 2) base = 0.75 * Math.max(...signals) + 0.25 * Math.min(...signals);
    else if (signals.length === 1) base = 0.9 * signals[0];
    if (d.purchased) base += 0.05;
    if (trk.conflict) base -= 0.12;
    if (parcel.quantity > Math.max(1, d.remaining)) base -= 0.05;
    const total = trk.match ? Math.max(0.96, base) : clamp(base, 0, 0.92);

    return { demand: d, total, base: clamp(base), visual: vis, text: txt?.score ?? null, trackingMatch: trk.match, evidence };
  });
}

/** Group scored items into products (one card per listing picture), best first - the shape the AI match uses too. */
function toProducts(scored) {
  const groups = new Map();
  for (const s of scored) {
    const key = s.demand.imageUrl ?? `item:${s.demand.itemId}`;
    if (!groups.has(key)) groups.set(key, { imageUrl: s.demand.imageUrl, title: s.demand.title, sku: s.demand.sku, entries: [] });
    groups.get(key).entries.push(s);
  }
  return [...groups.values()].map((g) => {
    g.entries.sort((a, b) => Number(b.trackingMatch) - Number(a.trackingMatch) || b.total - a.total || a.demand.orderedTs - b.demand.orderedTs);
    const best = g.entries[0];
    return {
      imageUrl: g.imageUrl, title: g.title, sku: g.sku, score: round2(best.total),
      evidence: best.evidence.filter((e) => e.kind === 'colours' || e.kind === 'text'),
      demands: g.entries.slice(0, 8).map((e) => ({
        ...packing.slimDemand(e.demand), orderName: e.demand.orderName || '', score: round2(e.total),
        trackingMatch: e.trackingMatch, evidence: e.evidence.filter((x) => x.kind === 'tracking' || x.kind === 'state' || x.kind === 'warn'),
      })),
    };
  }).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- the matcher

const MAX_PRODUCTS = 64;

/**
 * Look for the parcel's order. Returns the parcel, with what was found in
 * `quick`. `assign` says how sure is sure enough to assign without being asked:
 *   'tracking' - only when the tracking number identifies the order (default)
 *   'sure'     - also when text and colours both point clearly at one order
 *   'never'    - suggestions only
 */
export async function quickMatch(id, { channels, from, to, assign = 'tracking' } = {}) {
  const db = getDb();
  const parcel = packing.getRow(id);
  if (parcel.match_channel) throw badRequest('This arrival is matched already - unmatch it first.');
  if (parcel.quantity < 1) throw badRequest('Every piece of this photo has been split out - match the split arrivals instead.');

  const range = packing.resolveRange({ channels, from, to });
  const open = packing.loadDemand(range).filter((d) => d.remaining > 0);
  // The oldest orders' products first; a very long list is cut, not slowed down.
  const allowed = new Set([...new Set(open.map((d) => d.imageUrl ?? d.itemId))].slice(0, MAX_PRODUCTS));
  const pool = open.filter((d) => allowed.has(d.imageUrl ?? d.itemId));

  const scored = await scoreDemands(parcel, pool);
  const products = toProducts(scored).filter((p) => p.score >= 0.15 || p.demands.some((d) => d.trackingMatch)).slice(0, 6);

  const result = {
    engine: 'quick', ranAt: new Date().toISOString(), channels: range.channels, from: range.from, to: range.to,
    considered: pool.length,
    signals: {
      tracking: scored.some((s) => s.trackingMatch),
      text: scored.some((s) => s.text != null),
      colours: scored.some((s) => s.visual != null),
    },
    items: products, auto: null, needsItem: null,
  };

  const choice = chooseAutomatically(scored, assign);
  if (choice?.pick) {
    db.prepare('UPDATE inbound_parcels SET quick = ? WHERE id = ?').run(JSON.stringify({ ...result, auto: { done: true, reason: choice.reason } }), parcel.id);
    const d = choice.pick.demand;
    return packing.confirmMatch(parcel.id, { channel: d.channel, orderId: d.orderId, itemId: d.itemId, source: 'quick', score: choice.pick.total });
  }
  if (choice?.orderItems) {
    result.needsItem = {
      code: choice.orderItems[0].demand.orderRef, channel: choice.orderItems[0].demand.channel, orderId: choice.orderItems[0].demand.orderId,
      reason: choice.reason, items: choice.orderItems.map((e) => itemOption(e)),
    };
  }
  db.prepare('UPDATE inbound_parcels SET quick = ? WHERE id = ?').run(JSON.stringify(result), parcel.id);
  return packing.getParcel(parcel.id);
}

/** Two order lines for the very same product - which of them a parcel is makes no difference. */
const sameProduct = (a, b) => a.title === b.title && a.variant === b.variant && a.sku === b.sku && a.imageUrl === b.imageUrl;

/** The line to use out of equally good ones: the earliest, when they are all the same product. */
const firstIfInterchangeable = (ranked) => (ranked.every((e) => sameProduct(e.demand, ranked[0].demand))
  ? [...ranked].sort((a, b) => String(a.demand.itemId).localeCompare(String(b.demand.itemId), undefined, { numeric: true }))[0] : null);

/** An item to pick from, when an order is known but not which of its items this parcel is. */
const itemOption = (e) => ({
  itemId: e.demand.itemId, title: e.demand.title, variant: e.demand.variant, sku: e.demand.sku, imageUrl: e.demand.imageUrl,
  quantity: e.demand.quantity, received: e.demand.received, remaining: e.demand.remaining, score: round2(e.total),
  evidence: e.evidence.filter((x) => x.kind === 'colours' || x.kind === 'text'),
});

/**
 * The only assignments made without a person. A tracking number that names
 * exactly one order settles the order; the item within it is settled when it is
 * the only one still needed, or clearly looks like one of them. Anything less
 * is shown, not done.
 */
function chooseAutomatically(scored, assign) {
  if (assign === 'never') return null;

  const byOrder = new Map();
  for (const s of scored) {
    if (!s.trackingMatch) continue;
    const key = `${s.demand.channel}:${s.demand.orderId}`;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(s);
  }
  if (byOrder.size === 1) {
    const items = [...byOrder.values()][0];
    if (items.length === 1) return { pick: items[0], reason: 'the tracking number names this order and it needs only this item' };
    const ranked = [...items].sort((a, b) => b.base - a.base);
    if (ranked[0].base >= 0.4 && ranked[0].base - ranked[1].base >= 0.15) {
      return { pick: ranked[0], reason: 'the tracking number names this order, and this item looks like the parcel' };
    }
    const same = firstIfInterchangeable(ranked);
    if (same) return { pick: same, reason: 'the tracking number names this order, and its lines are the same product' };
    return { orderItems: ranked, reason: 'the tracking number names this order, but not which of its items this is' };
  }
  if (byOrder.size > 1) return null;

  if (assign === 'sure') {
    const ranked = [...scored].sort((a, b) => b.total - a.total);
    const [top, next] = ranked;
    const otherOrder = ranked.find((s) => `${s.demand.channel}:${s.demand.orderId}` !== `${top?.demand.channel}:${top?.demand.orderId}`
      && s.demand.imageUrl !== top?.demand.imageUrl);
    if (top && top.visual != null && top.text != null && top.visual >= 0.75 && top.text >= 0.3
        && (!otherOrder || top.total - otherOrder.total >= 0.25)
        && (!next || next.demand.imageUrl !== top.demand.imageUrl || next.total <= top.total)) {
      return { pick: top, reason: 'the colours and the text read off the photo both point at this item, and nothing else is close' };
    }
  }
  return null;
}

// --------------------------------------------------------------- by order code

/**
 * Put the parcel on the order whose code was typed (26-0710-01). A code names
 * an order, not an item: when the order has one item still needed, or the
 * parcel plainly looks like one of them, that item is taken; otherwise the
 * items come back to choose from, never a guess. An empty code releases the parcel.
 */
export async function assignByCode(id, { code, itemId = null, channels, from, to } = {}) {
  const parcel = packing.getRow(id);
  const text = String(code ?? '').trim();
  if (!text) return { parcel: packing.unmatchParcel(parcel.id) };

  const range = packing.resolveRange({ channels, from, to });
  // A code (26-1007-01) once the order has one; before that, the order's own number (#2419).
  const found = findOrderByCode(text);
  if (!found) throw notFound(`No order has the code or number "${text}" in the shop${range.channels.length > 1 ? 's' : ''} you are working with. Type an order code like 26-1007-01, or an order number like #2419.`);

  const items = packing.loadDemand(range, found);
  if (!items.length) throw notFound(`Order ${text} has no items in the local mirror. Sync orders first.`);

  let pick = null;
  const scored = await scoreDemands(parcel, items);
  if (itemId != null) {
    pick = scored.find((s) => String(s.demand.itemId) === String(itemId));
    if (!pick) throw notFound(`Item ${itemId} is not on order ${text}.`);
  } else {
    const needed = scored.filter((s) => s.demand.remaining > 0);
    if (scored.length === 1) [pick] = scored;
    else if (needed.length === 1) [pick] = needed;
    else {
      const ranked = [...(needed.length ? needed : scored)].sort((a, b) => b.base - a.base);
      if (ranked[0].base >= 0.5 && ranked[0].base - (ranked[1]?.base ?? 0) >= 0.2) [pick] = ranked;
      else pick = firstIfInterchangeable(ranked);
    }
  }

  if (!pick) {
    const options = [...scored].sort((a, b) => Number(b.demand.remaining > 0) - Number(a.demand.remaining > 0) || b.base - a.base);
    return {
      needsItem: {
        code: items[0].orderRef, channel: found.channel, orderId: found.orderId, buyer: items[0].buyer,
        reason: 'This order has more than one item - say which one this parcel is.', items: options.map(itemOption),
      },
    };
  }
  const d = pick.demand;
  audit('packing.assign_code', { entity: 'parcel', entityId: parcel.id, detail: { code: text, itemId: d.itemId } });
  return { parcel: packing.confirmMatch(parcel.id, { channel: d.channel, orderId: d.orderId, itemId: d.itemId, source: 'manual' }) };
}
