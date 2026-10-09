/**
 * What the photo reader has been taught, and how it has been told what the shop wants.
 *
 *   instructions  a few sentences the seller wrote once ("the warehouse often splits one
 *                 product across several trays - group them"); every photo look is told them.
 *   lessons       one plain sentence per decision the seller made by hand (these two boxes
 *                 were one product); the latest few are told to the AI too, so it makes the
 *                 same call next time.
 *   looks         the colour fingerprint of the warehouse's photo of each confirmed match,
 *                 kept per product (SKU, or the listing picture when it has none). The free
 *                 matcher compares a new photo with these as well as with the listing photo,
 *                 because the warehouse never photographs a product the way its listing does.
 *
 * Nothing here calls out: it only reads and writes this app's own database.
 */
import { getDb } from '../db/index.js';
import { readSetting, writeSetting } from './settings.js';
import { signatureFor, similarity } from './imagesig.js';

const MAX_LESSONS = 40;
const LESSONS_TOLD = 8;
const MAX_LOOKS_PER_ITEM = 6;

// ------------------------------------------------------------- instructions

export const instructions = () => String(readSetting('packing.instructions') || '').trim();

export function setInstructions(text) {
  writeSetting('packing.instructions', String(text ?? '').trim().slice(0, 2000));
  return instructions();
}

// ------------------------------------------------------------------ lessons

export function listLessons() {
  return getDb().prepare('SELECT id, text, created_at FROM packing_lessons ORDER BY id DESC LIMIT ?').all(MAX_LESSONS);
}

export function addLesson(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!line) return null;
  const db = getDb();
  if (db.prepare('SELECT 1 FROM packing_lessons WHERE text = ?').get(line)) return null;
  db.prepare('INSERT INTO packing_lessons (text) VALUES (?)').run(line);
  db.prepare(`DELETE FROM packing_lessons WHERE id NOT IN (SELECT id FROM packing_lessons ORDER BY id DESC LIMIT ?)`).run(MAX_LESSONS);
  return line;
}

export function clearLessons() {
  getDb().prepare('DELETE FROM packing_lessons').run();
  return { cleared: true };
}

/** The lines every photo look is told: the seller's own words first, then what was learned from their corrections. */
export function guidance() {
  const parts = [];
  const mine = instructions();
  if (mine) parts.push(`THE SELLER'S OWN INSTRUCTIONS (follow them):\n${mine}`);
  const taught = listLessons().slice(0, LESSONS_TOLD);
  if (taught.length) parts.push(`DECISIONS THE SELLER MADE BY HAND BEFORE (make the same call when it applies):\n${taught.map((l) => `- ${l.text}`).join('\n')}`);
  return parts.join('\n\n');
}

// -------------------------------------------------------------------- looks

/** Which product an order line is, for remembering how its warehouse photos look: SKU first, else the listing picture. */
export const itemKey = ({ sku, imageUrl }) => {
  if (sku && String(sku).trim()) return `sku:${String(sku).trim().toLowerCase()}`;
  return imageUrl ? `img:${imageUrl}` : null;
};

/** Remember how this photo of a product looked. Fine to call for any photo; a photo that cannot be read adds nothing. */
export function rememberLook({ key, attachmentId, parcelId = null }) {
  if (!key || !attachmentId) return false;
  const sig = signatureFor(attachmentId);
  if (!sig) return false;
  const db = getDb();
  db.prepare('INSERT INTO parcel_looks (item_key, signature, parcel_id) VALUES (?,?,?)').run(key, JSON.stringify(sig), parcelId);
  db.prepare(`DELETE FROM parcel_looks WHERE item_key = ? AND id NOT IN
              (SELECT id FROM parcel_looks WHERE item_key = ? ORDER BY id DESC LIMIT ?)`).run(key, key, MAX_LOOKS_PER_ITEM);
  return true;
}

export function forgetLooks(parcelId) {
  if (parcelId == null) return;
  getDb().prepare('DELETE FROM parcel_looks WHERE parcel_id = ?').run(parcelId);
}

/** The best resemblance between a photo's fingerprint and the remembered looks of this product (null when none are kept). */
export function bestLookSimilarity(sig, key) {
  if (!sig || !key) return null;
  let best = null;
  for (const row of getDb().prepare('SELECT signature FROM parcel_looks WHERE item_key = ?').all(key)) {
    let known = null;
    try { known = JSON.parse(row.signature); } catch { continue; }
    const sim = similarity(sig, known);
    if (sim != null && (best == null || sim > best)) best = sim;
  }
  return best;
}

export const lookCount = () => getDb().prepare('SELECT COUNT(*) AS c FROM parcel_looks').get().c;
