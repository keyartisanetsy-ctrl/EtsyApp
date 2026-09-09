/**
 * The draft desk: a listing you started on Etsy, finished here, and sent back.
 *
 * Etsy's own draft editor is slow to work in and has no memory of what you were
 * doing across listings. So the flow is:
 *
 *   1. A listing you created on Etsy - or here - is pulled down as a draft.
 *   2. You edit it here, across as many sittings as you like. Nothing you type
 *      touches Etsy.
 *   3. When it is ready you push it, and only then does Etsy see any of it.
 *
 * The staged edits live in their own table rather than on top of the mirrored
 * listing. That matters: it means the app can always show you what Etsy has and
 * what you changed, side by side, and it means an abandoned edit never quietly
 * becomes the truth.
 *
 * Pushing goes through the same write queue as everything else, so Etsy never
 * sees two writes from this app at once.
 */
import { getDb, json, parse, audit } from '../db/index.js';
import { activeShopId, requireShopId } from '../etsy/shop.js';
import { call } from '../etsy/client.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as listings from './listings.js';
import * as undo from './undo.js';

const log = createLogger('drafts');

/** The fields a draft carries. Anything not here is not editable from the app. */
export const EDITABLE = [
  'title', 'description', 'price', 'quantity', 'tags', 'materials',
  'taxonomy_id', 'who_made', 'when_made', 'is_supply', 'shop_section_id',
  'shipping_profile_id', 'return_policy_id', 'item_weight', 'item_length',
  'item_width', 'item_height', 'is_personalizable', 'personalization_instructions',
  'is_customizable', 'state',
];

const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * Bring drafts down from Etsy.
 *
 * Etsy keeps drafts out of the normal listing feed, so they are fetched by
 * state. Every draft it has becomes a row here; ones already open on the desk
 * keep whatever you had staged.
 */
export async function pullFromEtsy({ includeInactive = false } = {}) {
  const db = getDb();
  const shopId = requireShopId();
  const states = includeInactive ? ['draft', 'inactive'] : ['draft'];

  let seen = 0;
  let added = 0;
  for (const state of states) {
    let offset = 0;
    for (;;) {
      const res = await call('getListingsByShop', {
        shop_id: shopId, state, limit: 100, offset,
        includes: ['Images', 'Inventory'],
      });
      const rows = res?.results ?? [];
      if (!rows.length) break;

      for (const l of rows) {
        seen += 1;
        const exists = db.prepare('SELECT listing_id FROM listing_drafts WHERE listing_id = ?').get(l.listing_id);
        // Always refresh what Etsy has; never overwrite what you staged.
        db.prepare(`
          INSERT INTO listing_drafts (listing_id, shop_id, source, etsy_state, etsy_snapshot, staged, created_at, updated_at)
          VALUES (?,?,?,?,?,?, datetime('now'), datetime('now'))
          ON CONFLICT(listing_id) DO UPDATE SET
            etsy_state = excluded.etsy_state,
            etsy_snapshot = excluded.etsy_snapshot,
            updated_at = datetime('now')`)
          .run(l.listing_id, shopId, 'etsy', l.state ?? state, json(l), exists ? undefined : json({}));
        if (!exists) added += 1;
      }
      if (rows.length < 100) break;
      offset += 100;
    }
  }

  audit('drafts.pull', { detail: { seen, added } });
  return {
    seen,
    added,
    note: seen
      ? `${added} new draft(s) came down; the rest were already on the desk with your edits kept.`
      : 'Etsy has no drafts for this shop right now.',
  };
}

/** Start a draft here, without touching Etsy until it is pushed. */
export function createLocal(fields = {}) {
  const db = getDb();
  const shopId = activeShopId();
  // A negative id keeps a local-only draft apart from a real Etsy listing id,
  // so nothing can mistake one for the other.
  const nextLocal = (db.prepare('SELECT MIN(listing_id) AS m FROM listing_drafts').get()?.m ?? 0);
  const listingId = Math.min(-1, (nextLocal ?? 0) - 1);

  db.prepare(`
    INSERT INTO listing_drafts (listing_id, shop_id, source, etsy_state, etsy_snapshot, staged, created_at, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'), datetime('now'))`)
    .run(listingId, shopId, 'local', 'not on etsy', json({}), json(cleanFields(fields)));

  audit('drafts.create_local', { entity: 'listing', entityId: listingId });
  return get(listingId);
}

/** Keep only the fields a listing actually has, in the shape Etsy wants. */
function cleanFields(fields = {}) {
  const out = {};
  for (const key of EDITABLE) {
    if (!(key in fields)) continue;
    let value = fields[key];
    if (value === '' || value === undefined) continue;
    if (key === 'tags' || key === 'materials') value = asList(value);
    if (['price', 'quantity', 'taxonomy_id', 'shop_section_id', 'shipping_profile_id',
      'return_policy_id', 'item_weight', 'item_length', 'item_width', 'item_height'].includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      value = n;
    }
    out[key] = value;
  }
  return out;
}

/** One draft: what Etsy has, what you staged, and the two merged. */
export function get(listingId) {
  const row = getDb().prepare('SELECT * FROM listing_drafts WHERE listing_id = ? AND shop_id IS ?')
    .get(Number(listingId), activeShopId());
  if (!row) throw notFound(`No draft ${listingId} on the desk.`);

  const etsy = parse(row.etsy_snapshot, {}) ?? {};
  const staged = parse(row.staged, {}) ?? {};

  const fromEtsy = {
    title: etsy.title ?? '',
    description: etsy.description ?? '',
    price: etsy.price?.amount != null ? etsy.price.amount / (etsy.price.divisor || 100) : null,
    quantity: etsy.quantity ?? null,
    tags: etsy.tags ?? [],
    materials: etsy.materials ?? [],
    taxonomy_id: etsy.taxonomy_id ?? null,
    who_made: etsy.who_made ?? null,
    when_made: etsy.when_made ?? null,
    is_supply: etsy.is_supply ?? null,
    shop_section_id: etsy.shop_section_id ?? null,
    shipping_profile_id: etsy.shipping_profile_id ?? null,
    return_policy_id: etsy.return_policy_id ?? null,
    state: etsy.state ?? row.etsy_state,
  };

  // Which fields you actually changed, so the screen can mark them and the
  // push can send only those.
  const changed = Object.keys(staged).filter((k) => {
    const a = staged[k];
    const b = fromEtsy[k];
    return JSON.stringify(Array.isArray(a) ? [...a].sort() : a)
        !== JSON.stringify(Array.isArray(b) ? [...b].sort() : b);
  });

  return {
    listingId: row.listing_id,
    source: row.source,
    isLocalOnly: row.listing_id < 0,
    etsyState: row.etsy_state,
    pushedAt: row.pushed_at,
    pushError: row.push_error,
    etsy: fromEtsy,
    staged,
    // What would be live if you pushed now.
    merged: { ...fromEtsy, ...staged },
    changed,
    images: (etsy.images ?? []).map((i) => ({
      imageId: i.listing_image_id, rank: i.rank,
      url: i.url_fullxfull || i.url_570xN, thumb: i.url_75x75,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every draft on the desk. */
export function list({ includePushed = false } = {}) {
  const rows = getDb().prepare(`
    SELECT listing_id, source, etsy_state, staged, etsy_snapshot, pushed_at, push_error, updated_at
    FROM listing_drafts WHERE shop_id IS ?
    ${includePushed ? '' : "AND (pushed_at IS NULL OR etsy_state = 'draft')"}
    ORDER BY updated_at DESC`).all(activeShopId());

  return rows.map((r) => {
    const etsy = parse(r.etsy_snapshot, {}) ?? {};
    const staged = parse(r.staged, {}) ?? {};
    return {
      listingId: r.listing_id,
      isLocalOnly: r.listing_id < 0,
      source: r.source,
      etsyState: r.etsy_state,
      title: staged.title || etsy.title || '(untitled)',
      price: staged.price ?? (etsy.price?.amount != null ? etsy.price.amount / (etsy.price.divisor || 100) : null),
      imageUrl: etsy.images?.[0]?.url_570xN ?? etsy.images?.[0]?.url_fullxfull ?? null,
      stagedCount: Object.keys(staged).length,
      pushedAt: r.pushed_at,
      pushError: r.push_error,
      updatedAt: r.updated_at,
    };
  });
}

/** Stage an edit. Nothing goes to Etsy here. */
export function stage(listingId, fields = {}) {
  const db = getDb();
  const id = Number(listingId);
  const row = db.prepare('SELECT staged FROM listing_drafts WHERE listing_id = ? AND shop_id IS ?')
    .get(id, activeShopId());
  if (!row) throw notFound(`No draft ${listingId} on the desk.`);

  const handle = undo.begin({
    label: `Edit draft ${id}`,
    kind: 'draft.stage',
    targets: [{ table: 'listing_drafts', where: 'listing_id = ?', params: [id] }],
  });

  const staged = { ...(parse(row.staged, {}) ?? {}), ...cleanFields(fields) };
  // An explicit null clears a staged change and goes back to Etsy's value.
  for (const [k, v] of Object.entries(fields)) if (v === null) delete staged[k];

  db.prepare("UPDATE listing_drafts SET staged = ?, updated_at = datetime('now'), push_error = NULL WHERE listing_id = ?")
    .run(json(staged), id);
  undo.commit(handle, { affected: 1 });
  return get(id);
}

/** Throw away your edits and go back to what Etsy has. */
export function revert(listingId) {
  const id = Number(listingId);
  const handle = undo.begin({
    label: `Revert draft ${id}`,
    kind: 'draft.revert',
    targets: [{ table: 'listing_drafts', where: 'listing_id = ?', params: [id] }],
  });
  getDb().prepare("UPDATE listing_drafts SET staged = '{}', updated_at = datetime('now') WHERE listing_id = ? AND shop_id IS ?")
    .run(id, activeShopId());
  undo.commit(handle, { affected: 1 });
  return get(id);
}

/** Take a draft off the desk. Etsy keeps whatever it has. */
export function remove(listingId) {
  const id = Number(listingId);
  const handle = undo.begin({
    label: `Remove draft ${id} from the desk`,
    kind: 'draft.remove',
    targets: [{ table: 'listing_drafts', where: 'listing_id = ?', params: [id] }],
  });
  const n = getDb().prepare('DELETE FROM listing_drafts WHERE listing_id = ? AND shop_id IS ?')
    .run(id, activeShopId()).changes;
  undo.commit(handle, { affected: n });
  return { removed: n, listingId: id };
}

/**
 * What pushing would do, without doing it.
 *
 * Worth looking at: it names every field that will change and every check that
 * would stop the push, so a rejection from Etsy is not the first you hear of a
 * missing category.
 */
export function preview(listingId) {
  const draft = get(listingId);
  const merged = draft.merged;
  const problems = [];

  if (!merged.title?.trim()) problems.push('A title is required.');
  if (merged.title && merged.title.length > 140) problems.push(`The title is ${merged.title.length} characters; Etsy allows 140.`);
  if (!merged.description?.trim()) problems.push('A description is required.');
  if (merged.price == null || Number(merged.price) <= 0) problems.push('A price above zero is required.');
  if (!merged.taxonomy_id) problems.push('A category is required.');
  if (!merged.who_made) problems.push('"Who made it" is required.');
  if (!merged.when_made) problems.push('"When was it made" is required.');
  if ((merged.tags ?? []).length > 13) problems.push(`${merged.tags.length} tags; Etsy allows 13.`);
  if ((merged.tags ?? []).some((t) => t.length > 20)) problems.push('A tag is longer than 20 characters.');
  if (draft.isLocalOnly && !merged.shipping_profile_id) {
    problems.push('A new listing needs a shipping profile before Etsy will take it.');
  }

  return {
    listingId: draft.listingId,
    willChange: draft.changed,
    isNew: draft.isLocalOnly,
    problems,
    ready: problems.length === 0 && (draft.changed.length > 0 || draft.isLocalOnly),
    merged,
  };
}

/**
 * Send it to Etsy.
 *
 * A local-only draft is created there; one that came from Etsy is updated with
 * just the fields you changed. Both go through the write queue, one at a time.
 */
export async function push(listingId, { activate = false } = {}) {
  const db = getDb();
  const id = Number(listingId);
  const shopId = requireShopId();
  const plan = preview(id);

  if (plan.problems.length) {
    throw badRequest(`This draft is not ready: ${plan.problems[0]}`, { problems: plan.problems });
  }
  if (!plan.ready) throw badRequest('Nothing has changed, so there is nothing to send.');

  const draft = get(id);
  const body = { ...draft.merged };
  delete body.state;

  try {
    let result;
    if (draft.isLocalOnly) {
      result = await call('createDraftListing', { shop_id: shopId }, { body });
      // The desk row now belongs to a real Etsy listing.
      db.prepare(`UPDATE listing_drafts SET listing_id = ?, source = 'etsy', etsy_state = ?,
                  etsy_snapshot = ?, staged = '{}', pushed_at = datetime('now'), push_error = NULL
                  WHERE listing_id = ?`)
        .run(result.listing_id, result.state ?? 'draft', json(result), id);
      log.info(`draft ${id} became Etsy listing ${result.listing_id}`);
    } else {
      const onlyChanged = {};
      for (const key of draft.changed) onlyChanged[key] = draft.merged[key];
      result = await listings.updateListing(id, onlyChanged);
      db.prepare(`UPDATE listing_drafts SET etsy_snapshot = ?, staged = '{}',
                  pushed_at = datetime('now'), push_error = NULL, etsy_state = ?
                  WHERE listing_id = ?`)
        .run(json(result), result.state ?? draft.etsyState, id);
    }

    if (activate) {
      try { await listings.setState(result.listing_id ?? id, 'active'); }
      catch (err) { log.warn(`could not activate ${result.listing_id ?? id}: ${err.message}`); }
    }

    // A push is not ours to take back, but it belongs in the history.
    undo.recordExternal({
      label: `Sent draft ${result.listing_id ?? id} to Etsy`,
      kind: 'etsy.write',
      note: 'This is live on Etsy now. Edit it here and push again to change it.',
      affected: draft.changed.length || null,
    });
    audit('drafts.push', { entity: 'listing', entityId: result.listing_id ?? id, detail: { fields: draft.changed } });

    return {
      listingId: result.listing_id ?? id,
      created: draft.isLocalOnly,
      pushed: draft.changed,
      state: result.state ?? null,
      url: result.url ?? `https://www.etsy.com/listing/${result.listing_id ?? id}`,
    };
  } catch (err) {
    db.prepare('UPDATE listing_drafts SET push_error = ? WHERE listing_id = ?').run(err.message, id);
    throw err;
  }
}
