/**
 * The same product in different places - an Etsy listing, a Shopify product,
 * another Etsy shop's listing - and the variants inside them that are the same
 * thing, so each of those variants can carry the same SKU.
 *
 * Nothing here decides alone. Evidence is collected and shown:
 *   supplier  both point at the same supplier item (the item number in the link)
 *   sku       they already share a SKU
 *   title     the words of the titles overlap (rare words count for more)
 *   image     the first photos look alike (the colour fingerprint of imagesig.js)
 * and a person links the products and approves the SKUs.
 *
 * The shops rarely list a product the same way: one has more variants than the
 * other. Variants are paired by the options they are made of ("Cherry
 * Profile", "Red / M"), by a SKU they already share, or - when a product has
 * just one variant on each side - as the single pair. A variant with no
 * counterpart is kept as its own, flagged as only on one side, and still gets a
 * SKU that fits the family, so when the other shop adds it the SKU is ready.
 */
import { getDb, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import * as catalog from './catalog.js';
import { parseSupplyUrl } from './taobao.js';
import { signatureFor, similarity } from './imagesig.js';
import { cachedProductImageId } from './warehousecheck.js';
import { readSetting } from './settings.js';
import { DEFAULT_PREFIX } from './skugen.js';
import { run, parseJsonish } from './ai/index.js';

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// -------------------------------------------------------------------- text

const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'from', 'this', 'that', 'set', 'new', 'gift', 'gifts', 'cute', 'custom',
  'handmade', 'personalized', 'personalised', 'free', 'shipping', 'made', 'sale', 'best', 'unique', 'perfect', 'item', 'items', 'pcs',
  'pack', 'size', 'color', 'colour', 'high', 'quality', 'style', 'design', 'designs', 'lot', 'one', 'two']);

/** The words of a title that say what the product is. */
export function titleTokens(title) {
  const out = new Set();
  for (const raw of String(title ?? '').toLowerCase().split(/[^a-z0-9㐀-鿿]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw); // keycaps ~ keycap
  }
  return out;
}

/** The option values a variation label is made of: "Colour: Red / Size: M" -> ["m", "red"]; a single, plain variant -> []. */
export function optionValues(label) {
  return String(label ?? '').split(/\s*\/\s*|\s*\|\s*/)
    .map((part) => (part.includes(':') ? part.slice(part.indexOf(':') + 1) : part))
    .map((p) => p.toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim())
    .filter((p) => p && p !== 'default title')
    .sort();
}

const wordsOf = (values) => new Set(values.flatMap((v) => v.split(' ')).filter((w) => w.length > 1));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
};

/** KEY004-1 -> key004 : the part of a SKU shared by the variants of one product. */
export const skuBase = (sku) => String(sku ?? '').toLowerCase().replace(/[-_]\d{1,3}$/, '');

// ---------------------------------------------------------------- products

/** Products of the chosen shops, each with the facts used to compare them. */
function indexProducts(shops = null) {
  const products = catalog.productsOf(shops);
  for (const p of products) {
    p.tokens = titleTokens(p.title);
    p.skus = new Set(p.variants.map((v) => v.sku.toLowerCase()).filter(Boolean));
    p.bases = new Set([...p.skus].map(skuBase));
    p.suppliers = new Set();
    for (const v of p.variants) {
      for (const link of [v.variantSupplyLink, v.supplyLink]) {
        if (!link) continue;
        const parsed = parseSupplyUrl(link);
        if (parsed.ok && parsed.itemId) p.suppliers.add(`${parsed.supplier}:${parsed.itemId}`);
      }
    }
    p.imageUrl = p.coverUrl || p.variants.find((v) => v.variantImageUrl)?.variantImageUrl || '';
  }
  return products;
}

const rejectedPairs = () => new Set(getDb().prepare('SELECT a_key, b_key FROM product_link_rejects').all().flatMap((r) => [`${r.a_key}|${r.b_key}`, `${r.b_key}|${r.a_key}`]));

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next; next += 1; out[i] = await fn(list[i], i); }
  }));
  return out;
}

/** The colour fingerprint of a product's first photo, or null when it cannot be fetched. */
async function fingerprint(product, cache) {
  if (!product.imageUrl) return null;
  if (cache.has(product.imageUrl)) return cache.get(product.imageUrl);
  let sig = null;
  try { sig = signatureFor(await cachedProductImageId(product.imageUrl)); } catch { /* a photo that will not load simply has no say */ }
  cache.set(product.imageUrl, sig);
  return sig;
}

const stretch = (sim) => clamp((sim - 0.5) / 0.4);

/** How sure the evidence of a pair makes us, 0..1. */
export function pairScore(ev) {
  if (ev.sku === 'same') return 0.97;
  if (ev.sku === 'family') return 0.88;
  const t = ev.title ?? 0;
  const s = ev.image?.sim != null ? stretch(ev.image.sim) : null;
  if (ev.supplier) return Math.min(0.97, 0.9 + (t >= 0.4 ? 0.05 : 0) + (s != null && s > 0.7 ? 0.03 : 0));
  if (s == null) return Math.min(0.7, 0.85 * t);
  return Math.min(0.92, 0.5 * t + 0.5 * s + (t > 0.6 && s > 0.7 ? 0.1 : 0));
}
export const tierOf = (score) => (score >= 0.85 ? 'sure' : score >= 0.6 ? 'likely' : 'maybe');

// ------------------------------------------------------------- suggestions

/**
 * Products that look like the same thing in different shops, strongest first,
 * grouped so three listings of one product come as one suggestion. Photos are
 * only compared for pairs the other evidence already makes plausible, at most
 * `imageBudget` pairs a time.
 */
export async function suggest({ shops = null, minScore = 0.5, imageBudget = 40, limit = 80 } = {}) {
  const products = indexProducts(shops);
  const byKey = new Map(products.map((p) => [p.key, p]));
  const rejects = rejectedPairs();

  // idf over product titles: a word in every title is worth nothing
  const df = new Map();
  for (const p of products) for (const t of p.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const N = products.length || 1;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) ?? 0) + 0.5));
  for (const p of products) p.norm = Math.sqrt([...p.tokens].reduce((s, t) => s + idf(t) ** 2, 0)) || 1;

  const pairs = new Map(); // "a|b" -> evidence
  const edge = (a, b) => {
    if (a.key === b.key || a.shopKey === b.shopKey) return null; // across shops - two listings of one shop are not what this is for
    const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    if (rejects.has(k)) return null;
    if (a.groupId != null && a.groupId === b.groupId) return null; // already linked
    if (!pairs.has(k)) pairs.set(k, { a: a.key < b.key ? a : b, b: a.key < b.key ? b : a, ev: {} });
    return pairs.get(k).ev;
  };

  // title words, through an inverted index (very common words are skipped)
  const postings = new Map();
  for (const p of products) for (const t of p.tokens) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push(p); }
  for (const p of products) {
    const dots = new Map();
    for (const t of p.tokens) {
      const list = postings.get(t);
      if (list.length > Math.max(25, N * 0.25)) continue;
      for (const q of list) if (q.key > p.key) dots.set(q, (dots.get(q) ?? 0) + idf(t) ** 2);
    }
    for (const [q, dot] of dots) {
      const cos = dot / (p.norm * q.norm);
      if (cos < 0.4) continue;
      const ev = edge(p, q);
      if (ev) ev.title = round2(cos);
    }
  }
  // the same supplier item / the same SKU
  const bySupplier = new Map(); const bySku = new Map(); const byBase = new Map();
  const bucket = (m, k, p) => { if (!m.has(k)) m.set(k, []); m.get(k).push(p); };
  for (const p of products) {
    for (const s of p.suppliers) bucket(bySupplier, s, p);
    for (const s of p.skus) bucket(bySku, s, p);
    for (const s of p.bases) bucket(byBase, s, p);
  }
  const link = (m, field, value) => {
    for (const list of m.values()) {
      if (list.length < 2 || list.length > 12) continue; // an item shared by a dozen products says little
      for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
        const ev = edge(list[i], list[j]);
        if (ev && (field !== 'sku' || ev.sku !== 'same')) ev[field] = value;
      }
    }
  };
  link(byBase, 'sku', 'family');
  link(bySku, 'sku', 'same');
  link(bySupplier, 'supplier', true);

  // photos, for the pairs worth the download
  const cache = new Map();
  const needImage = [...pairs.values()].filter((e) => pairScore(e.ev) < 0.85 && (e.ev.title ?? 0) >= 0.4)
    .sort((x, y) => (y.ev.title ?? 0) - (x.ev.title ?? 0)).slice(0, imageBudget);
  await mapLimit(needImage, 6, async (e) => {
    const [sa, sb] = await Promise.all([fingerprint(e.a, cache), fingerprint(e.b, cache)]);
    const sim = sa && sb ? similarity(sa, sb) : null;
    e.ev.image = sim == null ? { checked: true, sim: null } : { checked: true, sim: round2(sim) };
  });

  // connected components of the pairs that are worth showing
  const scored = [...pairs.values()].map((e) => ({ ...e, score: pairScore(e.ev) })).filter((e) => e.score >= minScore);
  const parent = new Map(products.map((p) => [p.key, p.key]));
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  for (const e of scored) parent.set(find(e.a.key), find(e.b.key));
  const comps = new Map();
  for (const e of scored) {
    const root = find(e.a.key);
    if (!comps.has(root)) comps.set(root, { members: new Set(), edges: [] });
    comps.get(root).members.add(e.a.key); comps.get(root).members.add(e.b.key); comps.get(root).edges.push(e);
  }

  const out = [];
  for (const c of comps.values()) {
    const members = [...c.members].map((k) => byKey.get(k));
    const groupIds = new Set(members.map((m) => m.groupId).filter((g) => g != null));
    const best = Math.max(...c.edges.map((e) => e.score));
    out.push({
      score: round2(best), tier: tierOf(best),
      joinsGroup: groupIds.size === 1 ? [...groupIds][0] : null,
      members: members.map(publicProduct),
      evidence: c.edges.sort((x, y) => y.score - x.score).slice(0, 8).map((e) => ({
        a: e.a.key, b: e.b.key, score: round2(e.score), ...e.ev,
        ai: storedAiCheck(e.a.key, e.b.key, e.a.imageUrl, e.b.imageUrl),   // only when someone asked for it
      })),
    });
  }
  out.sort((x, y) => y.score - x.score || y.members.length - x.members.length);
  return { suggestions: out.slice(0, limit), products: products.length, imagesCompared: needImage.length };
}

// ----------------------------------------------------------- optional AI look

const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);

function storedAiCheck(aKey, bKey, aUrl, bUrl) {
  const [lo, hi] = pairKey(aKey, bKey);
  const [loUrl, hiUrl] = lo === aKey ? [aUrl, bUrl] : [bUrl, aUrl];
  const r = getDb().prepare('SELECT * FROM product_ai_checks WHERE a_key = ? AND b_key = ? AND a_url = ? AND b_url = ?').get(lo, hi, loUrl ?? '', hiUrl ?? '');
  return r ? { verdict: r.verdict, confidence: r.confidence, summary: r.summary, checkedAt: r.checked_at } : null;
}

const AI_SYSTEM = `You help an online seller decide whether two shop listings are the SAME product.

You get two product photos and the two listing titles. The listings come from different shops, so the
photos, titles and wording will differ. Look at the product itself: its design, character, colours,
shape, printed artwork and how many pieces it has. The same product in another colour is still the
same product; a different design, character or model from the same maker is NOT.

Reply with JSON only:
{"verdict":"same"|"different"|"unsure","confidence":0.0-1.0,"summary":"one short line: what matches or what differs"}
Say "unsure" when the photos do not show enough to tell.`;

/**
 * Optional, on request only: one small AI look at pairs of products that the
 * free evidence (supplier item, SKU, title, photo colours) could not settle.
 * The answer is shown next to the evidence and remembered; it never links or
 * changes anything by itself.
 */
export async function compareWithAi(pairs, { provider, model, runner = run } = {}) {
  const wanted = (pairs ?? []).slice(0, 6);
  if (!wanted.length) throw badRequest('No product pairs to look at.');
  const results = [];
  for (const { a, b } of wanted) {
    const pa = productByKey(a); const pb = productByKey(b);
    if (pa.shopKey === pb.shopKey) throw badRequest('Both products are in the same shop.');
    const ua = pa.coverUrl || pa.variants.find((v) => v.variantImageUrl)?.variantImageUrl || '';
    const ub = pb.coverUrl || pb.variants.find((v) => v.variantImageUrl)?.variantImageUrl || '';
    if (!ua || !ub) { results.push({ a, b, error: 'One of the two products has no photo to look at.' }); continue; }
    try {
      const ids = [await cachedProductImageId(ua), await cachedProductImageId(ub)];
      const ai = await runner({
        kind: 'custom',
        provider: provider || readSetting('ai.warehouse.provider') || undefined,
        model: model || readSetting('ai.warehouse.model') || undefined,
        promptOverride: AI_SYSTEM,
        attachmentIds: ids.map((id) => ({ id, detail: 'low' })),
        effort: 'fast',
        userInput: `Photo 1 is the listing "${String(pa.title).slice(0, 160)}" (${pa.shopName}).\nPhoto 2 is the listing "${String(pb.title).slice(0, 160)}" (${pb.shopName}).\nJSON only.`,
        maxTokens: 300,
      });
      const parsed = parseJsonish(ai.text);
      if (!parsed) throw new Error('The AI did not return a usable answer.');
      const verdict = ['same', 'different', 'unsure'].includes(parsed.verdict) ? parsed.verdict : 'unsure';
      const confidence = Number.isFinite(Number(parsed.confidence)) ? Math.min(1, Math.max(0, Number(parsed.confidence))) : null;
      const summary = String(parsed.summary ?? '').slice(0, 300);
      const [lo, hi] = pairKey(a, b);
      const [loUrl, hiUrl] = lo === a ? [ua, ub] : [ub, ua];
      getDb().prepare(`
        INSERT INTO product_ai_checks (a_key, b_key, a_url, b_url, verdict, confidence, summary, provider, model, checked_at)
        VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(a_key, b_key, a_url, b_url) DO UPDATE SET verdict = excluded.verdict, confidence = excluded.confidence,
          summary = excluded.summary, provider = excluded.provider, model = excluded.model, checked_at = datetime('now')`)
        .run(lo, hi, loUrl, hiUrl, verdict, confidence, summary, ai.provider ?? null, ai.model ?? null);
      results.push({ a, b, ai: storedAiCheck(a, b, ua, ub) });
    } catch (err) { results.push({ a, b, error: err.message }); }
  }
  audit('catalog.product_ai_check', { entity: 'product_link', entityId: wanted.map((p) => `${p.a}~${p.b}`).join(',').slice(0, 200), detail: { pairs: wanted.length } });
  return { results };
}

const publicProduct = (p) => ({
  key: p.key, channel: p.channel, shopKey: p.shopKey, shopName: p.shopName, title: p.title, url: p.url, state: p.state,
  imageUrl: p.imageUrl || p.coverUrl, groupId: p.groupId, variantCount: p.variants.length,
  skus: p.variants.map((v) => v.sku).filter(Boolean).slice(0, 6),
});

// ------------------------------------------------------------------ groups

function productByKey(key) {
  const [channel, shopId, ...rest] = String(key).split(':');
  const ref = rest.join(':').replace(/^p/, '');
  const found = catalog.productsOf([`${channel}:${shopId}`]).find((p) => p.ref === ref);
  if (!found) throw notFound(`That product is not in ${channel} shop ${shopId}. Sync the shop first.`);
  return found;
}

const memberParts = (productKey) => {
  const [channel, shopId, ...rest] = String(productKey).split(':');
  return { channel, shopId: Number(shopId), ref: rest.join(':').replace(/^p/, '') };
};

/** All groups, each with its products and how well their variants already line up. */
export function listGroups() {
  const db = getDb();
  const groups = db.prepare('SELECT * FROM product_groups ORDER BY id DESC').all();
  const products = new Map(indexProducts().map((p) => [p.key, p]));
  return groups.map((g) => {
    const members = db.prepare('SELECT channel, shop_id, product_ref, source FROM product_group_members WHERE group_id = ?').all(g.id)
      .map((m) => products.get(catalog.variantKey(m.channel, m.shop_id, `p${m.product_ref}`))).filter(Boolean);
    const slots = slotsFor(members);
    return {
      id: g.id, title: g.title, baseSku: g.base_sku, createdAt: g.created_at,
      members: members.map(publicProduct),
      slots: slots.length,
      aligned: slots.filter((s) => !s.conflict && s.members.every((m) => m.sku && m.sku.toLowerCase() === s.sku.toLowerCase())).length,
      partial: slots.filter((s) => s.missingIn.length).length,
    };
  });
}

/** Link products as one group (joining or merging existing groups they already belong to). */
export function linkProducts(productKeys, { title = '', source = 'manual' } = {}) {
  const keys = [...new Set(productKeys)];
  if (keys.length < 2) throw badRequest('Pick at least two products to link.');
  const db = getDb();
  const found = keys.map(productByKey);
  if (new Set(found.map((p) => p.shopKey)).size < 2 && !found.some((p) => p.groupId != null)) {
    throw badRequest('Those products are all in one shop - link products of different shops.');
  }
  let groupId = null;
  db.transaction(() => {
    const existing = [...new Set(found.map((p) => p.groupId).filter((g) => g != null))];
    groupId = existing[0] ?? Number(db.prepare('INSERT INTO product_groups (title) VALUES (?)')
      .run(String(title || found[0].title).slice(0, 200)).lastInsertRowid);
    for (const other of existing.slice(1)) {
      db.prepare('UPDATE product_group_members SET group_id = ? WHERE group_id = ?').run(groupId, other);
      db.prepare('DELETE FROM product_groups WHERE id = ?').run(other);
    }
    for (const p of found) {
      db.prepare(`INSERT INTO product_group_members (channel, shop_id, product_ref, group_id, source) VALUES (?,?,?,?,?)
                  ON CONFLICT(channel, shop_id, product_ref) DO UPDATE SET group_id = excluded.group_id`)
        .run(p.channel, p.shopId, p.ref, groupId, source);
    }
    db.prepare("UPDATE product_groups SET updated_at = datetime('now') WHERE id = ?").run(groupId);
  })();
  audit('catalog.link', { entity: 'product_group', entityId: groupId, detail: { products: keys } });
  return groupId;
}

export function unlinkProduct(productKey) {
  const db = getDb();
  const { channel, shopId, ref } = memberParts(productKey);
  const row = db.prepare('SELECT group_id FROM product_group_members WHERE channel = ? AND shop_id = ? AND product_ref = ?').get(channel, shopId, ref);
  if (!row) throw notFound('That product is not in a group.');
  db.prepare('DELETE FROM product_group_members WHERE channel = ? AND shop_id = ? AND product_ref = ?').run(channel, shopId, ref);
  // A group of one is no group.
  if (db.prepare('SELECT COUNT(*) c FROM product_group_members WHERE group_id = ?').get(row.group_id).c < 2) {
    db.prepare('DELETE FROM product_group_members WHERE group_id = ?').run(row.group_id);
    db.prepare('DELETE FROM product_groups WHERE id = ?').run(row.group_id);
  }
  audit('catalog.unlink', { entity: 'product_group', entityId: row.group_id, detail: { product: productKey } });
  return { groupId: row.group_id };
}

export function deleteGroup(id) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM product_groups WHERE id = ?').get(id)) throw notFound(`Group ${id} does not exist.`);
  db.prepare('DELETE FROM product_group_members WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM product_groups WHERE id = ?').run(id);
  audit('catalog.unlink', { entity: 'product_group', entityId: id });
  return { deleted: id };
}

/** "These two are not the same product" - never suggested again. */
export function rejectPair(aKey, bKey) {
  if (!aKey || !bKey || aKey === bKey) throw badRequest('Two different products are needed.');
  const [a, b] = aKey < bKey ? [aKey, bKey] : [bKey, aKey];
  getDb().prepare('INSERT OR IGNORE INTO product_link_rejects (a_key, b_key) VALUES (?,?)').run(a, b);
  return { rejected: [a, b] };
}

// ------------------------------------------------------------------- slots

/** The next product number of this family of SKUs across every shop: KEY004 -> KEY005. */
function nextBase(prefix = readSetting('sku.prefix') || DEFAULT_PREFIX) {
  const up = String(prefix).toUpperCase();
  const re = new RegExp(`^${up.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`, 'i');
  let top = 0;
  for (const sku of catalog.allSkus()) { const m = re.exec(sku); if (m) top = Math.max(top, Number(m[1]) || 0); }
  return `${up}${String(top + 1).padStart(3, '0')}`;
}

/** How the variants of a family of SKUs are written here: separator and zero padding, so a new one looks like its siblings. */
function styleOf(skus) {
  for (const s of skus) {
    const m = /^(.*?)([-_])(\d+)$/.exec(s);
    if (m) return { sep: m[2], width: m[3].length > 1 && m[3].startsWith('0') ? m[3].length : 1 };
  }
  return { sep: '-', width: 1 };
}

/**
 * Pair up the variants of these products. Returns slots: each a set of
 * variants (at most one per product) that are the same thing, with the SKU they
 * should share.
 */
export function slotsFor(products, { baseSku = '' } = {}) {
  // The product with the most variants frames the slots; the others are fitted onto it.
  const ordered = [...products].sort((a, b) => b.variants.length - a.variants.length);
  const slots = [];
  const place = (slot, v, product) => { slot.members.push({ key: v.key, productKey: product.key, shopKey: v.shopKey, shopName: v.shopName, channel: v.channel, variation: v.variation, sku: v.sku, hasSupply: !!(v.supplyLink || v.variantSupplyLink), imageUrl: v.variantImageUrl || v.coverUrl }); slot.products.add(product.key); };
  const newSlot = (v, product) => {
    const slot = { id: slots.length, label: v.variation || '(single variant)', values: optionValues(v.variation), words: wordsOf(optionValues(v.variation)), members: [], products: new Set() };
    place(slot, v, product); slots.push(slot);
  };

  for (const product of ordered) {
    const used = new Set();
    for (const v of product.variants) {
      const values = optionValues(v.variation);
      const sig = values.join('|');
      const free = (s) => !s.products.has(product.key) && !used.has(s.id);
      let slot = null;
      // 1. a SKU they already share
      if (v.sku) slot = slots.find((s) => free(s) && s.members.some((m) => m.sku && m.sku.toLowerCase() === v.sku.toLowerCase())) ?? null;
      // 2. the same options
      if (!slot) slot = slots.find((s) => free(s) && s.values.join('|') === sig) ?? null;
      // 3. options that overlap enough, when one slot is clearly the best
      if (!slot && values.length) {
        const words = wordsOf(values);
        const scored = slots.filter(free).map((s) => ({ s, j: jaccard(words, s.words) })).filter((x) => x.j >= 0.6).sort((a, b) => b.j - a.j);
        if (scored.length && (scored.length === 1 || scored[0].j - scored[1].j >= 0.15)) slot = scored[0].s;
      }
      if (slot) { place(slot, v, product); used.add(slot.id); } else { newSlot(v, product); used.add(slots[slots.length - 1].id); }
    }
  }

  // the SKU each slot should carry
  const taken = catalog.allSkus();
  const familySkus = slots.flatMap((s) => s.members.map((m) => m.sku)).filter(Boolean);
  let base = baseSku || '';
  if (!base) {
    const counts = new Map();
    for (const sku of familySkus) { const b = skuBase(sku); counts.set(b, (counts.get(b) ?? 0) + 1); }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    base = top ? familySkus.find((s) => skuBase(s) === top[0]).replace(/[-_]\d{1,3}$/, '') : '';
  }
  const style = styleOf(familySkus);
  const planned = new Set();
  const pending = [];
  for (const slot of slots) {
    const distinct = [];
    for (const m of slot.members) if (m.sku && !distinct.some((d) => d.toLowerCase() === m.sku.toLowerCase())) distinct.push(m.sku);
    slot.currentSkus = distinct;
    slot.conflict = distinct.length > 1;
    if (distinct.length) {
      const tally = (sku) => slot.members.filter((m) => m.sku.toLowerCase() === sku.toLowerCase()).length;
      slot.sku = [...distinct].sort((a, b) => tally(b) - tally(a) || (slot.members.find((m) => m.sku === b)?.hasSupply ? 1 : 0) - (slot.members.find((m) => m.sku === a)?.hasSupply ? 1 : 0))[0];
      planned.add(slot.sku.toLowerCase());
    } else pending.push(slot);
    slot.missingIn = products.filter((p) => !slot.products.has(p.key)).map((p) => p.shopName);
    slot.onlyIn = slot.missingIn.length && slot.members.length < products.length ? slot.members.map((m) => m.shopName) : [];
  }
  if (pending.length) {
    if (!base) base = nextBase();
    let n = 0;
    for (const slot of pending) {
      let sku;
      if (slots.length === 1) sku = base;
      else do { n += 1; sku = `${base}${style.sep}${String(n).padStart(style.width, '0')}`; } while (taken.has(sku.toLowerCase()) || planned.has(sku.toLowerCase()));
      if (slots.length === 1 && (taken.has(sku.toLowerCase()) || planned.has(sku.toLowerCase()))) sku = `${base}${style.sep}${String(1).padStart(style.width, '0')}`;
      slot.sku = sku; slot.generated = true; planned.add(sku.toLowerCase());
    }
  }
  return slots.map((s) => ({
    id: s.id, label: s.label, sku: s.sku, generated: !!s.generated, conflict: s.conflict, currentSkus: s.currentSkus,
    missingIn: s.missingIn, members: s.members,
  }));
}

/** The proposal for these products: slots with their SKUs, and what each change would be - checked, nothing sent. */
export async function matrix(productKeys, { baseSku = '' } = {}) {
  const keys = [...new Set(productKeys)];
  if (keys.length < 2) throw badRequest('Pick at least two products.');
  const products = keys.map(productByKey);
  const slots = slotsFor(products, { baseSku });
  const edits = slots.flatMap((s) => s.members.filter((m) => m.sku.toLowerCase() !== s.sku.toLowerCase()).map((m) => ({ key: m.key, sku: s.sku })));
  const check = edits.length ? await catalog.applyChanges(edits, { dryRun: true }) : { results: [], changed: 0, failed: 0 };
  const problems = Object.fromEntries(check.results.filter((r) => !r.ok).map((r) => [r.key, r.error]));
  return {
    products: products.map(publicProduct),
    slots: slots.map((s) => ({ ...s, members: s.members.map((m) => ({ ...m, problem: problems[m.key] ?? null })) })),
    changes: edits.length, problems: Object.keys(problems).length,
  };
}

/**
 * Link the products and write the approved SKUs. `slots` is [{ sku, memberKeys }]
 * - what the person ended up with after adjusting the proposal.
 */
export async function applyLink({ productKeys, slots, title = '', dryRun = false, writers } = {}) {
  const keys = [...new Set(productKeys ?? [])];
  if (keys.length < 2) throw badRequest('Pick at least two products.');
  if (!Array.isArray(slots) || !slots.length) throw badRequest('There are no SKUs to apply.');
  const products = keys.map(productByKey);
  const allowedVariants = new Map(products.flatMap((p) => p.variants.map((v) => [v.key, v])));

  const seen = new Set();
  const edits = [];
  for (const slot of slots) {
    const sku = String(slot.sku ?? '').trim();
    const memberKeys = slot.memberKeys ?? [];
    if (!memberKeys.length) continue;
    for (const key of memberKeys) {
      if (!allowedVariants.has(key)) throw badRequest(`${key} is not one of the products being linked.`);
      if (seen.has(key)) throw badRequest('A variant can only be in one slot.');
      seen.add(key);
    }
    // two variants of one product in one slot would put one SKU on both
    const perProduct = new Set(memberKeys.map((k) => allowedVariants.get(k).productKey));
    if (perProduct.size !== memberKeys.length) throw badRequest(`"${sku}" is on two variants of the same product - a slot holds one variant per product.`);
    for (const key of memberKeys) edits.push({ key, sku });
  }
  if (!edits.length) throw badRequest('There are no SKUs to apply.');

  const outcome = await catalog.applyChanges(edits, { dryRun, ...(writers ? { writers } : {}) });
  if (dryRun) return { dryRun: true, ...outcome };

  const groupId = linkProducts(keys, { title, source: 'manual' });
  const base = skuBase(slots.find((s) => s.sku)?.sku ?? '');
  getDb().prepare("UPDATE product_groups SET base_sku = ?, updated_at = datetime('now') WHERE id = ?").run(base, groupId);
  return { groupId, ...outcome };
}
