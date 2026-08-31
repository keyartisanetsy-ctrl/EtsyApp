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
import { getDb, json, parse } from '../db/index.js';
import { money } from '../lib/money.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as ai from './ai/index.js';

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
  const info = db.prepare('INSERT INTO research_runs (keyword, taxonomy_id, scope, result_count, metrics) VALUES (?,?,?,?,?)')
    .run(keyword || '', taxonomyId ?? null, sortOn, rows.length, json(metrics));
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
    FROM listings WHERE state = 'active'`).all();

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
  getDb().prepare('SELECT id, keyword, taxonomy_id, result_count, created_at, summary IS NOT NULL AS has_summary FROM research_runs ORDER BY id DESC LIMIT ?')
    .all(limit);

export function getRun(id) {
  const db = getDb();
  const run = db.prepare('SELECT * FROM research_runs WHERE id = ?').get(id);
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
