/**
 * Handing out SKUs to the variants that have none - across every shop at once.
 *
 * The rules, in the order they matter:
 *   - a SKU that exists is never changed: only empty ones are filled;
 *   - a SKU already in use anywhere is never handed out again, and no two
 *     variants of one shop ever get the same one;
 *   - the same product in several shops carries the same SKUs, so a product
 *     that is already linked (or that clearly is the same one as another
 *     shop's - the same supplier item, or the same photos and words) is planned
 *     together: its variants are paired up and a variant that already has a SKU
 *     passes it on to the shops that lack one;
 *   - a variant one shop has and another lacks still gets a SKU of the same
 *     family, so it is ready when the other shop adds it;
 *   - nothing is written by planning. The plan is shown, ticked or unticked per
 *     product, and only the ticked ones are applied.
 *
 * Numbering follows what the catalogue already does: the letters most SKUs start
 * with (KEY011 -> KEY), the next free product number, and the way variants are
 * numbered (KEY011-1 or KEY011-01).
 */
import { audit } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import * as catalog from './catalog.js';
import * as links from './productlinks.js';
import { readSetting } from './settings.js';
import { DEFAULT_PREFIX } from './skugen.js';

const MAX_SKU = { etsy: 32, shopify: 255 };
const SURE = 0.85;
const lc = (s) => String(s ?? '').toLowerCase();

/** The letters most SKUs of the catalogue start with: KEY011, KEY012-1 -> KEY. */
export function detectPrefix(skus) {
  const counts = new Map();
  for (const sku of skus) {
    const m = /^([A-Za-z]{1,8})\d{2,}/.exec(sku);
    if (m) counts.set(m[1].toUpperCase(), (counts.get(m[1].toUpperCase()) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { prefix: top[0], source: 'catalogue' } : { prefix: String(readSetting('sku.prefix') || DEFAULT_PREFIX).toUpperCase(), source: 'setting' };
}

/** How the variants of one product are numbered in the catalogue: "-1" or "-01". */
export function detectStyle(skus) {
  const counts = new Map();
  for (const sku of skus) {
    const m = /[-_](\d+)$/.exec(sku);
    if (!m) continue;
    const sep = sku[sku.length - m[0].length];
    const width = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 1;
    const k = `${sep}${width}`;
    counts.set(k, { sep, width, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return top ? { sep: top.sep, width: top.width } : { sep: '-', width: 1 };
}

const publicProduct = (p) => ({
  key: p.key, channel: p.channel, shopKey: p.shopKey, shopName: p.shopName, title: p.title, url: p.url,
  imageUrl: p.coverUrl || p.variants.find((v) => v.variantImageUrl)?.variantImageUrl || '', variantCount: p.variants.length,
  state: p.state,
});

/**
 * Split one cluster of look-alike products into the sets that really go together:
 * start from the strongest pair, add products that tie to them well and are in a
 * shop not yet in the set. What is left over is not forced into anything.
 */
function splitCluster(members, edges) {
  const left = new Map(members.map((m) => [m.key, m]));
  // the strongest first; between equals, the pair whose words match best (two listings of different products can share photos)
  const usable = edges.filter((e) => e.score >= 0.6).sort((x, y) => y.score - x.score || (y.title ?? 0) - (x.title ?? 0));
  const sets = [];
  for (;;) {
    const seed = usable.find((e) => left.has(e.a) && left.has(e.b));
    if (!seed) break;
    const picked = new Map([[seed.a, left.get(seed.a)], [seed.b, left.get(seed.b)]]);
    const shopsIn = new Set([...picked.values()].map((m) => m.shopKey));
    let weakest = seed.score;
    for (let grew = true; grew;) {
      grew = false;
      for (const e of usable) {
        if (e.score < 0.7) break;
        const inA = picked.has(e.a); const inB = picked.has(e.b);
        if (inA === inB) continue;
        const other = left.get(inA ? e.b : e.a);
        if (!other || shopsIn.has(other.shopKey)) continue;
        picked.set(other.key, other); shopsIn.add(other.shopKey); weakest = Math.min(weakest, e.score); grew = true;
        break;
      }
    }
    for (const k of picked.keys()) left.delete(k);
    sets.push({ members: [...picked.values()], score: weakest });
  }
  return sets;
}

/**
 * What would be written. Nothing is: this only works the SKUs out.
 *
 *   shops          limit to these shops (the matches in other shops still count)
 *   productKeys    limit to these products
 *   prefix         letters in front of the product number (default: what the catalogue uses)
 *   numbering      "auto" | "1" | "01" - how a product's variants are numbered
 *   includeInactive  also draft / expired / sold-out listings
 *   linkMatches    remember products planned together as the same product
 */
export async function plan({
  shops = null, productKeys = null, prefix = '', numbering = 'auto', includeInactive = false, linkMatches = true, imageBudget = 300,
  matchSets = null,
} = {}) {
  const all = catalog.productsOf(null);
  const wantKeys = productKeys?.length ? new Set(productKeys) : null;
  // matchSets: products a person has already confirmed as the same one, [[key, key, ...], ...] - planned exactly as given
  const sets = Array.isArray(matchSets) ? matchSets : null;
  const inScope = sets ? () => true : (p) => (!shops || shops.includes(p.shopKey)) && (!wantKeys || wantKeys.has(p.key));
  const needs = (p) => p.variants.some((v) => !v.sku);
  const isActive = (p) => includeInactive || /^active$/i.test(p.state);

  const skuList = all.flatMap((p) => p.variants.map((v) => v.sku)).filter(Boolean);
  const detected = detectPrefix(skuList);
  const usedPrefix = String(prefix || detected.prefix).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,12}$/.test(usedPrefix)) throw badRequest('The prefix can be letters, digits, "-" or "_" (up to 12).');
  const style = numbering === '01' ? { sep: '-', width: 2 } : numbering === '1' ? { sep: '-', width: 1 } : detectStyle(skuList);

  // the numbers in use under this prefix
  const re = new RegExp(`^${usedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`, 'i');
  let top = 0; let width = 3;
  for (const sku of skuList) { const m = re.exec(sku); if (m) { top = Math.max(top, Number(m[1]) || 0); width = Math.max(width, m[1].length); } }
  const taken = catalog.allSkus();
  const usedBases = new Set(skuList.map((s) => links.skuBase(s)));
  let next = top + 1;
  const allocBase = () => {
    for (;;) {
      const base = `${usedPrefix}${String(next).padStart(width, '0')}`;
      next += 1;
      const k = base.toLowerCase();
      if (!usedBases.has(k) && !taken.has(k)) { usedBases.add(k); return base; }
    }
  };

  // what each shop already uses, so one shop never gets the same SKU on two variants
  const shopSkus = new Map();
  for (const p of all) {
    if (!shopSkus.has(p.shopKey)) shopSkus.set(p.shopKey, new Set());
    for (const v of p.variants) if (v.sku) shopSkus.get(p.shopKey).add(lc(v.sku));
  }

  const candidates = sets ? [] : all.filter((p) => inScope(p) && needs(p));
  const skipped = [];
  const live = [];
  for (const p of candidates) {
    if (!isActive(p)) skipped.push({ kind: 'inactive', products: [publicProduct(p)], reason: `Not an active listing (${p.state || 'no state'}).` });
    else live.push(p);
  }
  const liveKeys = new Set(live.map((p) => p.key));
  const handled = new Set();
  const work = []; // { sortTitle, kind, products, score? }

  if (sets) {
    const byKey = new Map(all.map((p) => [p.key, p]));
    for (const keys of sets) {
      const products = [...new Set(keys)].map((k) => byKey.get(k)).filter(Boolean);
      if (products.length < 2) { skipped.push({ kind: 'note', products: products.map(publicProduct), reason: 'Pick at least two products that are in the shops.' }); continue; }
      if (new Set(products.map((p) => p.shopKey)).size !== products.length) {
        skipped.push({ kind: 'note', products: products.map(publicProduct), reason: 'Two of them are in the same shop - a shop cannot carry the same SKU twice.' }); continue;
      }
      work.push({ kind: 'match', products, score: null, confirmed: true, sortTitle: lc(products[0].title) });
    }
  }

  // 1. products already linked: their group is planned as one
  const byGroup = new Map();
  for (const p of all) if (p.groupId != null) { if (!byGroup.has(p.groupId)) byGroup.set(p.groupId, []); byGroup.get(p.groupId).push(p); }
  for (const p of (sets ? [] : live)) {
    if (p.groupId == null || handled.has(p.key)) continue;
    const members = byGroup.get(p.groupId) ?? [p];
    for (const m of members) handled.add(m.key);
    if (members.length < 2) { handled.delete(p.key); continue; }
    work.push({ kind: 'group', products: members, sortTitle: lc(members[0].title) });
  }

  // 2. products that clearly are the same one as another shop's
  const unlinkedLive = (k) => liveKeys.has(k) && !handled.has(k);
  if (!sets && live.some((p) => p.groupId == null)) {
    const sg = await links.suggest({ shops: null, minScore: 0.6, imageBudget, limit: 100000 });
    const byKey = new Map(all.map((p) => [p.key, p]));
    for (const s of sg.suggestions) {
      const members = s.members.filter((m) => { const p = byKey.get(m.key); return p && p.groupId == null && isActive(p); });
      if (members.length < 2 || !members.some((m) => unlinkedLive(m.key))) continue;
      const keys = new Set(members.map((m) => m.key));
      const edges = s.evidence.filter((e) => keys.has(e.a) && keys.has(e.b));
      for (const set of splitCluster(members, edges)) {
        if (!set.members.some((m) => unlinkedLive(m.key))) continue;
        const products = set.members.map((m) => byKey.get(m.key));
        for (const p of products) handled.add(p.key);
        work.push({ kind: 'match', products, score: set.score, sortTitle: lc(products[0].title) });
      }
    }
  }

  // 3. everything else, one product at a time
  for (const p of live) if (!handled.has(p.key)) { handled.add(p.key); work.push({ kind: 'product', products: [p], sortTitle: lc(p.title) }); }

  work.sort((a, b) => (a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : 0));

  const units = [];
  for (const w of work) {
    const slots = links.slotsFor(w.products, { taken, style, newBase: allocBase });
    const notes = [];
    const edits = [];
    for (const slot of slots) {
      const sku = slot.sku;
      if (!sku) continue;
      const k = lc(sku);
      if (slot.conflict) { notes.push(`The shops disagree on "${slot.label}" (${slot.currentSkus.join(' / ')}) - left for you to choose.`); continue; }
      for (const m of slot.members) {
        if (m.sku) continue; // a SKU that exists stays
        const product = w.products.find((p) => p.key === m.productKey);
        if (!inScope(product)) continue;
        if (sku.length > (MAX_SKU[m.channel] ?? 255)) { notes.push(`"${sku}" is too long for ${m.shopName}.`); continue; }
        const used = shopSkus.get(m.shopKey) ?? new Set();
        if (used.has(k)) { notes.push(`${m.shopName} already uses ${sku} on another variant - skipped "${m.variation || 'the product'}".`); continue; }
        used.add(k); shopSkus.set(m.shopKey, used);
        edits.push({ key: m.key, sku, variation: m.variation, productKey: m.productKey, shopKey: m.shopKey, shopName: m.shopName, channel: m.channel });
      }
      taken.add(k);
    }
    if (!edits.length && !w.confirmed) { for (const n of notes) skipped.push({ kind: 'note', products: w.products.map(publicProduct), reason: n }); continue; }
    const partial = slots.filter((s) => s.members.length < w.products.length).length;
    const link = w.kind === 'match' && linkMatches ? w.products.map((p) => p.key) : null;
    units.push({
      id: units.length, kind: w.kind, title: w.products[0].title, products: w.products.map(publicProduct),
      slots: slots.length, partial, score: w.score ?? null, edits, link, notes,
      // linked groups and single products are safe to tick; a new match only when it is a sure one with every variant paired
      // confirmed by a person: ticked unless the shops disagree on a SKU; otherwise linked groups and single products are safe to tick,
      // and a new match only when it is a sure one with every variant paired
      ticked: w.confirmed ? !notes.length : (w.kind !== 'match' || (w.score >= SURE && partial === 0 && !notes.length)),
    });
  }

  return {
    prefix: usedPrefix, prefixSource: prefix ? 'typed' : detected.source, style, nextNumber: next,
    units, skipped,
    counts: {
      variants: units.reduce((n, u) => n + u.edits.length, 0), units: units.length,
      products: new Set(units.flatMap((u) => u.edits.map((e) => e.productKey))).size,
      groups: units.filter((u) => u.kind === 'group').length, matches: units.filter((u) => u.kind === 'match').length,
      single: units.filter((u) => u.kind === 'product').length, ticked: units.filter((u) => u.ticked).length,
      skipped: skipped.length,
    },
  };
}

/**
 * Write the units that were approved. Each edit only fills a variant that has no
 * SKU yet; everything else is checked and sent by catalog.applyChanges (the
 * variant's own shop, duplicates refused). Products planned together are
 * linked afterwards, once all of their SKUs went through.
 */
export async function applyUnits(units = [], { dryRun = false, writers } = {}) {
  if (!Array.isArray(units) || !units.length) throw badRequest('Nothing to write.');
  if (units.length > 40) throw badRequest('Write at most 40 products at a time.');
  const edits = [];
  const refused = new Map(); // variant key -> why
  for (const unit of units) {
    for (const e of unit.edits ?? []) {
      let row;
      try { row = catalog.getRow(e.key); } catch (err) { refused.set(e.key, err.message); continue; }
      if (row.sku) { refused.set(e.key, `${row.productTitle}${row.variation ? ` (${row.variation})` : ''} already has the SKU ${row.sku} - this only fills empty ones.`); continue; }
      edits.push({ key: e.key, sku: e.sku });
    }
  }
  const outcome = edits.length ? await catalog.applyChanges(edits, { dryRun, ...(writers ? { writers } : {}) }) : { results: [], changed: 0, failed: 0 };
  const byKey = new Map(outcome.results.map((r) => [r.key, r]));

  const out = [];
  for (const unit of units) {
    const errors = [];
    let written = 0;
    for (const e of unit.edits ?? []) {
      if (refused.has(e.key)) { errors.push(refused.get(e.key)); continue; }
      const r = byKey.get(e.key);
      if (r?.ok) written += r.unchanged ? 0 : 1; else errors.push(r?.error ?? 'Not processed.');
    }
    let linked = false; let linkError = null;
    if (!dryRun && !errors.length && Array.isArray(unit.link) && unit.link.length > 1) {
      try { links.linkProducts(unit.link, { source: 'auto' }); linked = true; } catch (err) { linkError = err.message; }
    }
    out.push({ id: unit.id, ok: !errors.length, written, errors, linked, linkError });
  }
  if (!dryRun) audit('catalog.auto_sku', { entity: 'catalog', entityId: 'auto-sku', detail: { units: units.length, written: out.reduce((n, u) => n + u.written, 0), failed: out.filter((u) => !u.ok).length } });
  return { dryRun, units: out, written: out.reduce((n, u) => n + u.written, 0), failed: out.filter((u) => !u.ok).length };
}
