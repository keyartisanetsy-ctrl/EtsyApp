/**
 * Bulk action engine.
 *
 * Every bulk operation is a job with one row per target, so a run that fails
 * halfway is inspectable and re-runnable instead of leaving the shop guessing.
 * Jobs run in the background with bounded concurrency; `dryRun` renders the
 * exact change per target without calling Etsy.
 */
import crypto from 'node:crypto';
import { getDb, json, parse, audit } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as listings from './listings.js';
import * as inventory from './inventory.js';
import * as orders from './orders.js';
import * as tracking from './tracking/index.js';
import * as ai from './ai/index.js';
import { call } from '../etsy/client.js';
import { activeShopId } from '../etsy/shop.js';
import { requireShopId } from '../etsy/shop.js';
import { fetchInventory, toWritablePayload, writeInventory } from './inventory.js';

const log = createLogger('bulk');

// --------------------------------------------------------------- handlers

/**
 * Each handler: { label, describe(target,params) -> string, run(target,params) }
 * `describe` powers dry-run so the operator sees the change before it happens.
 */
export const HANDLERS = {
  'listing.activate': {
    label: 'Activate listings',
    describe: (id) => `Set listing ${id} to active`,
    run: (id) => listings.setState(id, 'active'),
  },
  'listing.deactivate': {
    label: 'Deactivate listings',
    describe: (id) => `Set listing ${id} to inactive`,
    run: (id) => listings.setState(id, 'inactive'),
  },
  'listing.delete': {
    label: 'Delete listings',
    describe: (id) => `Permanently delete listing ${id}`,
    run: (id) => listings.deleteListing(id),
  },
  'listing.autorenew': {
    label: 'Set auto-renew',
    describe: (id, p) => `Set auto-renew ${p.value ? 'on' : 'off'} for listing ${id}`,
    run: (id, p) => listings.updateListing(id, { should_auto_renew: !!p.value }),
  },
  'listing.section': {
    label: 'Move to section',
    describe: (id, p) => `Move listing ${id} to section ${p.sectionId}`,
    run: (id, p) => listings.updateListing(id, { shop_section_id: Number(p.sectionId) }),
  },
  'listing.shipping_profile': {
    label: 'Set shipping profile',
    describe: (id, p) => `Set shipping profile ${p.shippingProfileId} on listing ${id}`,
    run: (id, p) => listings.updateListing(id, { shipping_profile_id: Number(p.shippingProfileId) }),
  },
  'listing.return_policy': {
    label: 'Set return policy',
    describe: (id, p) => `Set return policy ${p.returnPolicyId} on listing ${id}`,
    run: (id, p) => listings.updateListing(id, { return_policy_id: Number(p.returnPolicyId) }),
  },
  'listing.taxonomy': {
    label: 'Set category',
    describe: (id, p) => `Set taxonomy ${p.taxonomyId} on listing ${id}`,
    run: (id, p) => listings.updateListing(id, { taxonomy_id: Number(p.taxonomyId) }),
  },
  // Etsy's own bulk listing pull is lighter than a single getListing with
  // includes=Images, so a shop synced a while back (or via that lighter
  // path) can be sitting on a listing with no cached image at all -- this
  // asks Etsy for that one listing's photos again and re-caches them,
  // without touching anything else about the listing.
  'listing.refresh_images': {
    label: 'Re-fetch photos from Etsy',
    describe: (id) => `Re-fetch listing ${id}'s photos from Etsy`,
    run: async (id) => {
      const images = await listings.refreshImages(id);
      return { images: images.length };
    },
  },

  'listing.tags': {
    label: 'Edit tags',
    describe: (id, p) => `${p.mode} tags [${(p.tags || []).join(', ')}] on listing ${id}`,
    run: async (id, p) => {
      const current = listings.localListing(id).tags || [];
      const incoming = (p.tags || []).map((t) => String(t).trim()).filter(Boolean);
      let next;
      if (p.mode === 'add') next = [...new Set([...current, ...incoming])];
      else if (p.mode === 'remove') next = current.filter((t) => !incoming.includes(t));
      else next = incoming;
      if (next.length > 13) throw badRequest(`Listing ${id} would end up with ${next.length} tags; Etsy allows 13.`);
      return listings.updateListing(id, { tags: next });
    },
  },

  'listing.find_replace': {
    label: 'Find and replace text',
    describe: (id, p) => `Replace "${p.find}" with "${p.replace}" in ${p.field} of listing ${id}`,
    run: async (id, p) => {
      const l = listings.localListing(id);
      const field = p.field === 'description' ? 'description' : 'title';
      const source = l[field] || '';
      const flags = p.caseSensitive ? 'g' : 'gi';
      const next = source.replace(new RegExp(p.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), p.replace ?? '');
      if (next === source) return { skipped: true, reason: 'no match' };
      return listings.updateListing(id, { [field]: next });
    },
  },

  // Price changes go through inventory: that is where Etsy keeps the real price.
  'listing.price': {
    label: 'Change prices',
    describe: (id, p) => p.mode === 'percent'
      ? `Change every price on listing ${id} by ${p.value > 0 ? '+' : ''}${p.value}%`
      : p.mode === 'set' ? `Set every price on listing ${id} to ${p.value}`
      : `Adjust every price on listing ${id} by ${p.value > 0 ? '+' : ''}${p.value}`,
    run: async (id, p) => {
      const live = await fetchInventory(id);
      const payload = toWritablePayload(live);
      let changed = 0;
      for (const product of payload.products) {
        for (const offering of product.offerings) {
          const before = Number(offering.price);
          let after = p.mode === 'percent' ? before * (1 + Number(p.value) / 100)
            : p.mode === 'set' ? Number(p.value)
            : before + Number(p.value);
          after = Math.round(after * 100) / 100;
          if (p.minPrice != null) after = Math.max(after, Number(p.minPrice));
          if (p.maxPrice != null) after = Math.min(after, Number(p.maxPrice));
          if (after <= 0) throw badRequest(`Listing ${id}: computed price ${after} is not valid.`);
          if (after !== before) changed += 1;
          offering.price = after;
        }
      }
      if (!changed) return { skipped: true, reason: 'no price change' };
      await writeInventory(id, payload);
      return { changed };
    },
  },

  'listing.quantity': {
    label: 'Set stock',
    describe: (id, p) => `Set quantity to ${p.value} on every variation of listing ${id}`,
    run: async (id, p) => {
      const live = await fetchInventory(id);
      const payload = toWritablePayload(live);
      for (const product of payload.products) for (const o of product.offerings) o.quantity = Number(p.value);
      await writeInventory(id, payload);
      return { quantity: Number(p.value) };
    },
  },

  // ---------------------------------------------------------------- SKUs
  'sku.generate': {
    label: 'Generate SKUs',
    describe: (id, p) => `Generate SKUs on listing ${id} from pattern "${p.pattern}"`,
    run: async (id, p) => {
      const live = await fetchInventory(id);
      const payload = toWritablePayload(live);
      const listing = listings.localListing(id);
      const products = (live.products || []).filter((x) => !x.is_deleted);

      products.forEach((product, index) => {
        const target = payload.products[index];
        if (target.sku && !p.overwrite) return;
        target.sku = renderSkuPattern(p.pattern, {
          listingId: id,
          title: listing.title,
          index: index + 1,
          variation: product.property_values,
          prefix: p.prefix,
        });
      });
      await writeInventory(id, payload);
      return { skus: payload.products.map((x) => x.sku) };
    },
  },

  'sku.clear': {
    label: 'Clear SKUs',
    describe: (id) => `Clear every SKU on listing ${id}`,
    run: async (id) => {
      const live = await fetchInventory(id);
      const payload = toWritablePayload(live);
      for (const product of payload.products) product.sku = '';
      await writeInventory(id, payload);
      return { cleared: payload.products.length };
    },
  },

  'sku.set': {
    label: 'Set SKU per variation',
    describe: (target, p) => `Set SKU of variation ${target} to "${p.map?.[target] ?? ''}"`,
    run: async (target, p) => {
      const [listingId, productId] = String(target).split(':').map(Number);
      return inventory.updateVariations(listingId, { [productId]: { sku: p.map[target] } });
    },
  },

  'supply.link': {
    label: 'Set supply link',
    describe: (sku, p) => `Attach supply link to SKU ${sku}`,
    run: async (sku, p) => inventory.setSkuMeta(sku, p.meta ?? p),
  },

  // -------------------------------------------------------------- orders
  'order.done': {
    label: 'Mark orders done',
    describe: (id, p) => `Mark order ${id} as ${p.value === false ? 'not done' : 'done'}`,
    run: async (id, p) => orders.setFlags([id], { done: p.value !== false }),
  },
  'order.seen': {
    label: 'Mark orders seen',
    describe: (id) => `Mark order ${id} as seen`,
    run: async (id) => orders.setFlags([id], { seen: true }),
  },
  'order.shipped': {
    label: 'Mark shipped on Etsy',
    describe: (id) => `Tell Etsy order ${id} has shipped`,
    run: async (id) => orders.updateEtsyReceipt(id, { wasShipped: true }),
  },
  'order.tracking': {
    label: 'Add tracking',
    describe: (id, p) => `Add tracking ${p.map?.[id]?.trackingCode ?? ''} to order ${id}`,
    run: async (id, p) => {
      const entry = p.map[id];
      if (!entry) throw notFound(`No tracking number supplied for order ${id}`);
      const res = await tracking.addTracking([{ receiptId: Number(id), trackingCode: entry.trackingCode, carrierName: entry.carrierName }],
        { pushToEtsy: p.pushToEtsy !== false, noteToBuyer: p.noteToBuyer, sendBcc: p.sendBcc });
      if (res.failed) throw new Error(res.results[0]?.error || 'Tracking push failed');
      return res.results[0];
    },
  },

  // ------------------------------------------------------------------ AI
  'ai.title': {
    label: 'Rewrite titles with AI',
    describe: (id) => `Generate a new title for listing ${id}`,
    run: async (id, p) => {
      const l = listings.localListing(id);
      const res = await ai.writeTitle(
        { name: l.title, category: l.taxonomyId, materials: l.materials?.join(', '), notes: (l.description || '').slice(0, 600) },
        { provider: p.provider, promptId: p.promptId, promptOverride: p.promptOverride },
      );
      const best = ai.parseTitleOptions(res.text)[0];
      if (!best) throw new Error('The model did not return a usable title.');
      if (p.apply === false) return { suggestion: best, applied: false, runId: res.runId };
      await listings.updateListing(id, { title: best.slice(0, 140) });
      return { title: best, applied: true, runId: res.runId };
    },
  },
  'ai.tags': {
    label: 'Regenerate tags with AI',
    describe: (id) => `Generate 13 tags for listing ${id}`,
    run: async (id, p) => {
      const l = listings.localListing(id);
      const res = await ai.writeTags(
        { name: l.title, materials: l.materials?.join(', '), notes: (l.description || '').slice(0, 600) },
        { provider: p.provider, promptId: p.promptId, promptOverride: p.promptOverride },
      );
      const tags = ai.normaliseTags(res.text);
      if (!tags.length) throw new Error('The model did not return usable tags.');
      if (p.apply === false) return { suggestion: tags, applied: false, runId: res.runId };
      await listings.updateListing(id, { tags });
      return { tags, applied: true, runId: res.runId };
    },
  },
  'ai.description': {
    label: 'Rewrite descriptions with AI',
    describe: (id) => `Rewrite the description of listing ${id}`,
    run: async (id, p) => {
      const l = listings.localListing(id);
      const res = await ai.writeDescription(
        { name: l.title, materials: l.materials?.join(', '), notes: (l.description || '').slice(0, 1200) },
        { provider: p.provider, promptId: p.promptId, promptOverride: p.promptOverride },
      );
      if (!res.text?.trim()) throw new Error('The model returned an empty description.');
      if (p.apply === false) return { suggestion: res.text, applied: false, runId: res.runId };
      await listings.updateListing(id, { description: res.text });
      return { applied: true, runId: res.runId };
    },
  },
};

/** SKU pattern tokens: {prefix} {listing} {index} {n} {title} {var} {var1..n} */
export function renderSkuPattern(pattern, { listingId, title, index, variation = [], prefix = '' }) {
  const slug = (s, len = 6) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, len);
  const values = variation.flatMap((v) => v.values || []);
  let out = String(pattern || '{prefix}-{listing}-{n}')
    .replace(/\{prefix\}/g, prefix || 'SKU')
    .replace(/\{listing\}/g, String(listingId))
    .replace(/\{index\}|\{n\}/g, String(index).padStart(2, '0'))
    .replace(/\{title\}/g, slug(title, 8))
    .replace(/\{var\}/g, slug(values.join(''), 8));
  out = out.replace(/\{var(\d)\}/g, (_, i) => slug(values[Number(i) - 1], 6));
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ------------------------------------------------------------------- queue

const running = new Map(); // jobId -> { cancel: boolean }

export function createJob({ type, targets, params = {}, label, dryRun = false, concurrency = 2 }) {
  const handler = HANDLERS[type];
  if (!handler) throw badRequest(`Unknown bulk action "${type}". Known: ${Object.keys(HANDLERS).join(', ')}`);
  const list = [...new Set((targets || []).map((t) => String(t)))].filter(Boolean);
  if (!list.length) throw badRequest('Select at least one target.');

  const db = getDb();
  const id = `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const shopId = activeShopId();

  db.transaction(() => {
    db.prepare('INSERT INTO bulk_jobs (id, shop_id, type, label, status, total, dry_run, params) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, shopId, type, label || handler.label, dryRun ? 'running' : 'queued', list.length, dryRun ? 1 : 0, json(params));
    const ins = db.prepare('INSERT INTO bulk_job_items (job_id, seq, target_id, label, status) VALUES (?,?,?,?,?)');
    list.forEach((target, i) => ins.run(id, i, target, safeDescribe(handler, target, params), 'pending'));
  })();

  if (dryRun) {
    db.prepare("UPDATE bulk_jobs SET status = 'completed', succeeded = total, finished_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("UPDATE bulk_job_items SET status = 'dry-run' WHERE job_id = ?").run(id);
  } else {
    setImmediate(() => runJob(id, concurrency).catch((e) => log.error(`job ${id} crashed: ${e.message}`)));
  }

  return getJob(id);
}

const safeDescribe = (handler, target, params) => {
  try { return handler.describe(target, params); } catch { return `${handler.label}: ${target}`; }
};

async function runJob(jobId, concurrency = 2) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(jobId);
  if (!job) return;
  const handler = HANDLERS[job.type];
  const params = parse(job.params, {});
  const control = { cancel: false };
  running.set(jobId, control);

  db.prepare("UPDATE bulk_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?").run(jobId);
  const items = db.prepare("SELECT * FROM bulk_job_items WHERE job_id = ? AND status = 'pending' ORDER BY seq").all(jobId);

  let succeeded = 0;
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (control.cancel) return;
      const item = items[cursor++];
      if (!item) return;

      const target = /^\d+$/.test(item.target_id) ? Number(item.target_id) : item.target_id;
      db.prepare("UPDATE bulk_job_items SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(item.id);
      try {
        const result = await handler.run(target, params);
        db.prepare("UPDATE bulk_job_items SET status = ?, response = ?, error = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(result?.skipped ? 'skipped' : 'ok', json(result ?? null), item.id);
        succeeded += 1;
      } catch (err) {
        db.prepare("UPDATE bulk_job_items SET status = 'error', error = ?, response = ?, updated_at = datetime('now') WHERE id = ?")
          .run(err.message, json(err.details ?? err.body ?? null), item.id);
        failed += 1;
        log.warn(`${job.type} on ${item.target_id}: ${err.message}`);
      }
      db.prepare('UPDATE bulk_jobs SET succeeded = ?, failed = ? WHERE id = ?').run(succeeded, failed, jobId);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 5)) }, worker));

  const status = control.cancel ? 'canceled' : failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'completed';
  db.prepare("UPDATE bulk_jobs SET status = ?, succeeded = ?, failed = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, succeeded, failed, jobId);
  running.delete(jobId);

  audit('bulk.run', { entity: 'job', entityId: jobId, status: failed ? 'partial' : 'ok', detail: { type: job.type, succeeded, failed } });
  log.info(`job ${jobId} (${job.type}) finished: ${succeeded} ok, ${failed} failed`);
}

export function getJob(id) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM bulk_jobs WHERE id = ? AND shop_id IS ?').get(id, activeShopId());
  if (!job) throw notFound(`Job ${id} not found.`);
  const items = db.prepare('SELECT * FROM bulk_job_items WHERE job_id = ? ORDER BY seq').all(id);
  return {
    id: job.id, type: job.type, label: job.label, status: job.status,
    total: job.total, succeeded: job.succeeded, failed: job.failed,
    dryRun: !!job.dry_run, params: parse(job.params, {}),
    createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at,
    items: items.map((i) => ({
      seq: i.seq, target: i.target_id, label: i.label, status: i.status,
      response: parse(i.response, null), error: i.error, updatedAt: i.updated_at,
    })),
  };
}

export const listJobs = (limit = 30) =>
  getDb().prepare(`SELECT id, type, label, status, total, succeeded, failed, dry_run, created_at, finished_at
    FROM bulk_jobs WHERE shop_id IS ? ORDER BY created_at DESC LIMIT ?`)
    .all(activeShopId(), limit).map((j) => ({ ...j, dryRun: !!j.dry_run }));

export function cancelJob(id) {
  const control = running.get(id);
  if (control) control.cancel = true;
  getDb().prepare("UPDATE bulk_jobs SET status = 'canceled', finished_at = datetime('now') WHERE id = ? AND status IN ('queued','running')").run(id);
  return getJob(id);
}

/** Re-run only the items that failed, as a new job. */
export function retryFailed(id) {
  const job = getJob(id);
  const failed = job.items.filter((i) => i.status === 'error').map((i) => i.target);
  if (!failed.length) throw badRequest('That job has no failed items to retry.');
  return createJob({ type: job.type, targets: failed, params: job.params, label: `Retry: ${job.label}` });
}

export const actionCatalogue = () =>
  Object.entries(HANDLERS).map(([type, h]) => ({ type, label: h.label }));
