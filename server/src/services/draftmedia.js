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
import { createLogger } from '../lib/logger.js';
import * as listings from './listings.js';

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

  const info = getDb().prepare(`
    INSERT INTO draft_media (listing_id, kind, rank, source_url, alt_text)
    VALUES (?,?,?,?,?)`)
    .run(id, kind, nextRank(id, kind), String(url), String(altText || '').slice(0, 500));
  return shape(getDb().prepare('SELECT * FROM draft_media WHERE id = ?').get(info.lastInsertRowid));
}

/** Stage a photo/video uploaded from this machine. */
export function addUpload(listingId, { kind, buffer, filename, mime, altText = '' } = {}) {
  const id = Number(listingId);
  if (!['image', 'video'].includes(kind)) throw badRequest('kind must be "image" or "video".');
  if (!buffer?.length) throw badRequest('No file was received.');
  assertRoom(id, kind);

  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename || '') || (kind === 'image' ? '.jpg' : '.mp4');
  const stored = `${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);

  const info = getDb().prepare(`
    INSERT INTO draft_media (listing_id, kind, rank, file_path, filename, mime, alt_text)
    VALUES (?,?,?,?,?,?,?)`)
    .run(id, kind, nextRank(id, kind), path.join(dir, stored), filename || stored,
         mime || (kind === 'image' ? 'image/jpeg' : 'video/mp4'), String(altText || '').slice(0, 500));
  return shape(getDb().prepare('SELECT * FROM draft_media WHERE id = ?').get(info.lastInsertRowid));
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
  if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch { /* already gone */ } }
  db.prepare('DELETE FROM draft_media WHERE id = ?').run(row.id);
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

  db.transaction(() => {
    db.prepare('UPDATE draft_media SET rank = ? WHERE id = ?').run(neighbour.rank, row.id);
    db.prepare('UPDATE draft_media SET rank = ? WHERE id = ?').run(row.rank, neighbour.id);
  })();
  return list(listingId);
}

/** Drop everything staged for a draft -- used when Product Studio resends the same product. */
export function clear(listingId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM draft_media WHERE listing_id = ?').all(Number(listingId));
  for (const row of rows) if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch { /* already gone */ } }
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
      const buffer = row.file_path
        ? fs.readFileSync(row.file_path)
        : Buffer.from(await (await outboundFetch(row.source_url)).arrayBuffer());
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
      // Re-key survivors onto the real listing so they are not orphaned under
      // an id that no longer exists, and can be retried from the draft screen.
      db.prepare('UPDATE draft_media SET listing_id = ? WHERE id = ?').run(realListingId, row.id);
    }
  }
  return result;
}
