import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, driverKind } from './driver.js';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';
import { seal, open as unseal } from '../lib/crypto.js';

const log = createLogger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

let db;

/** Opening the driver is async, so the app initialises it once at boot and
 *  every later getDb() call is synchronous, as the rest of the code expects. */
export async function initDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = await openDatabase(config.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  seedDefaults(db);
  log.info(`ready at ${config.dbFile} (${driverKind()})`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database is not initialised yet - call initDb() during startup.');
  return db;
}

// ------------------------------------------------------------------ settings

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value, is_secret FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  return row.is_secret ? unseal(row.value, config.dataDir) : row.value;
}

export function setSetting(key, value, isSecret = false) {
  const stored = isSecret ? seal(value, config.dataDir) : String(value ?? '');
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret,
                                      updated_at = datetime('now')`,
    )
    .run(key, stored, isSecret ? 1 : 0);
  return value;
}

export const deleteSetting = (key) => getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);

/** Settings resolve DB-first, then .env, then the built-in default. */
export function resolveSetting(key, envValue, fallback = '') {
  const v = getSetting(key, null);
  if (v !== null && v !== '') return v;
  if (envValue) return envValue;
  return fallback;
}

// --------------------------------------------------------------------- misc

export function audit(action, { entity, entityId, status = 'ok', detail } = {}) {
  getDb()
    .prepare('INSERT INTO audit_log (action, entity, entity_id, status, detail) VALUES (?,?,?,?,?)')
    .run(action, entity ?? null, entityId == null ? null : String(entityId),
         status, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}

export const json = (v) => (v == null ? null : JSON.stringify(v));
export const parse = (v, fallback = null) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

/** Wrap a function so every statement inside runs in one transaction. */
export const tx = (fn) => getDb().transaction(fn);

// --------------------------------------------------------------- seed data

const DEFAULT_PROMPTS = [
  {
    name: 'Default customer reply',
    kind: 'reply',
    is_default: 1,
    body: `You are the customer-support voice of an Etsy shop. Write a reply to the buyer message below.

Rules:
- Warm, concise, human. No corporate filler, no emoji unless the buyer used them.
- Reply in the SAME language the buyer wrote in.
- Never invent facts. If a detail (tracking, delivery date, stock) is unknown, say what you will do and by when.
- If they are upset, acknowledge the problem in the first sentence before anything else.
- Close with one clear next step.
- Output the reply text only, ready to paste. No subject line, no preamble.`,
  },
  {
    name: 'Late delivery apology',
    kind: 'reply',
    body: `The buyer is asking about a late or stalled parcel. Apologise once, plainly.
State the current tracking status in one line, give a realistic next checkpoint,
and offer the shop's remedy (reship or refund) if it passes the stated window.
Same language as the buyer. Reply text only.`,
  },
  {
    name: 'Etsy SEO title',
    kind: 'title',
    is_default: 1,
    body: `Write Etsy listing titles for the product described below.

Constraints:
- Max 140 characters, front-load the two highest-intent keywords.
- Read as a phrase a human would search, not a keyword dump. Separate ideas with commas or |.
- No ALL CAPS, no emoji, no "best"/"cheap", no trademarked brand names you were not given.
- Include material, recipient or occasion when they are known.
Return exactly 5 numbered options, best first, nothing else.`,
  },
  {
    name: 'Etsy description',
    kind: 'description',
    is_default: 1,
    body: `Write an Etsy listing description for the product below.

Shape:
1. One-sentence hook naming what it is and who it is for.
2. Short paragraph on the feel and the making.
3. "Details" bullet list: materials, dimensions, what is included.
4. "Shipping & processing" line, generic unless given specifics.
5. One-line close inviting a question.

Plain text with line breaks (Etsy strips HTML). No invented certifications, sizes, or claims.`,
  },
  {
    name: 'Etsy tags (13)',
    kind: 'tags',
    is_default: 1,
    body: `Produce exactly 13 Etsy tags for the product below.

Hard rules from Etsy: each tag <= 20 characters, lowercase, no punctuation other than spaces
and hyphens, no duplicated words across tags where avoidable, no single-word tags that are
already dominant in the title. Mix: 4 broad, 6 mid long-tail, 3 occasion/recipient.
Return a comma-separated list on one line, nothing else.`,
  },
  {
    name: 'Full listing from product notes',
    kind: 'listing',
    is_default: 1,
    body: `You are building a complete Etsy listing from raw product notes and photos.

Return STRICT JSON, no markdown fence, matching exactly:
{
  "title": "<=140 chars",
  "description": "plain text with line breaks",
  "tags": ["13 tags, each <=20 chars"],
  "materials": ["up to 13"],
  "who_made": "i_did|someone_else|collective",
  "when_made": "made_to_order|2020_2026|...",
  "is_supply": false,
  "item_weight": null, "item_weight_unit": "g",
  "item_length": null, "item_width": null, "item_height": null, "item_dimensions_unit": "cm",
  "price_suggestion": 0.00,
  "taxonomy_suggestion": "human readable category path",
  "variation_suggestions": [{"property":"Colour","values":["..."]}],
  "seo_notes": "one short paragraph on why these keywords"
}
Never invent measurements or materials that are not in the notes; use null instead.`,
  },
  {
    name: 'Product research analyst',
    kind: 'research',
    is_default: 1,
    body: `You are analysing a sample of live Etsy listings for one keyword.

Given the JSON rows (title, price, views, favourites, tags, age), produce:
1. Price bands - low/median/high and where the demand concentrates.
2. The 15 tags that recur most, and 5 gaps nobody is using.
3. Three title patterns that repeat among the highest-engagement rows.
4. A blunt verdict: enter, enter-with-differentiation, or avoid, with the reason.
Be specific and quantitative. Do not pad.`,
  },
  {
    name: 'Product photo cleanup',
    kind: 'image',
    is_default: 1,
    body: `Edit this product photo for an Etsy listing: clean neutral background, true-to-life
colour, even lighting, no added props, no text or watermark. Keep the product's real shape,
texture and proportions exactly as photographed. Square framing with comfortable margin.`,
  },
];

function seedDefaults(database) {
  const count = database.prepare('SELECT COUNT(*) AS c FROM prompts').get().c;
  if (count > 0) return;
  const insert = database.prepare(
    'INSERT INTO prompts (name, kind, body, is_default, is_system) VALUES (?,?,?,?,1)',
  );
  const run = database.transaction((rows) => {
    for (const p of rows) insert.run(p.name, p.kind, p.body, p.is_default ? 1 : 0);
  });
  run(DEFAULT_PROMPTS);
  log.info(`seeded ${DEFAULT_PROMPTS.length} starter prompts`);
}

export default getDb;
