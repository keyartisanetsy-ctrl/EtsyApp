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
  openai: [
    { id: 'gpt-image-2', label: 'ChatGPT Image 2 (gpt-image-2)', note: 'The newest picture model.' },
    { id: 'gpt-image-1.5', label: 'ChatGPT Image 1.5 (gpt-image-1.5)' },
    { id: 'gpt-image-1', label: 'ChatGPT Image 1 (gpt-image-1)' },
    { id: 'gpt-image-1-mini', label: 'ChatGPT Image 1 mini (gpt-image-1-mini)', note: 'Cheaper, rougher.' },
  ],
};

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
    defaults: {
      provider: readSetting('drafts.image_edit.provider') || 'manus',
      manusModel: readSetting('drafts.image_edit.manus_model') || 'lite',
      openaiModel: openaiDefault,
      prompt: readSetting('drafts.image_edit.prompt') || DEFAULT_PROMPT,
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
    return { buffer: Buffer.from(await res.arrayBuffer()), filename: 'image.jpg', row, rank: row.rank };
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

function sweep() {
  for (const [id, j] of jobs) {
    if (Date.now() - j.createdAt > JOB_TTL_MS) {
      if (j.file) { try { fs.unlinkSync(j.file); } catch { /* gone */ } }
      jobs.delete(id);
    }
  }
}

const publicJob = (j) => ({
  jobId: j.id, status: j.status, error: j.error ?? null, provider: j.provider, model: j.model,
  progress: j.progress ?? null, taskUrl: j.taskUrl ?? null,
  previewUrl: j.status === 'done' ? `/api/drafts/image-edit/jobs/${j.id}/file` : null,
  width: j.width ?? null, height: j.height ?? null, seconds: Math.round(((j.finishedAt ?? Date.now()) - j.createdAt) / 1000),
});

export function job(id) {
  const j = jobs.get(String(id));
  if (!j) throw notFound('That edit is gone (they are kept for an hour).');
  return publicJob(j);
}

export function jobFile(id) {
  const j = jobs.get(String(id));
  if (!j || j.status !== 'done' || !j.file) throw notFound('That edited picture is not ready.');
  return { path: j.file, mime: j.mime };
}

async function run(j, src) {
  try {
    const before = decodeImage(src.buffer);
    const sniffed = sniff(src.buffer);
    const image = { buffer: src.buffer, mime: sniffed?.mime || 'image/jpeg', filename: src.filename };
    let out;
    if (j.provider === 'manus') {
      out = await ai.manusEditImage({
        prompt: j.prompt, image, profile: j.model,
        onProgress: (p) => { j.progress = p.stage; if (p.taskUrl) j.taskUrl = p.taskUrl; },
      });
    } else {
      const size = before ? `${before.width}x${before.height}` : '1024x1024';
      const r = await ai.editImage({ prompt: j.prompt, image, size, model: j.model });
      const first = r.images?.[0];
      if (!first) throw badRequest('ChatGPT returned no picture.');
      let buffer;
      if (first.b64) buffer = Buffer.from(first.b64, 'base64');
      else if (first.url) buffer = Buffer.from(await (await outboundFetch(first.url)).arrayBuffer());
      else throw badRequest('ChatGPT returned no picture.');
      out = { buffer, mime: 'image/png' };
    }
    const kind = sniff(out.buffer);
    if (!kind) throw badRequest('The AI did not return a picture this app can use.');
    fs.mkdirSync(tmpDir(), { recursive: true });
    j.file = path.join(tmpDir(), `${j.id}${kind.ext}`);
    fs.writeFileSync(j.file, out.buffer);
    j.mime = kind.mime;
    const dims = decodeImage(out.buffer);
    j.width = dims?.width ?? null; j.height = dims?.height ?? null;
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
export async function start({ listingId, mediaId, provider, model, prompt, remember = true } = {}) {
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

  const src = await sourceOf(id, mediaId);
  if (!sniff(src.buffer)) throw badRequest('That file is not a picture the AI can edit.');
  const j = {
    id: crypto.randomBytes(8).toString('hex'), status: 'running', createdAt: Date.now(), provider, model: chosen, prompt: text,
    listingId: id, mediaId: Number(mediaId), rank: src.rank,
  };
  jobs.set(j.id, j);

  if (remember) {
    writeSetting('drafts.image_edit.provider', provider);
    writeSetting(provider === 'manus' ? 'drafts.image_edit.manus_model' : 'drafts.image_edit.openai_model', chosen);
    writeSetting('drafts.image_edit.prompt', text === DEFAULT_PROMPT ? '' : text);
  }
  audit('draft.image_edit_start', { entity: 'listing', entityId: id, detail: { mediaId, provider, model: chosen } });
  run(j, src); // not awaited - the page polls
  return publicJob(j);
}

/**
 * Accept an edit. 'replace' puts the edited picture where the original was (same place in the order); 'add' puts it
 * next to the original, which stays. A local draft keeps it staged; a draft that is already on Etsy uploads it there.
 */
export async function apply(jobId, { mode = 'replace' } = {}) {
  const j = jobs.get(String(jobId));
  if (!j || j.status !== 'done' || !j.file) throw notFound('That edited picture is not ready (or is gone - edits are kept for an hour).');
  if (!['replace', 'add'].includes(mode)) throw badRequest('mode must be "replace" or "add".');
  const buffer = fs.readFileSync(j.file);
  const kind = sniff(buffer);
  const original = await sourceOf(j.listingId, j.mediaId).catch(() => null);
  if (!original) throw notFound('The original picture is no longer on this draft.');
  const base = String(original.filename || 'image').replace(/\.[^.]+$/, '');
  const filename = `${base}-en${kind.ext}`;

  if (j.listingId < 0) {
    if (mode === 'add') {
      draftmedia.addUpload(j.listingId, { kind: 'image', buffer, filename, mime: kind.mime });
    } else {
      draftmedia.replaceImage(j.listingId, j.mediaId, { buffer, filename, mime: kind.mime });
    }
  } else {
    await listings.uploadImage(j.listingId, {
      buffer, filename, mime: kind.mime,
      rank: mode === 'replace' ? (original.rank || 1) : Math.min(20, (getDb().prepare('SELECT COUNT(*) c FROM listing_images WHERE listing_id = ?').get(j.listingId).c || 0) + 1),
      overwrite: mode === 'replace',
    });
    await drafts.refreshSnapshot(j.listingId);
  }
  audit('draft.image_edit_apply', { entity: 'listing', entityId: j.listingId, detail: { mediaId: j.mediaId, mode, provider: j.provider } });
  try { fs.unlinkSync(j.file); } catch { /* gone */ }
  jobs.delete(j.id);
  return { applied: mode };
}

export function discard(jobId) {
  const j = jobs.get(String(jobId));
  if (j?.file) { try { fs.unlinkSync(j.file); } catch { /* gone */ } }
  jobs.delete(String(jobId));
  return { discarded: true };
}
