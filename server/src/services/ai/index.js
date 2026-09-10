/**
 * AI studio: the prompt library, the customer-reply desk (typed message or a
 * pasted screenshot), and the listing writers.
 */
import fs from 'node:fs';
import { getDb, audit } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { complete, editImage, providerStatus, resolveProvider, PROVIDERS } from './providers.js';

const log = createLogger('ai');
export { providerStatus, PROVIDERS, editImage };
export { MODEL_CATALOGUE, modelOptions } from './providers.js';

export const PROMPT_KINDS = ['reply', 'title', 'description', 'tags', 'listing', 'image', 'research', 'custom'];

// ------------------------------------------------------------ prompt library

export const listPrompts = (kind) =>
  getDb().prepare(`SELECT * FROM prompts ${kind ? 'WHERE kind = ?' : ''} ORDER BY is_default DESC, usage_count DESC, name`)
    .all(...(kind ? [kind] : []));

export const getPrompt = (id) => getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id) || null;

export function getDefaultPrompt(kind) {
  const db = getDb();
  return db.prepare('SELECT * FROM prompts WHERE kind = ? AND is_default = 1 ORDER BY id LIMIT 1').get(kind)
    ?? db.prepare('SELECT * FROM prompts WHERE kind = ? ORDER BY id LIMIT 1').get(kind)
    ?? null;
}

export function savePrompt({ id, name, kind, body, isDefault = false }) {
  const db = getDb();
  if (!name?.trim()) throw badRequest('The prompt needs a name.');
  if (!body?.trim()) throw badRequest('The prompt body cannot be empty.');
  if (!PROMPT_KINDS.includes(kind)) throw badRequest(`Unknown prompt kind "${kind}".`);

  const result = db.transaction(() => {
    // Only one default per kind.
    if (isDefault) db.prepare('UPDATE prompts SET is_default = 0 WHERE kind = ?').run(kind);

    if (id) {
      const existing = getPrompt(id);
      if (!existing) throw notFound(`Prompt ${id} not found.`);
      db.prepare(`UPDATE prompts SET name = ?, kind = ?, body = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name.trim(), kind, body, isDefault ? 1 : 0, id);
      return getPrompt(id);
    }
    const info = db.prepare('INSERT INTO prompts (name, kind, body, is_default) VALUES (?,?,?,?)')
      .run(name.trim(), kind, body, isDefault ? 1 : 0);
    return getPrompt(info.lastInsertRowid);
  })();

  audit('prompt.save', { entity: 'prompt', entityId: result.id, detail: { kind, isDefault } });
  return result;
}

export function deletePrompt(id) {
  const db = getDb();
  const p = getPrompt(id);
  if (!p) throw notFound(`Prompt ${id} not found.`);
  if (p.is_system) throw badRequest('Built-in prompts cannot be deleted. Edit it or make another one the default.');

  let promoted = null;
  db.transaction(() => {
    db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
    // A kind must never be left without a default, or the AI screens have
    // nothing to fall back to. Promote the next prompt of that kind.
    if (p.is_default) {
      const next = db.prepare('SELECT id FROM prompts WHERE kind = ? ORDER BY is_system DESC, id LIMIT 1').get(p.kind);
      if (next) {
        db.prepare('UPDATE prompts SET is_default = 1 WHERE id = ?').run(next.id);
        promoted = next.id;
      }
    }
  })();
  return { deleted: id, promotedToDefault: promoted };
}

export function setDefaultPrompt(id) {
  const p = getPrompt(id);
  if (!p) throw notFound(`Prompt ${id} not found.`);
  getDb().transaction(() => {
    getDb().prepare('UPDATE prompts SET is_default = 0 WHERE kind = ?').run(p.kind);
    getDb().prepare('UPDATE prompts SET is_default = 1 WHERE id = ?').run(id);
  })();
  return getPrompt(id);
}

const bumpUsage = (id) => {
  if (id) getDb().prepare("UPDATE prompts SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?").run(id);
};

// -------------------------------------------------------------------- runs

function startRun({ kind, provider, promptId, input, attachments }) {
  const info = getDb().prepare(
    'INSERT INTO ai_runs (kind, provider, prompt_id, input, attachments) VALUES (?,?,?,?,?)',
  ).run(kind, provider, promptId ?? null, input, attachments ? JSON.stringify(attachments) : null);
  return info.lastInsertRowid;
}

function finishRun(id, { output, model, externalId, externalUrl, durationMs, error }) {
  getDb().prepare(`UPDATE ai_runs SET status = ?, output = ?, model = ?, external_id = ?, external_url = ?,
    duration_ms = ?, error = ?, finished_at = datetime('now') WHERE id = ?`)
    .run(error ? 'failed' : 'completed', output ?? null, model ?? null, externalId ?? null,
         externalUrl ?? null, durationMs ?? null, error ?? null, id);
}

export const listRuns = (kind, limit = 50) =>
  getDb().prepare(`SELECT id, kind, provider, model, status, substr(input,1,300) AS input,
    output, external_url, error, duration_ms, created_at FROM ai_runs
    ${kind ? 'WHERE kind = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(kind ? [kind, limit] : [limit]));

export const getRun = (id) => getDb().prepare('SELECT * FROM ai_runs WHERE id = ?').get(id) || null;

/** Load stored screenshots as base64 for the vision-capable providers. */
function loadImages(attachmentIds = []) {
  if (!attachmentIds.length) return [];
  const db = getDb();
  return attachmentIds.map((id) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!a) throw notFound(`Attachment ${id} not found.`);
    return { base64: fs.readFileSync(a.path).toString('base64'), mime: a.mime, filename: a.filename };
  });
}

/** Core: resolve the prompt, run the provider, record the run. */
export async function run({
  kind, provider, model = null, promptId = null, promptOverride = null, userInput = '',
  attachmentIds = [], context = null, maxTokens = 4096,
}) {
  const images = loadImages(attachmentIds);
  const chosen = resolveProvider(provider, { needsImages: images.length > 0 });

  // Manual prompt wins; otherwise a saved prompt; otherwise the kind's default.
  let system = promptOverride?.trim() || null;
  let usedPromptId = null;
  if (!system) {
    const p = promptId ? getPrompt(promptId) : getDefaultPrompt(kind);
    if (!p) throw badRequest(`No prompt available for "${kind}". Create one in the Prompt library.`);
    system = p.body;
    usedPromptId = p.id;
  }

  const parts = [];
  if (context) parts.push(`CONTEXT\n${typeof context === 'string' ? context : JSON.stringify(context, null, 2)}`);
  if (userInput) parts.push(`INPUT\n${userInput}`);
  if (images.length && !parts.length) parts.push('The input is in the attached image(s).');
  const prompt = parts.join('\n\n');

  const runId = startRun({ kind, provider: chosen, promptId: usedPromptId, input: prompt, attachments: attachmentIds });

  try {
    const result = await complete({ provider: chosen, model, prompt, system, images, maxTokens });
    finishRun(runId, { output: result.text, model: result.model, externalId: result.externalId, externalUrl: result.externalUrl, durationMs: result.durationMs });
    bumpUsage(usedPromptId);
    log.info(`${kind} via ${result.provider} in ${result.durationMs}ms`);
    return { runId, kind, provider: result.provider, model: result.model, text: result.text, externalUrl: result.externalUrl, durationMs: result.durationMs, promptId: usedPromptId };
  } catch (err) {
    finishRun(runId, { error: err.message });
    throw err;
  }
}

// ----------------------------------------------------------- reply workflow

/**
 * Draft a reply to a buyer. The message can be typed, pulled from an order,
 * or read out of an uploaded screenshot by a vision provider.
 */
export async function draftReply({
  message = '', attachmentIds = [], promptId, promptOverride, provider,
  tone = '', orderId = null, extraContext = '',
}) {
  if (!message.trim() && !attachmentIds.length) {
    throw badRequest('Provide the buyer message, or attach a screenshot of it.');
  }

  let context = '';
  if (orderId) {
    const { getOrder } = await import('../orders.js');
    try {
      const o = getOrder(orderId);
      context = [
        `Order #${o.receiptId} placed ${o.createdTs ? new Date(o.createdTs * 1000).toISOString().slice(0, 10) : 'unknown'}`,
        `Buyer: ${o.name ?? 'unknown'} (${o.country ?? '-'})`,
        `Items: ${o.items.map((i) => `${i.quantity}x ${i.title}${i.variationLabel ? ` (${i.variationLabel})` : ''}`).join('; ')}`,
        o.shipments[0]
          ? `Tracking ${o.shipments[0].trackingCode}: ${o.shipments[0].statusLabel ?? 'unknown'}`
            + `${o.shipments[0].lastEventText ? ` - last scan "${o.shipments[0].lastEventText}"` : ''}`
            + `${o.shipments[0].daysSinceMove != null ? `, ${o.shipments[0].daysSinceMove} days since movement` : ''}`
          : 'No tracking recorded yet.',
        o.isShipped ? 'Order is marked shipped.' : 'Order is NOT shipped yet.',
      ].join('\n');
    } catch (err) {
      log.warn(`reply context for order ${orderId}: ${err.message}`);
    }
  }
  if (tone) context += `\n\nRequested tone: ${tone}`;
  if (extraContext) context += `\n\nAdditional instructions from the seller: ${extraContext}`;

  return run({
    kind: 'reply',
    provider,
    promptId,
    promptOverride,
    userInput: message.trim() || '(see attached screenshot)',
    attachmentIds,
    context: context || null,
  });
}

// --------------------------------------------------------- listing writers

const stripFence = (s) => s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

export function parseJsonish(text) {
  const cleaned = stripFence(text ?? '');
  try { return JSON.parse(cleaned); } catch { /* fall through to a brace scan */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* give up below */ }
  }
  return null;
}

const productBrief = (product = {}) => Object.entries({
  Name: product.name, Category: product.category, Materials: product.materials,
  Dimensions: product.dimensions, Colours: product.colours, Audience: product.audience,
  Occasion: product.occasion, 'Key features': product.features, Price: product.price,
  'Extra notes': product.notes,
}).filter(([, v]) => v).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');

export const writeTitle = (product, opts = {}) =>
  run({ kind: 'title', userInput: productBrief(product), ...opts });

export const writeDescription = (product, opts = {}) =>
  run({ kind: 'description', userInput: productBrief(product), ...opts });

export const writeTags = (product, opts = {}) =>
  run({ kind: 'tags', userInput: productBrief(product), ...opts });

/** Full listing draft as structured JSON, ready to push to Etsy. */
export async function writeListing(product, opts = {}) {
  const result = await run({ kind: 'listing', userInput: productBrief(product), maxTokens: 6000, ...opts });
  const parsed = parseJsonish(result.text);
  return {
    ...result,
    listing: parsed,
    parseError: parsed ? null : 'The model did not return valid JSON. The raw text is in `text`; edit it by hand or run again.',
  };
}

/** Tags come back as prose; normalise to Etsy's 13 x 20-char rule. */
export function normaliseTags(text, limit = 13) {
  return [...new Set(
    String(text || '')
      .split(/[,\n]/)
      .map((t) => t.replace(/^\s*\d+[.)]\s*/, '').replace(/["'`]/g, '').trim().toLowerCase())
      .filter((t) => t && t.length <= 20),
  )].slice(0, limit);
}

/** Titles come back numbered; split them into choices. */
export const parseTitleOptions = (text) =>
  String(text || '').split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter((l) => l.length > 10 && l.length <= 200);
