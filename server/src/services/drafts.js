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
import * as draftmedia from './draftmedia.js';
import * as undo from './undo.js';

const log = createLogger('drafts');

/** The fields a draft carries. Anything not here is not editable from the app. */
export const EDITABLE = [
  'title', 'description', 'price', 'quantity', 'tags', 'materials',
  'taxonomy_id', 'who_made', 'when_made', 'is_supply', 'shop_section_id',
  'shipping_profile_id', 'return_policy_id', 'item_weight', 'item_length',
  'item_width', 'item_height', 'is_personalizable', 'personalization_instructions',
  'is_customizable', 'state',
  // The rest of what Etsy's own spec accepts on a draft. Without these the app
  // could not set a processing time or a weight unit, and the listing had to be
  // finished on Etsy anyway - which defeats the point of the desk.
  'styles', 'processing_min', 'processing_max', 'readiness_state_id',
  'item_weight_unit', 'item_dimensions_unit', 'production_partner_ids',
  'should_auto_renew', 'is_taxable', 'type', 'image_ids',
  // Only takes effect once this exists on Etsy (updateListing, not
  // createDraftListing) -- the editor gates the field accordingly.
  'featured_rank',
];

// Etsy's own create-listing screen caps materials at 5 and quantity at 999
// (its client-side error reads "Enter a quantity from 1 and 999"); neither
// limit is written down in the API spec text, but the live form enforces
// both, so the desk does too rather than letting a push fail on them instead.
export const MAX_MATERIALS = 5;
export const MAX_QUANTITY = 999;

/** Etsy refuses a draft without these. Its spec, not a guess. */
export const REQUIRED = ['title', 'description', 'price', 'quantity', 'who_made', 'when_made', 'taxonomy_id'];

/** The units Etsy accepts, so the app cannot offer one it will reject. */
export const WEIGHT_UNITS = ['oz', 'lb', 'g', 'kg'];
export const DIMENSION_UNITS = ['in', 'ft', 'mm', 'cm', 'm', 'yd', 'inches'];

const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * Bring drafts down from Etsy.
 *
 * Etsy keeps drafts out of the normal listing feed, so they are fetched by
 * state. Every draft it has becomes a row here; ones already open on the desk
 * keep whatever you had staged.
 */
export async function pullFromEtsy({ includeInactive = false, caller = call } = {}) {
  const db = getDb();
  const shopId = requireShopId();
  const states = includeInactive ? ['draft', 'inactive'] : ['draft'];
  const seenIds = new Set();

  let seen = 0;
  let added = 0;
  for (const state of states) {
    let offset = 0;
    for (;;) {
      const res = await caller('getListingsByShop', {
        shop_id: shopId, state, limit: 100, offset,
        includes: ['Images', 'Videos', 'Inventory'],
      });
      const rows = res?.results ?? [];
      if (!rows.length) break;

      for (const l of rows) {
        seen += 1;
        seenIds.add(l.listing_id);
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

  // A row this pull did not see is not necessarily gone -- it may just have
  // moved to a state this pull did not ask for (active, say, if only drafts
  // were requested). Only a listing Etsy itself now says it cannot find is
  // actually deleted, so each one is checked directly rather than assumed.
  const candidates = db.prepare(
    `SELECT listing_id FROM listing_drafts WHERE shop_id IS ? AND source = 'etsy' AND listing_id > 0`,
  ).all(shopId).map((r) => r.listing_id).filter((id) => !seenIds.has(id));

  let removed = 0;
  for (const listingId of candidates) {
    try {
      await caller('getListing', { listing_id: listingId });
    } catch (err) {
      if (err.status === 404) {
        db.prepare('DELETE FROM listing_drafts WHERE listing_id = ?').run(listingId);
        removed += 1;
        log.info(`draft ${listingId} was deleted on Etsy; removed from the desk`);
      }
      // Any other error (rate limit, network) says nothing about whether the
      // listing still exists, so the row is left alone rather than guessed at.
    }
  }

  audit('drafts.pull', { detail: { seen, added, removed } });
  return {
    seen,
    added,
    removed,
    note: seen
      ? `${added} new draft(s) came down; the rest were already on the desk with your edits kept.${removed ? ` ${removed} removed here because Etsy no longer has them.` : ''}`
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
    if (key === 'styles') value = asList(value).slice(0, 2);       // Etsy allows two
    if (key === 'image_ids' || key === 'production_partner_ids') {
      value = asList(value).map(Number).filter(Boolean);
    }
    if (['price', 'quantity', 'taxonomy_id', 'shop_section_id', 'shipping_profile_id',
      'return_policy_id', 'item_weight', 'item_length', 'item_width', 'item_height',
      'processing_min', 'processing_max', 'readiness_state_id'].includes(key)) {
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
    videos: (etsy.videos ?? []).map((v) => ({
      videoId: v.video_id, url: v.video_url, thumb: v.thumbnail_url,
    })),
    // What is staged locally, waiting for this draft to become a real Etsy
    // listing. Empty for a draft that already is one -- from that point its
    // photos/video are uploaded straight away and live in the fields above.
    pendingMedia: row.listing_id < 0 ? draftmedia.list(row.listing_id) : null,
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
      imageUrl: etsy.images?.[0]?.url_570xN ?? etsy.images?.[0]?.url_fullxfull
        ?? (r.listing_id < 0 ? draftmedia.list(r.listing_id).images?.[0]?.url ?? null : null),
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

/**
 * Bring one draft's photos/video back in step with Etsy, without waiting for
 * the next full "Get drafts from Etsy".
 *
 * A draft that is already a real listing manages its images/video through the
 * ordinary listing endpoints, which upload straight away - but those write to
 * listing_images/listing_videos, not to this desk's own mirror of the
 * listing, so an upload made from here would otherwise not show up until the
 * next pull. This closes that gap right after such a change.
 */
export async function refreshSnapshot(listingId) {
  const id = Number(listingId);
  if (id < 0) return get(id); // nothing on Etsy yet for a local-only draft

  const db = getDb();
  const snapshot = await call('getListing', { listing_id: id, includes: ['Images', 'Videos', 'Shipping', 'Inventory'] });
  const prevRow = db.prepare('SELECT etsy_snapshot FROM listing_drafts WHERE listing_id = ?').get(id);
  const prevSnapshot = parse(prevRow?.etsy_snapshot, {}) ?? {};
  db.prepare("UPDATE listing_drafts SET etsy_snapshot = ?, updated_at = datetime('now') WHERE listing_id = ?")
    .run(json({ ...prevSnapshot, ...snapshot }), id);
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
  // Cleared explicitly (not just left to the ON DELETE CASCADE below) so a
  // photo uploaded from this machine has its file removed too, not just its
  // row -- the cascade only reaches the database.
  draftmedia.clear(id);
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

  // Etsy's spec requires quantity on a draft. The preview never checked it, so a
  // draft with no stock passed here and was refused by Etsy instead.
  if (merged.quantity == null || Number(merged.quantity) < 1) {
    problems.push('A quantity of at least 1 is required.');
  } else if (Number(merged.quantity) > MAX_QUANTITY) {
    problems.push(`Quantity is ${merged.quantity}; Etsy allows ${MAX_QUANTITY}.`);
  }
  if ((merged.materials ?? []).length > MAX_MATERIALS) {
    problems.push(`${merged.materials.length} materials; Etsy allows ${MAX_MATERIALS}.`);
  }
  if (!merged.title?.trim()) problems.push('A title is required.');
  if (merged.title && merged.title.length > 140) problems.push(`The title is ${merged.title.length} characters; Etsy allows 140.`);
  // Etsy's title rule: %, :, & and + may each appear only once.
  for (const ch of ['%', ':', '&', '+']) {
    const n = (merged.title ?? '').split(ch).length - 1;
    if (n > 1) problems.push(`The title uses "${ch}" ${n} times; Etsy allows it once.`);
  }
  if (!merged.description?.trim()) problems.push('A description is required.');
  if (merged.price == null || Number(merged.price) <= 0) problems.push('A price above zero is required.');
  if (!merged.taxonomy_id) problems.push('A category is required.');
  if (!merged.who_made) problems.push('"Who made it" is required.');
  if (!merged.when_made) problems.push('"When was it made" is required.');
  if ((merged.tags ?? []).length > 13) problems.push(`${merged.tags.length} tags; Etsy allows 13.`);
  if ((merged.tags ?? []).some((t) => t.length > 20)) problems.push('A tag is longer than 20 characters.');
  // Etsy: "Required when listing type is physical".
  const isPhysical = (merged.type ?? 'physical') === 'physical';
  if (draft.isLocalOnly && isPhysical && !merged.shipping_profile_id) {
    problems.push('A physical listing needs a shipping profile before Etsy will take it.');
  }
  // Etsy's spec marks readiness_state_id optional, but the live API answers
  // "A readiness_state_id is required for physical listings." Trust the API.
  if (draft.isLocalOnly && isPhysical && !merged.readiness_state_id) {
    problems.push('A physical listing needs a processing profile (how long it takes you to dispatch). Pick one below.');
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
export async function push(listingId, { activate = false, caller = call } = {}) {
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

  let media = null;
  try {
    let result;
    if (draft.isLocalOnly) {
      result = await caller('createDraftListing', { shop_id: shopId }, { body });
      const newId = result.listing_id;

      // Etsy hands out the listing_id only now, so photos/video staged before
      // this point could not be uploaded until this moment - do that first,
      // then ask Etsy for the whole listing back so the snapshot this app
      // shows actually carries them, instead of the bare create response.
      media = await draftmedia.pushToEtsy(id, newId);
      let snapshot = result;
      try {
        snapshot = await caller('getListing', { listing_id: newId, includes: ['Images', 'Videos', 'Shipping', 'Inventory'] });
      } catch (err) { log.warn(`could not re-fetch listing ${newId} with images/video after creating it: ${err.message}`); }

      // The desk row now belongs to a real Etsy listing. Any staged photo/video
      // that failed to upload is still parented on the old id at this point
      // (draftmedia leaves it there rather than guessing where it is going),
      // so it and the listing_drafts row itself have to be re-keyed to newId
      // together. Neither statement is valid on its own -- moving the media
      // row first points it at a listing_drafts row that does not exist yet,
      // and moving the parent first orphans whatever media is still on the
      // old id -- so foreign key checks are deferred to the end of this one
      // transaction, where both sides agree again.
      db.transaction(() => {
        db.pragma('defer_foreign_keys = ON');
        db.prepare('UPDATE draft_media SET listing_id = ? WHERE listing_id = ?').run(newId, id);
        db.prepare(`UPDATE listing_drafts SET listing_id = ?, source = 'etsy', etsy_state = ?,
                    etsy_snapshot = ?, staged = '{}', pushed_at = datetime('now'), push_error = NULL
                    WHERE listing_id = ?`)
          .run(newId, result.state ?? 'draft', json(snapshot), id);
      })();
      log.info(`draft ${id} became Etsy listing ${newId}`);
    } else {
      const onlyChanged = {};
      for (const key of draft.changed) onlyChanged[key] = draft.merged[key];
      result = await listings.updateListing(id, onlyChanged, { caller });
      // updateListing's response is the bare ShopListing - it carries none of
      // the association fields (images, videos, inventory...) a pulled draft
      // has, because none of those were asked for or changed. Overwriting the
      // snapshot with it wholesale silently wiped them out; merge instead, so
      // only the fields Etsy actually returned move, and photos already on
      // the listing do not vanish from this screen just because the title
      // was edited.
      const prevRow = db.prepare('SELECT etsy_snapshot FROM listing_drafts WHERE listing_id = ?').get(id);
      const prevSnapshot = parse(prevRow?.etsy_snapshot, {}) ?? {};
      db.prepare(`UPDATE listing_drafts SET etsy_snapshot = ?, staged = '{}',
                  pushed_at = datetime('now'), push_error = NULL, etsy_state = ?
                  WHERE listing_id = ?`)
        .run(json({ ...prevSnapshot, ...result }), result.state ?? draft.etsyState, id);
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
      media,
    };
  } catch (err) {
    db.prepare('UPDATE listing_drafts SET push_error = ? WHERE listing_id = ?').run(err.message, id);
    throw err;
  }
}

/**
 * The choices this shop actually offers, for the fields that are numeric ids.
 *
 * Etsy asks for a shipping profile, a processing profile, a section and a
 * return policy by id. Nobody knows those by heart, and typing one wrong is how
 * you get a 400 from Etsy after filling in a whole listing. So the desk fetches
 * the real ones and offers them as lists.
 *
 * Each part is fetched independently: a shop with no return policies should
 * still get its shipping profiles, rather than the whole panel failing.
 */
export async function shopChoices() {
  const shopId = requireShopId();
  const out = {};

  const settle = async (name, fn, fallback = []) => {
    try { out[name] = await fn(); }
    catch (err) { out[name] = fallback; out[`${name}Error`] = err.message; }
  };

  await Promise.all([
    settle('shippingProfiles', async () => {
      const r = await call('getShopShippingProfiles', { shop_id: shopId });
      return (r?.results ?? []).map((p) => ({
        id: p.shipping_profile_id,
        title: p.title,
        // What the buyer is told, which is what makes one profile the right one.
        processing: p.processing_days_display_label
          ?? [p.min_processing_days, p.max_processing_days].filter((n) => n != null).join('–'),
        origin: p.origin_country_iso,
      }));
    }),

    // The one Etsy refuses a physical listing without, whatever its spec says.
    settle('processingProfiles', async () => {
      const r = await call('getShopReadinessStateDefinitions', { shop_id: shopId, limit: 100 });
      return (r?.results ?? []).map((p) => ({
        id: p.readiness_state_id,
        readinessState: p.readiness_state,
        label: p.processing_days_display_label
          ?? [p.min_processing_days, p.max_processing_days].filter((n) => n != null).join('–'),
        minDays: p.min_processing_days,
        maxDays: p.max_processing_days,
      }));
    }),

    settle('sections', async () => {
      const r = await call('getShopSections', { shop_id: shopId });
      return (r?.results ?? []).map((s) => ({ id: s.shop_section_id, title: s.title }));
    }),

    settle('returnPolicies', async () => {
      const r = await call('getShopReturnPolicies', { shop_id: shopId });
      return (r?.results ?? []).map((p) => ({
        id: p.return_policy_id,
        accepts: !!p.accepts_returns,
        days: p.return_deadline,
      }));
    }),
  ]);

  return {
    ...out,
    // Said here so the screen can offer to make one rather than dead-ending.
    needsProcessingProfile: !out.processingProfiles?.length,
    note: out.processingProfiles?.length
      ? null
      : 'This shop has no processing profile yet. Etsy will not take a physical listing without one - make one below and it becomes the default for new drafts.',
  };
}

/**
 * Make a processing profile, for a shop that has none.
 *
 * Etsy's error for a missing one names a field but not how to get it, which
 * leaves you clicking around the seller dashboard. This makes one from the two
 * numbers you actually know.
 */
export async function createProcessingProfile({ minDays = 1, maxDays = 3,
  readinessState = 'made_to_order', unit = 'days' } = {}) {
  const shopId = requireShopId();
  const res = await call('createShopReadinessStateDefinition', { shop_id: shopId }, {
    body: {
      readiness_state: readinessState,
      min_processing_time: Number(minDays),
      max_processing_time: Number(maxDays),
      processing_time_unit: unit,
    },
  });
  audit('drafts.processing_profile', { detail: { minDays, maxDays, readinessState } });
  return {
    id: res?.readiness_state_id ?? res?.results?.[0]?.readiness_state_id ?? null,
    ...res,
  };
}
