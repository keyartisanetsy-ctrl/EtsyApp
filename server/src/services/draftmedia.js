/**
 * Photos and a video for a draft that does not exist on Etsy yet.
 *
 * Every image/video endpoint Etsy has takes a listing_id, and a local-only
 * draft does not have one -- Etsy only hands one out once createDraftListing
 * runs. So a photo that arrives before that (from Product Studio, or added
 * here by hand) is held here, in order, and uploaded the moment the draft
 * becomes a real listing. From then on listing_images / listing_videos are
 * the source of truth, same as any listing that started on Etsy.
 *
 * Etsy's own spec for createDraftListing/updateListing says image_ids "can
 * include up to 20 images" -- that number is taken from there, not guessed.
 * Its videos field, by contrast, is documented as "the single video
 * associated with a listing" even though it is typed as an array; a second
 * slot is offered here anyway because that is what was asked for, but Etsy
 * may refuse it, and that refusal is surfaced rather than hidden.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { outboundFetch } from '../lib/outbound.js';
import { forEtsy, pictureKind } from '../lib/picture.js';
import { createLogger } from '../lib/logger.js';
import * as listings from './listings.js';
import * as undo from './undo.js';

const log = createLogger('draft-media');

export const MAX_IMAGES = 20;
export const MAX_VIDEOS = 2;

const storeDir = () => path.join(config.uploadDir, 'draft-media');

const previewUrl = (row) => (row.file_path
  ? `/api/drafts/${row.listing_id}/media/${row.id}/file`
  : row.source_url);

const shape = (row) => ({
  id: row.id,
  kind: row.kind,
  rank: row.rank,
  altText: row.alt_text || '',
  filename: row.filename || null,
  url: previewUrl(row),
});

/** Everything staged for one draft, split by kind. */
export function list(listingId) {
  const rows = getDb().prepare(
    'SELECT * FROM draft_media WHERE listing_id = ? ORDER BY kind, rank, id',
  ).all(Number(listingId));
  return {
    images: rows.filter((r) => r.kind === 'image').map(shape),
    videos: rows.filter((r) => r.kind === 'video').map(shape),
    maxImages: MAX_IMAGES,
    maxVideos: MAX_VIDEOS,
  };
}

function nextRank(listingId, kind) {
  const row = getDb().prepare(
    'SELECT MAX(rank) AS m FROM draft_media WHERE listing_id = ? AND kind = ?',
  ).get(Number(listingId), kind);
  return (row?.m ?? 0) + 1;
}

function countOf(listingId, kind) {
  return getDb().prepare(
    'SELECT COUNT(*) AS c FROM draft_media WHERE listing_id = ? AND kind = ?',
  ).get(Number(listingId), kind).c;
}

function assertRoom(listingId, kind) {
  const max = kind === 'image' ? MAX_IMAGES : MAX_VIDEOS;
  const have = countOf(listingId, kind);
  if (have >= max) {
    throw badRequest(kind === 'image'
      ? `Etsy allows up to ${MAX_IMAGES} images on a listing, and this draft already has ${have}.`
      : `This draft already has ${have} video(s). Etsy's own listing page for a video says it holds a single one, so a second may be refused when this draft is sent -- ${MAX_VIDEOS} slots are offered here in case that changes.`);
  }
}

/** Stage a photo/video that lives somewhere public (Product Studio, a pasted link). */
export function addUrl(listingId, { kind, url, altText = '' } = {}) {
  const id = Number(listingId);
  if (!['image', 'video'].includes(kind)) throw badRequest('kind must be "image" or "video".');
  if (!/^https?:\/\//i.test(String(url ?? ''))) throw badRequest('That does not look like a URL.');
  assertRoom(id, kind);

  const handle = undo.begin({ label: `${kind === 'image' ? 'Picture' : 'Video'} added to a draft by its link`, kind: 'draft.media', targets: [{ table: 'draft_media', where: 'listing_id = ?', params: [id] }] });
  const info = getDb().prepare(`
    INSERT INTO draft_media (listing_id, kind, rank, source_url, alt_text)
    VALUES (?,?,?,?,?)`)
    .run(id, kind, nextRank(id, kind), String(url), String(altText || '').slice(0, 500));
  undo.commit(handle, { affected: 1 });
  return shape(getDb().prepare('SELECT * FROM draft_media WHERE id = ?').get(info.lastInsertRowid));
}

/** Stage a photo/video uploaded from this machine. */
export async function addUpload(listingId, { kind, buffer, filename, mime, altText = '', label = '', undoNote = null } = {}) {
  const id = Number(listingId);
  if (!['image', 'video'].includes(kind)) throw badRequest('kind must be "image" or "video".');
  if (!buffer?.length) throw badRequest('No file was received.');
  assertRoom(id, kind);
  if (kind === 'image') {   // Etsy takes JPEG/PNG/GIF - a WebP is converted now so what is shown is what is sent
    const pic = await forEtsy(buffer, filename);
    buffer = pic.buffer; filename = pic.filename; mime = pic.mime;
  }

  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename || '') || (kind === 'image' ? '.jpg' : '.mp4');
  const stored = `${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);

  const handle = undo.begin({ label: label || `${kind === 'image' ? 'Picture' : 'Video'} added to a draft`, kind: 'draft.media', note: undoNote, targets: [{ table: 'draft_media', where: 'listing_id = ?', params: [id] }] });
  const info = getDb().prepare(`
    INSERT INTO draft_media (listing_id, kind, rank, file_path, filename, mime, alt_text)
    VALUES (?,?,?,?,?,?,?)`)
    .run(id, kind, nextRank(id, kind), path.join(dir, stored), filename || stored,
         mime || (kind === 'image' ? 'image/jpeg' : 'video/mp4'), String(altText || '').slice(0, 500));
  undo.commit(handle, { affected: 1 });
  return shape(getDb().prepare('SELECT * FROM draft_media WHERE id = ?').get(info.lastInsertRowid));
}

/**
 * A picture added by its link is copied here and served from this app (not from wherever it was found), so it stays
 * the same whatever happens to the link, and it is this copy that goes to Etsy. The link is only remembered as where
 * it came from.
 */
export async function fetchPicture(url) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) throw badRequest('That does not look like a link to a picture.');
  let res;
  try { res = await outboundFetch(String(url), { headers: { Accept: 'image/jpeg,image/png,image/gif,image/*;q=0.8' } }); } catch (err) { throw badRequest(`The picture could not be fetched: ${err.message}`); }
  if (!res.ok) throw badRequest(`The picture could not be fetched (${res.status}). Is the link public?`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) throw badRequest('That picture is over 20 MB.');
  if (!pictureKind(buffer)) throw badRequest('That link is not a picture - open it in a browser and copy the picture address itself.');
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { /* none */ }
  name = name.replace(/[^\w.-]+/g, '-').replace(/\.[A-Za-z0-9_]+$/, '').replace(/\.(jpe?g|png|gif|webp)_?$/i, '').slice(0, 60) || 'image';
  // a WebP (or AVIF...) is turned into JPEG/PNG here, because Etsy only takes those
  const pic = await forEtsy(buffer, name);
  return { buffer: pic.buffer, mime: pic.mime, filename: pic.filename, converted: pic.converted, from: pic.from };
}

export { pictureKind };

/** Put a different picture where this one is, keeping its place in the order. */
export async function replaceImage(listingId, mediaId, { buffer, filename, mime, note = '' } = {}) {
  const db = getDb();
  { const pic = await forEtsy(buffer, filename); buffer = pic.buffer; filename = pic.filename; mime = pic.mime; }
  const row = db.prepare("SELECT * FROM draft_media WHERE id = ? AND listing_id = ? AND kind = 'image'").get(Number(mediaId), Number(listingId));
  if (!row) throw notFound('That picture is not staged on this draft.');
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename || '') || '.png';
  const stored = path.join(dir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
  fs.writeFileSync(stored, buffer);
  // the picture it replaces stays on disk (and in the undo entry) so the replacement can be taken back
  const handle = undo.begin({
    label: note || 'Draft picture replaced', kind: 'draft.media', note: 'Puts the earlier picture back in its place; the new one is dropped.',
    targets: [{ table: 'draft_media', where: 'listing_id = ?', params: [row.listing_id] }],
  });
  db.prepare('UPDATE draft_media SET file_path = ?, filename = ?, mime = ?, source_url = NULL WHERE id = ?').run(stored, filename || path.basename(stored), mime || 'image/png', row.id);
  undo.commit(handle, { affected: 1 });
  return shape(db.prepare('SELECT * FROM draft_media WHERE id = ?').get(row.id));
}

/** The file on disk for a stored-upload row, for the route that serves it back. */
export function fileFor(listingId, mediaId) {
  const row = getDb().prepare('SELECT * FROM draft_media WHERE id = ? AND listing_id = ?')
    .get(Number(mediaId), Number(listingId));
  if (!row?.file_path || !fs.existsSync(row.file_path)) throw notFound('That file is not on this machine.');
  return { path: row.file_path, mime: row.mime || 'application/octet-stream' };
}

export function remove(listingId, mediaId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM draft_media WHERE id = ? AND listing_id = ?')
    .get(Number(mediaId), Number(listingId));
  if (!row) throw notFound('That photo/video is not staged on this draft.');
  // the file stays on disk so the removal can be taken back; sweepFiles() clears it once nothing can bring it back
  const handle = undo.begin({ label: `${row.kind === 'image' ? 'Picture' : 'Video'} removed from a draft`, kind: 'draft.media', targets: [{ table: 'draft_media', where: 'listing_id = ?', params: [row.listing_id] }] });
  db.prepare('DELETE FROM draft_media WHERE id = ?').run(row.id);
  undo.commit(handle, { affected: 1 });
  return { removed: row.id };
}

/** Swap one item's position with its neighbour, so rank stays a clean 1..n. */
export function move(listingId, mediaId, direction) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM draft_media WHERE id = ? AND listing_id = ?')
    .get(Number(mediaId), Number(listingId));
  if (!row) throw notFound('That photo/video is not staged on this draft.');

  const neighbour = db.prepare(`
    SELECT * FROM draft_media WHERE listing_id = ? AND kind = ? AND rank ${direction === 'up' ? '<' : '>'} ?
    ORDER BY rank ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1`)
    .get(row.listing_id, row.kind, row.rank);
  if (!neighbour) return list(listingId);

  const handle = undo.begin({ label: 'Picture moved on a draft', kind: 'draft.media', targets: [{ table: 'draft_media', where: 'listing_id = ?', params: [row.listing_id] }] });
  db.transaction(() => {
    db.prepare('UPDATE draft_media SET rank = ? WHERE id = ?').run(neighbour.rank, row.id);
    db.prepare('UPDATE draft_media SET rank = ? WHERE id = ?').run(row.rank, neighbour.id);
  })();
  undo.commit(handle, { affected: 2 });
  return list(listingId);
}

/** Drop everything staged for a draft -- used when Product Studio resends the same product. */
export function clear(listingId, { keepFiles = false } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM draft_media WHERE listing_id = ?').all(Number(listingId));
  if (!keepFiles) for (const row of rows) if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch { /* already gone */ } }
  db.prepare('DELETE FROM draft_media WHERE listing_id = ?').run(Number(listingId));
}

/**
 * Upload everything staged for a draft that just became a real Etsy listing,
 * in rank order, then drop the staging rows -- listing_images/listing_videos
 * carry them from here on.
 */
export async function pushToEtsy(localListingId, realListingId) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM draft_media WHERE listing_id = ? ORDER BY kind, rank, id',
  ).all(Number(localListingId));

  const result = { uploadedImages: 0, uploadedVideos: 0, failed: [] };
  let imgRank = 1;
  for (const row of rows) {
    try {
      let buffer;
      if (row.file_path) buffer = fs.readFileSync(row.file_path);
      else {
        // a picture kept as a link is fetched now, as a JPEG/PNG where the host allows it
        const res = await outboundFetch(row.source_url, { headers: { Accept: row.kind === 'image' ? 'image/jpeg,image/png,image/gif,image/*;q=0.8' : '*/*' } });
        if (!res.ok) throw new Error(`the link answered ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
      }
      if (row.kind === 'image') {
        await listings.uploadImage(realListingId, {
          buffer, filename: row.filename || `image-${imgRank}.jpg`, mime: row.mime, rank: imgRank, altText: row.alt_text,
        });
        imgRank += 1;
        result.uploadedImages += 1;
      } else {
        await listings.uploadVideo(realListingId, {
          buffer, filename: row.filename || 'video.mp4', mime: row.mime, name: row.filename,
        });
        result.uploadedVideos += 1;
      }
      if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch { /* already gone */ } }
      db.prepare('DELETE FROM draft_media WHERE id = ?').run(row.id);
    } catch (err) {
      log.warn(`listing ${realListingId}: could not upload staged ${row.kind} ${row.id}: ${err.message}`);
      result.failed.push({ id: row.id, kind: row.kind, error: err.message });
      // Left under localListingId, not re-keyed here: the listing_drafts row
      // it points at only becomes realListingId once every upload has been
      // attempted, and moving this row there first would reference a parent
      // row that does not exist yet -- SQLite's foreign key rejects that
      // immediately. The caller re-keys whatever survives here, together
      // with the parent row, in one transaction once this function returns.
    }
  }
  return result;
}

/**
 * Delete staged files nothing refers to any more: not a picture on a draft, not something an undo entry could bring
 * back (or restore to Etsy), not an edit still waiting for a decision. Only files over an hour old are looked at.
 */
export function sweepFiles({ keep = [] } = {}) {
  const dirs = [storeDir(), path.join(storeDir(), 'ai-edits')];
  const db = getDb();
  const used = new Set(db.prepare('SELECT file_path FROM draft_media WHERE file_path IS NOT NULL').all().map((r) => r.file_path));
  const memory = db.prepare('SELECT snapshots, detail FROM undo_log').all().map((r) => `${r.snapshots ?? ''}${r.detail ?? ''}`).join('\n');
  let removed = 0;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || Date.now() - st.mtimeMs < 3_600_000) continue;
        if (used.has(file) || keep.includes(file) || memory.includes(JSON.stringify(file).slice(1, -1))) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch { /* leave it */ }
    }
  }
  return removed;
}

/**
 * A picture found at a link, put on a draft that already is a real Etsy listing: copied once and uploaded to Etsy at
 * once (Etsy only takes uploaded files). Taking it back deletes that picture on Etsy again.
 */
export async function addUrlToEtsy(listingId, url, altText = '') {
  const id = Number(listingId);
  const pic = await fetchPicture(url);
  const have = getDb().prepare('SELECT COUNT(*) AS c FROM listing_images WHERE listing_id = ?').get(id).c;
  if (have >= MAX_IMAGES) throw badRequest(`Etsy allows up to ${MAX_IMAGES} images on a listing, and this one already has ${have}.`);
  const res = await listings.uploadImage(id, { buffer: pic.buffer, filename: pic.filename, mime: pic.mime, rank: have + 1, altText });
  const imageId = res?.listing_image_id ?? null;
  if (imageId) {
    undo.commit(undo.begin({
      label: 'Picture added to an Etsy draft by its link', kind: 'draft.picture.etsy',
      note: 'Also changes Etsy: the picture is deleted from the listing there.',
    }), { affected: 1, detail: { handler: 'draftPicture.deleteImage', args: { listingId: id, imageId } } });
  }
  return { uploaded: true, imageId };
}
