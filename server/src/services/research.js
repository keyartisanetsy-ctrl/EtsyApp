/**
 * Product research over Etsy's public search.
 *
 * Etsy's API exposes no search-volume metric, so nothing here pretends to
 * report one. What it can measure honestly is the live competitive set for a
 * keyword: price distribution, tag frequency, listing age, and the engagement
 * (views/favourites) Etsy publishes per listing. Those are computed locally;
 * the AI pass only interprets numbers it is given.
 */
import { call, callAll } from '../etsy/client.js';
import { activeShopId } from '../etsy/shop.js';
import { getDb, json, parse } from '../db/index.js';
import { money } from '../lib/money.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as ai from './ai/index.js';
import { normalise } from '../airtable/mapping.js';

const log = createLogger('research');

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
};
const percentile = (nums, p) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** Pull a sample of live listings for a keyword and measure the field. */
export async function researchKeyword({
  keyword, taxonomyId = null, minPrice = null, maxPrice = null,
  sample = 100, sortOn = 'score', withAi = false, provider, promptId, promptOverride,
}) {
  if (!keyword?.trim() && !taxonomyId) throw badRequest('Give a keyword or pick a category.');

  const args = { keywords: keyword || undefined, sort_on: sortOn, sort_order: 'desc' };
  if (taxonomyId) args.taxonomy_id = Number(taxonomyId);
  if (minPrice != null && minPrice !== '') args.min_price = Number(minPrice);
  if (maxPrice != null && maxPrice !== '') args.max_price = Number(maxPrice);

  const listings = await callAll('findAllListingsActive', args, { pageSize: 100, max: Math.min(sample, 500) });
  if (!listings.length) {
    return { keyword, sample: 0, metrics: null, rows: [], note: 'Etsy returned no active listings for that query.' };
  }

  const prices = [];
  const tagCounts = new Map();
  const now = Math.floor(Date.now() / 1000);
  const rows = [];

  for (const l of listings) {
    const p = money(l.price);
    if (p.value != null) prices.push(p.value);
    for (const tag of l.tags || []) {
      const key = String(tag).toLowerCase().trim();
      if (key) tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    }
    const ageDays = l.original_creation_timestamp ? Math.floor((now - l.original_creation_timestamp) / 86_400) : null;
    rows.push({
      listingId: l.listing_id,
      title: l.title,
      shopId: l.shop_id,
      price: p.value,
      currency: p.currency,
      quantity: l.quantity,
      views: l.views ?? null,
      favorers: l.num_favorers ?? null,
      tags: l.tags || [],
      url: l.url,
      imageUrl: l.images?.[0]?.url_570xN ?? null,
      createdTs: l.original_creation_timestamp ?? l.creation_timestamp ?? null,
      ageDays,
      // Favourites per month live is the closest honest proxy for traction.
      favouritesPerMonth: ageDays && ageDays > 30 && l.num_favorers != null
        ? Math.round((l.num_favorers / (ageDays / 30)) * 10) / 10
        : null,
    });
  }

  const withEngagement = rows.filter((r) => r.favorers != null);
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([tag, count]) => ({ tag, count, share: Math.round((count / rows.length) * 1000) / 10 }));

  const metrics = {
    sample: rows.length,
    price: {
      min: prices.length ? Math.min(...prices) : null,
      p25: percentile(prices, 25),
      median: median(prices),
      p75: percentile(prices, 75),
      max: prices.length ? Math.max(...prices) : null,
      currency: rows.find((r) => r.currency)?.currency ?? null,
    },
    engagement: {
      medianFavourites: median(withEngagement.map((r) => r.favorers)),
      maxFavourites: withEngagement.length ? Math.max(...withEngagement.map((r) => r.favorers)) : null,
      medianAgeDays: median(rows.filter((r) => r.ageDays != null).map((r) => r.ageDays)),
      newListingsShare: Math.round(
        (rows.filter((r) => r.ageDays != null && r.ageDays <= 90).length / rows.length) * 1000,
      ) / 10,
    },
    topTags,
    // Listings that beat the median on favourites while sitting below median price.
    valueLeaders: rows
      .filter((r) => r.favorers != null && r.price != null)
      .sort((a, b) => (b.favouritesPerMonth ?? 0) - (a.favouritesPerMonth ?? 0))
      .slice(0, 10),
  };

  const db = getDb();
  const info = db.prepare('INSERT INTO research_runs (shop_id, keyword, taxonomy_id, scope, result_count, metrics) VALUES (?,?,?,?,?,?)')
    .run(activeShopId(), keyword || '', taxonomyId ?? null, sortOn, rows.length, json(metrics));
  const runId = info.lastInsertRowid;

  const ins = db.prepare(`INSERT INTO research_results (run_id, listing_id, title, shop_name, price_amount,
    price_currency, views, num_favorers, tags, url, image_url, created_ts, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const r of rows) {
      ins.run(runId, r.listingId, r.title, null, r.price != null ? Math.round(r.price * 100) : null,
        r.currency, r.views, r.favorers, json(r.tags), r.url, r.imageUrl, r.createdTs, null);
    }
  })();

  let analysis = null;
  if (withAi) {
    try {
      const brief = {
        keyword,
        sample: metrics.sample,
        priceBands: metrics.price,
        engagement: metrics.engagement,
        topTags: metrics.topTags.slice(0, 20),
        titles: rows.slice(0, 40).map((r) => ({ title: r.title, price: r.price, favourites: r.favorers, ageDays: r.ageDays })),
      };
      const res = await ai.run({ kind: 'research', provider, promptId, promptOverride, userInput: JSON.stringify(brief, null, 2), maxTokens: 3000 });
      analysis = { text: res.text, provider: res.provider, runId: res.runId };
      db.prepare('UPDATE research_runs SET summary = ? WHERE id = ?').run(res.text, runId);
    } catch (err) {
      analysis = { error: err.message };
      log.warn(`AI analysis skipped: ${err.message}`);
    }
  }

  log.info(`research "${keyword}": ${rows.length} listings sampled`);
  return { runId, keyword, taxonomyId, sample: rows.length, metrics, rows, analysis };
}

/** How the shop's own listings sit against a keyword's competitive set. */
export async function benchmarkAgainstKeyword(keyword, { sample = 100 } = {}) {
  const research = await researchKeyword({ keyword, sample });
  if (!research.metrics) return research;

  const mine = getDb().prepare(`SELECT listing_id, title, price_amount, price_divisor, price_currency, views, num_favorers, tags
    FROM listings WHERE state = 'active' AND shop_id IS ?`).all(activeShopId());

  const marketTags = new Set(research.metrics.topTags.slice(0, 20).map((t) => t.tag));
  const rows = mine.map((l) => {
    const price = l.price_amount != null ? l.price_amount / (l.price_divisor || 100) : null;
    const tags = (parse(l.tags, []) || []).map((t) => String(t).toLowerCase());
    const covered = tags.filter((t) => marketTags.has(t));
    return {
      listingId: l.listing_id,
      title: l.title,
      price,
      currency: l.price_currency,
      favorers: l.num_favorers,
      pricePosition: price == null || research.metrics.price.median == null ? null
        : price > research.metrics.price.p75 ? 'above p75'
        : price < research.metrics.price.p25 ? 'below p25' : 'mid-band',
      tagOverlap: covered.length,
      missingTopTags: [...marketTags].filter((t) => !tags.includes(t)).slice(0, 10),
    };
  });

  return { ...research, benchmark: rows };
}

export const listRuns = (limit = 50) =>
  getDb().prepare(`SELECT id, keyword, taxonomy_id, result_count, created_at, summary IS NOT NULL AS has_summary
    FROM research_runs WHERE shop_id IS ? ORDER BY id DESC LIMIT ?`)
    .all(activeShopId(), limit);

export function getRun(id) {
  const db = getDb();
  const run = db.prepare('SELECT * FROM research_runs WHERE id = ? AND shop_id IS ?').get(id, activeShopId());
  if (!run) return null;
  return {
    ...run,
    metrics: parse(run.metrics, null),
    results: db.prepare('SELECT * FROM research_results WHERE run_id = ? ORDER BY num_favorers DESC').all(id)
      .map((r) => ({ ...r, tags: parse(r.tags, []), price: r.price_amount != null ? r.price_amount / 100 : null })),
  };
}

// ------------------------------------------------------------- taxonomy

/** The seller taxonomy is large and static; cache it locally. */
export async function sellerTaxonomy({ refresh = false } = {}) {
  const db = getDb();
  const cached = db.prepare("SELECT payload FROM reference_cache WHERE key = 'seller_taxonomy'").get();
  if (cached && !refresh) return parse(cached.payload, []);

  const res = await call('getSellerTaxonomyNodes', {}, { auth: false });
  const nodes = res?.results || [];
  db.prepare(`INSERT INTO reference_cache (key, payload, fetched_at) VALUES ('seller_taxonomy', ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = datetime('now')`)
    .run(json(nodes));
  return nodes;
}

export async function buyerTaxonomy({ refresh = false } = {}) {
  const db = getDb();
  const cached = db.prepare("SELECT payload FROM reference_cache WHERE key = 'buyer_taxonomy'").get();
  if (cached && !refresh) return parse(cached.payload, []);
  const res = await call('getBuyerTaxonomyNodes', {}, { auth: false });
  const nodes = res?.results || [];
  db.prepare(`INSERT INTO reference_cache (key, payload, fetched_at) VALUES ('buyer_taxonomy', ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = datetime('now')`).run(json(nodes));
  return nodes;
}

/** Flatten the taxonomy tree for a searchable picker. */
export function flattenTaxonomy(nodes, trail = [], out = []) {
  for (const n of nodes) {
    const path = [...trail, n.name];
    out.push({ id: n.id, name: n.name, level: n.level, path: path.join(' > '), parentId: n.parent_id ?? null });
    if (n.children?.length) flattenTaxonomy(n.children, path, out);
  }
  return out;
}

export const taxonomyProperties = (taxonomyId) =>
  call('getPropertiesByTaxonomyId', { taxonomy_id: Number(taxonomyId) }, { auth: false });

export const searchShops = (shopName, { limit = 25, offset = 0 } = {}) =>
  call('findShops', { shop_name: shopName, limit, offset }, { auth: false });

// ------------------------------------------------- listing the way Etsy does

/**
 * Etsy's own category box does two things at once: it finds what you typed and
 * it shows you the neighbourhood you would be listing in. Typing "keycap set"
 * should bring back Keycaps, and next to it the keyboard branch it sits under,
 * because that is where the shoppers and the competition are.
 *
 * The taxonomy is a static tree Etsy publishes without authentication, so all
 * of this runs off the cached copy - no request per keystroke.
 */

/** Words that carry no meaning in a category search. */
const NOISE = new Set(['set', 'sets', 'kit', 'kits', 'pack', 'the', 'and', 'for', 'with', 'a', 'of',
  'takim', 'takimi', 'seti', 'icin', 've']);

/**
 * Etsy publishes the taxonomy in English only, so typing "klavye" finds
 * nothing at all. These are the words this shop actually sells in, translated
 * once so the box answers in either language.
 */
const TR_EN = {
  klavye: 'keyboard', tus: 'key', tuslar: 'keys', 'tus takimi': 'keycap',
  kapak: 'cap', yuzuk: 'ring', kolye: 'necklace', bileklik: 'bracelet',
  kupe: 'earring', mumluk: 'candle holder', mum: 'candle', tablo: 'wall art',
  poster: 'poster', canta: 'bag', cuzdan: 'wallet', anahtarlik: 'keychain',
  hediye: 'gift', dugun: 'wedding', nisan: 'engagement', 'yil donumu': 'anniversary',
  dogumgunu: 'birthday', bebek: 'baby', ev: 'home', mutfak: 'kitchen',
  masa: 'desk', 'masa altligi': 'desk mat', altlik: 'mat', lamba: 'lamp',
  sticker: 'sticker', cikartma: 'sticker', defter: 'notebook', kalem: 'pen',
  oyuncak: 'toy', kupa: 'mug', bardak: 'cup', tisort: 'shirt', tshirt: 'shirt',
};

/**
 * Split into meaningful words, and add the English word for any Turkish one,
 * so "klavye tus takimi" searches for keyboard and keycap as well.
 */
function tokens(text) {
  const base = normalise(text);
  const out = base.split(' ').filter((t) => t && !NOISE.has(t));

  // Two-word phrases first, so "tus takimi" beats "tus" on its own.
  for (const [tr, en] of Object.entries(TR_EN)) {
    if (tr.includes(' ') ? base.includes(tr) : out.includes(tr)) {
      for (const word of en.split(' ')) if (!out.includes(word)) out.push(word);
    }
  }
  return out;
}

/** The search text with any Turkish words swapped for their English equivalent. */
function englishise(query) {
  let text = normalise(query);
  for (const [tr, en] of Object.entries(TR_EN)) {
    if (text.includes(tr)) text = text.replace(new RegExp(`\\b${tr}\\b`, 'g'), en);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Score one node against the search.
 * Named matches beat path matches, and a whole-word hit beats a fragment, so
 * "ring" finds Rings before it finds Ring Bearer Pillows.
 */
function scoreNode(node, query, queryTokens) {
  const name = normalise(node.name);
  const path = normalise(node.path);
  if (!name) return 0;

  let score = 0;
  if (name === query) score += 120;
  else if (name.startsWith(query)) score += 80;
  else if (name.includes(query)) score += 55;
  else if (path.includes(query)) score += 30;

  const nameWords = new Set(name.split(' '));
  for (const t of queryTokens) {
    if (nameWords.has(t)) score += 22;
    else if (name.includes(t)) score += 11;
    else if (path.includes(t)) score += 4;
  }

  // A leaf is what you actually list in; a broad branch is context.
  if (score > 0) score += Math.min(node.level ?? 0, 4) * 3;
  return score;
}

/**
 * Search the seller taxonomy and, for each hit, the categories around it.
 *
 * `related` is what makes this feel like Etsy's own box: the branch above, the
 * categories beside it and what sits underneath, so you can see that a keycap
 * set lives under keyboards before you commit to it.
 */
export async function searchTaxonomy(query, { limit = 12, related = 6 } = {}) {
  const nodes = flattenTaxonomy(await sellerTaxonomy());
  const q = normalise(query);
  if (!q) return { query: '', results: [], total: nodes.length };

  const queryTokens = tokens(query);
  // Score against the English form too, so a Turkish search still matches the
  // English category names Etsy publishes.
  const qEnglish = englishise(query);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
    childrenOf.get(n.parentId).push(n);
  }

  const scored = nodes
    .map((n) => ({
      node: n,
      score: Math.max(scoreNode(n, q, queryTokens),
        qEnglish === q ? 0 : scoreNode(n, qEnglish, queryTokens)),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.node.path.length - b.node.path.length));

  const results = scored.slice(0, limit).map(({ node, score }) => {
    const parent = node.parentId != null ? byId.get(node.parentId) : null;
    const siblings = (parent ? childrenOf.get(parent.id) ?? [] : [])
      .filter((s) => s.id !== node.id);
    const children = childrenOf.get(node.id) ?? [];

    return {
      id: node.id,
      name: node.name,
      path: node.path,
      level: node.level,
      score,
      isLeaf: children.length === 0,
      parent: parent ? { id: parent.id, name: parent.name, path: parent.path } : null,
      // What Etsy would show you beside this choice. When a category has
      // neither children nor siblings, the branch above it is still worth
      // seeing - an empty list tells you nothing.
      related: [
        ...children.map((c) => ({ id: c.id, name: c.name, path: c.path, kind: 'narrower' })),
        ...siblings.map((sib) => ({ id: sib.id, name: sib.name, path: sib.path, kind: 'alongside' })),
        ...(!children.length && !siblings.length && parent
          ? [{ id: parent.id, name: parent.name, path: parent.path, kind: 'broader' }]
          : []),
      ].slice(0, related),
    };
  });

  return { query, results, total: scored.length };
}

/** Etsy marks these properties as the occasion-style ones. */
const OCCASION_PROPERTIES = new Set(['occasion', 'holiday', 'recipient', 'celebration']);

/**
 * Everything you need to fill in for one category: where it sits, what can go
 * under it, and every attribute Etsy will ask for - the occasion-style ones
 * separated out, because those are the ones sellers forget and they are what
 * put a listing into the gift guides.
 */
export async function taxonomyDetail(taxonomyId) {
  const id = Number(taxonomyId);
  const nodes = flattenTaxonomy(await sellerTaxonomy());
  const node = nodes.find((n) => n.id === id);
  if (!node) throw badRequest(`No Etsy category has the id ${taxonomyId}.`);

  const children = nodes.filter((n) => n.parentId === id);
  const trail = [];
  let walk = node;
  while (walk) {
    trail.unshift({ id: walk.id, name: walk.name });
    walk = walk.parentId != null ? nodes.find((n) => n.id === walk.parentId) : null;
  }

  let properties = [];
  let propertyError = null;
  try {
    const res = await taxonomyProperties(id);
    properties = res?.results ?? [];
  } catch (err) {
    // A branch category has no properties of its own; that is not a failure.
    propertyError = err.message;
  }

  const shape = (p) => ({
    propertyId: p.property_id,
    name: p.display_name || p.name,
    isRequired: !!p.is_required,
    supportsAttributes: !!p.supports_attributes,
    supportsVariations: !!p.supports_variations,
    isMultivalued: !!p.is_multivalued,
    maxValues: p.max_values_allowed ?? null,
    scales: (p.scales ?? []).map((s) => ({ scaleId: s.scale_id, name: s.display_name || s.name })),
    values: (p.possible_values ?? []).map((v) => ({ valueId: v.value_id, name: v.name })),
  });

  const all = properties.map(shape);
  const isOccasion = (p) => OCCASION_PROPERTIES.has(normalise(p.name).replace(/\s+/g, ''))
    || OCCASION_PROPERTIES.has(normalise(p.name).split(' ')[0]);

  return {
    id: node.id,
    name: node.name,
    path: node.path,
    level: node.level,
    isLeaf: children.length === 0,
    trail,
    children: children.map((c) => ({ id: c.id, name: c.name, path: c.path })),
    // Split so the form can put the required ones first and the occasions
    // somewhere they will actually be filled in.
    required: all.filter((p) => p.isRequired),
    attributes: all.filter((p) => !p.isRequired && !isOccasion(p)),
    occasions: all.filter(isOccasion),
    variationCapable: all.filter((p) => p.supportsVariations),
    propertyError,
    note: children.length
      ? 'This is a branch. Etsy wants a listing in one of the categories underneath it.'
      : null,
  };
}
