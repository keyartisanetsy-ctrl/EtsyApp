/**
 * Editing a draft's picture with AI - mostly "translate the words on it into English".
 *
 * Right-click a picture on the Draft desk, choose how (Manus or ChatGPT, and which model), and the AI edits a copy.
 * The result is shown beside the original and only goes anywhere once it is accepted: it replaces the picture (keeping
 * its place) or is added next to it. Edits take from seconds (ChatGPT) to minutes (Manus is an agent), so each one runs
 * as a job the page polls.
 *
 * The starting instruction keeps the product and the background exactly as they are and only translates the text that
 * is not part of the product into English in the same style. It, the provider and the model are remembered in the
 * settings so the next picture starts where the last one ended.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, audit } from '../db/index.js';
import config from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { outboundFetch } from '../lib/outbound.js';
import { readSetting, writeSetting } from './settings.js';
import * as ai from './ai/index.js';
import { OPENAI_IMAGE_PARAMS } from './ai/providers.js';
import * as undo from './undo.js';
import { decodeImage } from './imagesig.js';
import * as draftmedia from './draftmedia.js';
import * as listings from './listings.js';
import * as drafts from './drafts.js';

const log = createLogger('image-edit');

export const DEFAULT_PROMPT = 'Keep the product and the background exactly the same as in the original picture. '
  + 'Only translate the text that is not part of the product (captions, labels, titles, slogans, callouts written on the picture) into English, '
  + 'in the same style: the same lettering look, colour, size, placement and effects.';

export const MODELS = {
  manus: [
    { id: 'lite', label: 'Manus 2.0 Lite', note: 'Standard choice - cheapest and fastest.' },
    { id: 'standard', label: 'Manus 2.0 Standard', note: 'More careful.' },
    { id: 'max', label: 'Manus 2.0 Max', note: 'Most thorough - slowest, most credits.' },
  ],
  // the picture models OpenAI lists (newest first); a dated name is that model frozen on its date
  openai: [
    { id: 'chatgpt-image-latest', label: 'chatgpt-image-latest', note: 'Whatever ChatGPT uses right now.' },
    { id: 'gpt-image-2.5-sunburst', label: 'gpt-image-2.5-sunburst' },
    { id: 'gpt-image-2.5-sunburst-2026-09-08', label: 'gpt-image-2.5-sunburst-2026-09-08', note: 'Frozen 2026-09-08.' },
    { id: 'gpt-image-2.5-flare', label: 'gpt-image-2.5-flare' },
    { id: 'gpt-image-2.5-flare-2026-09-08', label: 'gpt-image-2.5-flare-2026-09-08', note: 'Frozen 2026-09-08.' },
    { id: 'gpt-image-2', label: 'gpt-image-2' },
    { id: 'gpt-image-2-2026-04-21', label: 'gpt-image-2-2026-04-21', note: 'Frozen 2026-04-21.' },
    { id: 'gpt-image-1.5', label: 'gpt-image-1.5' },
    { id: 'gpt-image-1', label: 'gpt-image-1' },
    { id: 'gpt-image-1-mini', label: 'gpt-image-1-mini', note: 'Cheaper, rougher.' },
  ],
};

const PARAMS_KEY = 'drafts.image_edit.openai_options';

/** The ChatGPT picture settings, checked against what each one allows, with the defaults (Medium quality, JPEG) filled in. */
export function cleanParams(input = {}) {
  const out = {};
  for (const [key, def] of Object.entries(OPENAI_IMAGE_PARAMS)) {
    const v = input?.[key];
    if (key === 'n') { out.n = Math.min(def.max, Math.max(def.min, Math.round(Number(v ?? def.def)) || def.def)); continue; }
    if (key === 'outputCompression') {
      const n = Math.round(Number(v));
      out.outputCompression = v === '' || v === undefined || v === null || !Number.isFinite(n) ? '' : Math.min(100, Math.max(1, n));
      continue;
    }
    out[key] = def.choices.some((c) => c.id === v) ? v : def.def;
  }
  if (out.background === 'transparent' && out.outputFormat === 'jpeg') out.outputFormat = 'png'; // JPEG cannot be transparent
  return out;
}

function savedParams() {
  try { return cleanParams(JSON.parse(readSetting(PARAMS_KEY) || '{}')); } catch { return cleanParams({}); }
}

/** What the picture-editing box offers, and what it starts with. */
export function options() {
  const status = ai.providerStatus();
  const openaiDefault = readSetting('drafts.image_edit.openai_model') || readSetting('ai.openai.image_model') || 'gpt-image-2';
  const openaiModels = MODELS.openai.some((m) => m.id === openaiDefault) ? MODELS.openai : [{ id: openaiDefault, label: openaiDefault }, ...MODELS.openai];
  return {
    providers: [
      { id: 'manus', label: 'Manus', configured: status.manus.configured, models: MODELS.manus, note: 'An agent: it can take a minute or two.' },
      { id: 'openai', label: 'ChatGPT', configured: status.openai.configured, models: openaiModels, note: 'Usually ready in under a minute.' },
    ],
    openaiParams: OPENAI_IMAGE_PARAMS,
    defaults: {
      provider: readSetting('drafts.image_edit.provider') || 'manus',
      manusModel: readSetting('drafts.image_edit.manus_model') || 'lite',
      openaiModel: openaiDefault,
      prompt: readSetting('drafts.image_edit.prompt') || DEFAULT_PROMPT,
      params: savedParams(),
    },
    defaultPrompt: DEFAULT_PROMPT,
  };
}

// ------------------------------------------------------------------ pictures

const tmpDir = () => path.join(config.uploadDir, 'draft-media', 'ai-edits');

export const sniff = draftmedia.pictureKind;

/** The bytes of one picture of a draft - a staged one (local draft) or one that is on Etsy. */
async function sourceOf(listingId, mediaId) {
  const db = getDb();
  if (listingId < 0) {
    const row = db.prepare("SELECT * FROM draft_media WHERE id = ? AND listing_id = ? AND kind = 'image'").get(Number(mediaId), listingId);
    if (!row) throw notFound('That picture is not on this draft.');
    if (row.file_path && fs.existsSync(row.file_path)) {
      const buffer = fs.readFileSync(row.file_path);
      return { buffer, filename: row.filename || path.basename(row.file_path), row, rank: row.rank };
    }
    const res = await outboundFetch(row.source_url);
    if (!res.ok) throw badRequest(`The picture could not be fetched (${res.status}).`);
    let name = 'image.jpg';
    try { name = decodeURIComponent(path.basename(new URL(row.source_url).pathname)) || name; } catch { /* keep the generic name */ }
    return { buffer: Buffer.from(await res.arrayBuffer()), filename: row.filename || name, row, rank: row.rank };
  }
  const row = db.prepare('SELECT * FROM listing_images WHERE listing_image_id = ? AND listing_id = ?').get(Number(mediaId), listingId);
  if (!row) throw notFound('That picture is not on this listing.');
  const res = await outboundFetch(row.url_fullxfull || row.url_570xN);
  if (!res.ok) throw badRequest(`The picture could not be fetched from Etsy (${res.status}).`);
  return { buffer: Buffer.from(await res.arrayBuffer()), filename: `image-${row.rank || 1}.jpg`, row, rank: row.rank || 1 };
}

// ---------------------------------------------------------------------- jobs

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function dropFiles(j) {
  for (const r of j.results ?? []) { try { fs.unlinkSync(r.file); } catch { /* gone */ } }
  j.results = [];
}

function sweep() {
  for (const [id, j] of jobs) {
    if (Date.now() - j.createdAt > JOB_TTL_MS) { dropFiles(j); jobs.delete(id); }
  }
}

const publicJob = (j) => ({
  jobId: j.id, status: j.status, error: j.error ?? null, provider: j.provider, model: j.model,
  progress: j.progress ?? null, taskUrl: j.taskUrl ?? null,
  previews: j.status === 'done' ? j.results.map((r, i) => ({ index: i, url: `/api/drafts/image-edit/jobs/${j.id}/file?i=${i}`, width: r.width, height: r.height, mime: r.mime, bytes: r.bytes })) : [],
  previewUrl: j.status === 'done' ? `/api/drafts/image-edit/jobs/${j.id}/file?i=0` : null,
  width: j.results?.[0]?.width ?? null, height: j.results?.[0]?.height ?? null,
  ignored: j.ignored ?? [], seconds: Math.round(((j.finishedAt ?? Date.now()) - j.createdAt) / 1000),
});

export function job(id) {
  const j = jobs.get(String(id));
  if (!j) throw notFound('That edit is gone (they are kept for an hour).');
  return publicJob(j);
}

export function jobFile(id, index = 0) {
  const j = jobs.get(String(id));
  const r = j?.status === 'done' ? j.results[Number(index) || 0] : null;
  if (!r) throw notFound('That edited picture is not ready.');
  return { path: r.file, mime: r.mime };
}

function keepResult(j, i, buffer) {
  const kind = sniff(buffer);
  if (!kind) throw badRequest('The AI did not return a picture this app can use.');
  fs.mkdirSync(tmpDir(), { recursive: true });
  const file = path.join(tmpDir(), `${j.id}-${i}${kind.ext}`);
  fs.writeFileSync(file, buffer);
  const dims = decodeImage(buffer);
  j.results.push({ file, mime: kind.mime, width: dims?.width ?? null, height: dims?.height ?? null, bytes: buffer.length });
}

async function run(j, src) {
  try {
    const before = decodeImage(src.buffer);
    const sniffed = sniff(src.buffer);
    const image = { buffer: src.buffer, mime: sniffed?.mime || 'image/jpeg', filename: src.filename };
    if (j.provider === 'manus') {
      const out = await ai.manusEditImage({
        prompt: j.prompt, image, profile: j.model,
        onProgress: (p) => { j.progress = p.stage; if (p.taskUrl) j.taskUrl = p.taskUrl; },
      });
      keepResult(j, 0, out.buffer);
    } else {
      const size = before ? `${before.width}x${before.height}` : '1024x1024';
      const r = await ai.editImage({ prompt: j.prompt, image, size, model: j.model, options: j.params });
      j.ignored = r.ignored ?? [];
      const list = (r.images ?? []).filter((x) => x.b64 || x.url);
      if (!list.length) throw badRequest('ChatGPT returned no picture.');
      for (let i = 0; i < list.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const buffer = list[i].b64 ? Buffer.from(list[i].b64, 'base64') : Buffer.from(await (await outboundFetch(list[i].url)).arrayBuffer());
        keepResult(j, i, buffer);
      }
    }
    j.status = 'done';
  } catch (err) {
    log.warn(`picture edit ${j.id} failed: ${err.message}`);
    j.status = 'error';
    j.error = err.message;
  } finally {
    j.finishedAt = Date.now();
  }
}

/** Start an edit of one picture. Returns the job to poll at once; the work goes on behind it. */
export async function start({ listingId, mediaId, provider, model, prompt, params, remember = true } = {}) {
  sweep();
  const id = Number(listingId);
  if (!/^(1|true|yes|on)$/i.test(String(readSetting('privacy.share_ai')))) {
    throw badRequest('AI features are switched off in Settings > Privacy. Nothing has been sent anywhere.');
  }
  if (!['manus', 'openai'].includes(provider)) throw badRequest('Choose Manus or ChatGPT.');
  const status = ai.providerStatus();
  if (!status[provider].configured) throw badRequest(`${provider === 'manus' ? 'Manus' : 'ChatGPT (OpenAI)'} has no API key yet - add it in Settings > AI.`);
  const text = String(prompt ?? '').trim() || DEFAULT_PROMPT;
  const chosen = String(model || '').trim() || (provider === 'manus' ? 'lite' : (readSetting('ai.openai.image_model') || 'gpt-image-2'));
  const cleaned = cleanParams(params ?? savedParams());

  const src = await sourceOf(id, mediaId);
  if (!sniff(src.buffer)) throw badRequest('That file is not a picture the AI can edit.');
  const j = {
    id: crypto.randomBytes(8).toString('hex'), status: 'running', createdAt: Date.now(), provider, model: chosen, prompt: text,
    params: cleaned, listingId: id, mediaId: Number(mediaId), rank: src.rank, results: [],
  };
  jobs.set(j.id, j);

  if (remember) {
    writeSetting('drafts.image_edit.provider', provider);
    writeSetting(provider === 'manus' ? 'drafts.image_edit.manus_model' : 'drafts.image_edit.openai_model', chosen);
    writeSetting('drafts.image_edit.prompt', text === DEFAULT_PROMPT ? '' : text);
    if (provider === 'openai') writeSetting(PARAMS_KEY, JSON.stringify(cleaned));
  }
  audit('draft.image_edit_start', { entity: 'listing', entityId: id, detail: { mediaId, provider, model: chosen, params: provider === 'openai' ? cleaned : undefined } });
  run(j, src); // not awaited - the page polls
  return publicJob(j);
}

/**
 * Accept an edit (`index` says which one when ChatGPT made several). 'replace' puts the edited picture where the original
 * was (same place in the order); 'add' puts it next to the original, which stays. A local draft keeps it staged here, as
 * this app's own picture; a draft that is already on Etsy gets it uploaded there at once. Either way it can be taken back:
 * the original stays on disk, and for Etsy it is uploaded again.
 */
export async function apply(jobId, { mode = 'replace', index = 0 } = {}) {
  const j = jobs.get(String(jobId));
  const result = j?.status === 'done' ? j.results[Number(index) || 0] : null;
  if (!result) throw notFound('That edited picture is not ready (or is gone - edits are kept for an hour).');
  if (!['replace', 'add'].includes(mode)) throw badRequest('mode must be "replace" or "add".');
  if (result.mime === 'image/webp') throw badRequest('Etsy does not accept WebP pictures. Edit again with JPEG or PNG as the output format.');
  const buffer = fs.readFileSync(result.file);
  const original = await sourceOf(j.listingId, j.mediaId).catch(() => null);
  if (!original) throw notFound('The original picture is no longer on this draft.');
  const base = String(original.filename || 'image').replace(/\.[^.]+$/, '');
  const ext = path.extname(result.file);
  const filename = `${base}-en${ext}`;
  const what = mode === 'replace' ? 'AI-edited picture replaced the original' : 'AI-edited picture added next to the original';

  if (j.listingId < 0) {
    if (mode === 'add') {
      draftmedia.addUpload(j.listingId, { kind: 'image', buffer, filename, mime: result.mime, label: `${what} (draft)`, undoNote: 'Removes the added picture; the original was never touched.' });
    } else {
      draftmedia.replaceImage(j.listingId, j.mediaId, { buffer, filename, mime: result.mime, note: `${what} (draft)` });
    }
  } else {
    // the original is kept (as a file) so it can be put back on Etsy
    fs.mkdirSync(tmpDir(), { recursive: true });
    const sn = sniff(original.buffer);
    const backup = path.join(tmpDir(), `original-${crypto.randomBytes(6).toString('hex')}${sn?.ext || '.jpg'}`);
    fs.writeFileSync(backup, original.buffer);
    const rank = mode === 'replace' ? (original.rank || 1) : Math.min(20, (getDb().prepare('SELECT COUNT(*) c FROM listing_images WHERE listing_id = ?').get(j.listingId).c || 0) + 1);
    const res = await listings.uploadImage(j.listingId, { buffer, filename, mime: result.mime, rank, overwrite: mode === 'replace' });
    await drafts.refreshSnapshot(j.listingId);
    undo.commit(undo.begin({
      label: `${what} (on Etsy)`, kind: 'draft.picture.etsy',
      note: mode === 'replace' ? 'Also changes Etsy: the original picture is uploaded to the listing again, in the same place.' : 'Also changes Etsy: the added picture is deleted from the listing there.',
    }), {
      affected: 1,
      detail: { handler: 'draftPicture.restore', args: { listingId: j.listingId, mode, rank, imageId: res?.listing_image_id ?? null, backup, filename: original.filename, mime: sn?.mime || 'image/jpeg' } },
    });
  }
  audit('draft.image_edit_apply', { entity: 'listing', entityId: j.listingId, detail: { mediaId: j.mediaId, mode, provider: j.provider, index: Number(index) || 0 } });
  dropFiles(j);
  jobs.delete(j.id);
  draftmedia.sweepFiles();
  return { applied: mode };
}

export function discard(jobId) {
  const j = jobs.get(String(jobId));
  if (j) dropFiles(j);
  jobs.delete(String(jobId));
  return { discarded: true };
}

// ------------------------------------------------- taking a picture change back (Etsy side)

undo.registerHandler('draftPicture.restore', async ({ listingId, mode, rank, imageId, backup, filename, mime }) => {
  if (mode === 'add') {
    if (imageId) await listings.deleteImage(listingId, imageId);
  } else {
    if (!backup || !fs.existsSync(backup)) throw badRequest('The original picture is no longer on this machine, so it cannot be put back on Etsy.');
    await listings.uploadImage(listingId, { buffer: fs.readFileSync(backup), filename: filename || 'image.jpg', mime, rank: rank || 1, overwrite: true });
  }
  await drafts.refreshSnapshot(listingId);
  return { message: mode === 'add' ? 'The added picture was deleted from the Etsy listing.' : 'The original picture is back on the Etsy listing.' };
});

undo.registerHandler('draftPicture.deleteImage', async ({ listingId, imageId }) => {
  await listings.deleteImage(listingId, imageId);
  await drafts.refreshSnapshot(listingId);
  return { message: 'The picture was deleted from the Etsy listing.' };
});
