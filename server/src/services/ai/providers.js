/**
 * AI providers behind one interface.
 *
 * Manus is an asynchronous *agent* API (submit a task, poll until it finishes),
 * not a chat-completions endpoint, so it is wrapped to look synchronous.
 * Anthropic and OpenAI are the low-latency options and the ones that accept
 * image input, which the screenshot-reply workflow needs.
 */
import config from '../../config.js';
import { readSetting } from '../settings.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { outboundFetch } from '../../lib/outbound.js';

const log = createLogger('ai');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PROVIDERS = ['manus', 'anthropic', 'openai'];

export function providerStatus() {
  return {
    manus: { configured: !!readSetting('ai.manus.api_key'), supportsImages: false, async: true, model: readSetting('ai.manus.agent_profile') },
    anthropic: {
      configured: !!readSetting('ai.anthropic.api_key'), supportsImages: true, async: false,
      model: readSetting('ai.anthropic.model'), effort: readSetting('ai.anthropic.effort') || '',
    },
    openai: {
      configured: !!readSetting('ai.openai.api_key'), supportsImages: true, async: false,
      model: readSetting('ai.openai.model'), effort: readSetting('ai.openai.effort') || '',
    },
    active: readSetting('ai.provider'),
  };
}

/** Pick a provider that is actually usable for this request. */
export function resolveProvider(requested, { needsImages = false } = {}) {
  // A hard opt-out: when AI sharing is off, no text or image leaves the
  // machine for any provider, whatever the caller asked for.
  if (!/^(1|true|yes|on)$/i.test(String(readSetting('privacy.share_ai')))) {
    throw badRequest(
      'AI features are switched off in Settings > Privacy. Nothing has been sent anywhere. '
      + 'Turn "Allow AI features to send your text to the AI provider" back on to use them.',
    );
  }
  const status = providerStatus();
  const wanted = requested || status.active;

  if (status[wanted]?.configured && (!needsImages || status[wanted].supportsImages)) return wanted;

  // Fall back to any configured provider that can do the job.
  const fallback = PROVIDERS.find((p) => status[p].configured && (!needsImages || status[p].supportsImages));
  if (!fallback) {
    throw badRequest(
      needsImages
        ? 'No AI provider with image support is configured. Add an Anthropic or OpenAI key in Settings.'
        : 'No AI provider is configured. Add a Manus, Anthropic or OpenAI key in Settings.',
    );
  }
  if (fallback !== wanted) log.warn(`provider "${wanted}" unusable here, using "${fallback}"`);
  return fallback;
}

// ------------------------------------------------------------------- Manus

async function manusComplete({ prompt, system, onProgress, signal }) {
  const apiKey = readSetting('ai.manus.api_key');
  const base = config.ai.manus.base;
  const body = {
    prompt: system ? `${system}\n\n---\n\n${prompt}` : prompt,
    agentProfile: readSetting('ai.manus.agent_profile') || 'manus-1.6',
  };

  const res = await outboundFetch(`${base}/v1/tasks`, {
    method: 'POST',
    headers: { API_KEY: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const created = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Manus meters by credits; surface that plainly instead of a generic 429.
    if (res.status === 429 || created?.code === 8) {
      throw new AppError(429, `Manus rejected the task: ${created.message || 'credit limit exceeded'}. Top up the Manus account or switch provider in Settings.`);
    }
    throw new AppError(res.status, `Manus error: ${created.message || res.statusText}`);
  }

  const taskId = created.task_id ?? created.id;
  if (!taskId) throw new AppError(502, 'Manus did not return a task id.');
  const taskUrl = created.task_url ?? created.metadata?.task_url ?? null;
  onProgress?.({ stage: 'submitted', taskId, taskUrl });

  const deadline = Date.now() + config.ai.manus.timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new AppError(504, `Manus task ${taskId} did not finish within the timeout. It may still complete at ${taskUrl ?? 'manus.im'}.`);
    await sleep(config.ai.manus.pollIntervalMs);

    const poll = await outboundFetch(`${base}/v1/tasks/${taskId}`, { headers: { API_KEY: apiKey }, signal });
    if (!poll.ok) { log.warn(`Manus poll ${poll.status}, retrying`); continue; }
    const task = await poll.json();
    onProgress?.({ stage: task.status, taskId, taskUrl });

    if (task.status === 'completed' || task.status === 'succeeded') {
      return { text: extractManusText(task), externalId: taskId, externalUrl: taskUrl, raw: task };
    }
    if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'stopped') {
      throw new AppError(502, `Manus task ${task.status}${task.error ? `: ${task.error}` : ''}`);
    }
  }
}

/** Manus returns a transcript; take the assistant's text parts. */
export function extractManusText(task) {
  const chunks = [];
  for (const item of task.output ?? []) {
    if (item.role === 'user') continue;
    for (const c of item.content ?? []) {
      if (typeof c === 'string') chunks.push(c);
      else if (c.type === 'output_text' && c.text) chunks.push(c.text);
      else if (c.type === 'text' && c.text) chunks.push(c.text);
    }
  }
  return chunks.join('\n').trim() || (task.metadata?.task_title ?? '');
}

/**
 * The models worth offering when a live list cannot be fetched yet (no key
 * saved, or the provider is unreachable) - newest first, kept up to date by
 * hand as a fallback. Once a key is saved, `modelOptions()` below prefers the
 * provider's own live list instead of this, so a model shipped after this was
 * last edited still shows up correctly.
 *
 * A list rather than a free-text box, because a mistyped model id fails at the
 * API with a message that says nothing useful, and because the difference
 * between them matters: an address check wants the careful one, a batch of
 * title rewrites wants the cheap one. Anything not listed can still be typed in
 * - this is a shortlist, not a whitelist.
 *
 * `thinking` (Anthropic only) says which request shape reasoning takes on that
 * model: 'adaptive' (thinking:{type:'adaptive'} + output_config.effort),
 * 'enabled' (the older thinking:{type:'enabled'} + budget_tokens), or 'none'.
 * `effortLevels` lists the reasoning-effort values that model actually
 * accepts, empty when it takes none at all - both providers reject a level a
 * model does not support, so this is what keeps the effort picker honest.
 */
export const MODEL_CATALOGUE = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max', 'xhigh'],
      note: 'The current flagship. Use it for judgement calls - address checks, mapping, anything you would double-check by hand.' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max', 'xhigh'],
      note: 'Nearly Opus-level and quicker. A strong everyday default.' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max', 'xhigh'],
      note: 'One generation behind Sonnet 5.5, still fully current and fast.' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max', 'xhigh'],
      note: 'Tuned for writing. Good for listing copy.' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max', 'xhigh'],
      note: 'Previous-generation flagship, kept here in case it is still what you have pinned.' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max', 'xhigh'],
      note: 'Previous-generation Sonnet.' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', thinking: 'enabled', effortLevels: [],
      note: 'Fastest and cheapest. Fine for bulk jobs where each answer is small. No reasoning-effort control - only a thinking budget, which this app does not expose per-request.' },
  ],
  openai: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      note: "OpenAI's current flagship - the most capable, for the hardest end-to-end work. Reads images." },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      note: 'Built for complex coding and agentic workflows. Reads images.' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      note: "OpenAI's efficient model for high-volume, everyday tasks. Reads images." },
    { id: 'gpt-4o', label: 'GPT-4o', effortLevels: [], note: 'Previous-generation, still generally available. Reads images.' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', effortLevels: [], note: 'Previous-generation, cheap bulk option.' },
  ],
  manus: [
    { id: 'manus-2.0', label: 'Manus 2.0', note: "Manus's current agent profile - runs as an agent, so it takes longer but can look things up." },
    { id: 'manus-1.6', label: 'Manus 1.6', note: 'Previous agent profile, still usable.' },
  ],
};

// ------------------------------------------------------- live model listing

/**
 * Anthropic and OpenAI each publish their own current model list over the
 * API. Fetching it beats hand-maintaining MODEL_CATALOGUE above, which is
 * stale again the day either of them ships something new - this cache is
 * what actually keeps the settings screen honest month after month.
 */
const LIVE_MODEL_CACHE = new Map(); // provider -> { at, models }
const LIVE_MODEL_TTL_MS = 10 * 60 * 1000;

/** OpenAI's model levels only where the family is known to take one - the
 *  plain models list does not say, so this is a name-based best guess
 *  covering every reasoning family shipped so far. Wrong for a future name
 *  this does not recognise only means the effort picker stays hidden for it;
 *  the model id itself is unaffected and still works normally. */
function guessOpenAiEffortLevels(id) {
  if (/^gpt-6-(astra)/i.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-6-(sol|luna)/i.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (/^(o[134](-mini)?|gpt-5(\.\d+)?(-mini|-nano)?)/i.test(id)) return ['minimal', 'low', 'medium', 'high'];
  return [];
}

async function fetchAnthropicModels(apiKey) {
  const res = await outboundFetch(`${config.ai.anthropic.base}/v1/models?limit=1000`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': config.ai.anthropic.version },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return (body.data ?? []).map((m) => ({
    id: m.id,
    label: m.display_name || m.id,
    // Straight from Anthropic's own capabilities, not guessed.
    thinking: m.capabilities?.thinking?.types?.adaptive?.supported ? 'adaptive'
      : m.capabilities?.thinking?.types?.enabled?.supported ? 'enabled' : 'none',
    effortLevels: m.capabilities?.effort?.supported
      ? ['low', 'medium', 'high', 'max', 'xhigh'].filter((lvl) => m.capabilities.effort[lvl]?.supported)
      : [],
  }));
}

async function fetchOpenAIModels(apiKey) {
  const res = await outboundFetch(`${config.ai.openai.base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return (body.data ?? [])
    .map((m) => m.id)
    .sort()
    .map((id) => ({ id, label: id, effortLevels: guessOpenAiEffortLevels(id) }));
}

/** The given provider's live model list, cached briefly. Never throws - a
 *  fetch problem (no network, a bad key, the provider down) just means the
 *  static catalogue above is used instead, so a listing hiccup here can
 *  never block anything the AI screens actually do. */
async function liveModels(provider, apiKey) {
  if (!apiKey) return null;
  const cached = LIVE_MODEL_CACHE.get(provider);
  if (cached && Date.now() - cached.at < LIVE_MODEL_TTL_MS) return cached.models;
  try {
    const models = provider === 'anthropic' ? await fetchAnthropicModels(apiKey)
      : provider === 'openai' ? await fetchOpenAIModels(apiKey) : null;
    if (models) LIVE_MODEL_CACHE.set(provider, { at: Date.now(), models });
    return models;
  } catch (err) {
    log.warn(`could not fetch ${provider}'s live model list: ${err.message}`);
    return cached?.models ?? null;
  }
}

/** One model's reasoning shape, live list first, the static catalogue as the fallback. */
async function modelMeta(provider, modelId, apiKey) {
  const live = await liveModels(provider, apiKey);
  return (live ?? []).find((m) => m.id === modelId)
    ?? MODEL_CATALOGUE[provider]?.find((m) => m.id === modelId)
    ?? { thinking: 'none', effortLevels: [] };
}

/** Everything the settings screen needs to offer a provider, a version and
 *  (where the model supports it) a reasoning-effort level. */
export async function modelOptions() {
  const status = providerStatus();
  const apiKeys = { anthropic: readSetting('ai.anthropic.api_key'), openai: readSetting('ai.openai.api_key') };

  return Promise.all(Object.entries(MODEL_CATALOGUE).map(async ([provider, staticModels]) => {
    const live = await liveModels(provider, apiKeys[provider]);
    // Live wins on shared ids; anything only in the static list still shows
    // (a model the provider stopped listing but still serves, or - for
    // Manus, which has no list API - the only source there is).
    const byId = new Map(staticModels.map((m) => [m.id, m]));
    for (const m of live ?? []) byId.set(m.id, { ...byId.get(m.id), ...m });
    return {
      provider,
      configured: !!status[provider]?.configured,
      supportsImages: !!status[provider]?.supportsImages,
      current: status[provider]?.model ?? null,
      currentEffort: status[provider]?.effort ?? '',
      live: !!live,
      models: [...byId.values()],
    };
  }));
}

// --------------------------------------------------------------- Anthropic

/** Manual-mode thinking's token budget per effort level - kept comfortably
 *  under the 32k the docs warn starts risking request timeouts. */
const ANTHROPIC_EFFORT_BUDGET = { minimal: 1024, low: 4000, medium: 10000, high: 24000, xhigh: 32000, max: 32000 };

async function anthropicComplete({ prompt, system, images = [], maxTokens = 4096, model: override, effort: overrideEffort, signal }) {
  const apiKey = readSetting('ai.anthropic.api_key');
  // A caller may name the exact version for one job - an address check wants a
  // careful model, a title rewrite wants a fast one - without disturbing the
  // saved default.
  const model = override || readSetting('ai.anthropic.model');
  const effort = overrideEffort ?? readSetting('ai.anthropic.effort') ?? '';

  const content = [];
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: img.base64 } });
  }
  content.push({ type: 'text', text: prompt });

  const payload = { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content }] };

  // Only reaches the API when this exact model actually supports it - a
  // model with no thinking capability, or one whose current mode rejects the
  // shape used, silently gets ordinary completion instead of a 400.
  if (effort) {
    const meta = await modelMeta('anthropic', model, apiKey);
    if (meta.thinking === 'adaptive' && meta.effortLevels.includes(effort)) {
      payload.thinking = { type: 'adaptive' };
      payload.output_config = { effort };
    } else if (meta.thinking === 'enabled') {
      const budget = ANTHROPIC_EFFORT_BUDGET[effort] ?? ANTHROPIC_EFFORT_BUDGET.medium;
      payload.thinking = { type: 'enabled', budget_tokens: budget };
      // budget_tokens must stay strictly under max_tokens or the API rejects the request.
      payload.max_tokens = Math.max(maxTokens, budget + 1024);
    }
  }

  const res = await outboundFetch(`${config.ai.anthropic.base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': config.ai.anthropic.version, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status, `Anthropic error: ${body?.error?.message || res.statusText}`);

  return {
    text: (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(),
    model: body.model,
    usage: body.usage,
    raw: body,
  };
}

// ------------------------------------------------------------------ OpenAI

async function openaiComplete({ prompt, system, images = [], maxTokens = 4096, model: override, effort: overrideEffort, signal }) {
  const apiKey = readSetting('ai.openai.api_key');
  const model = override || readSetting('ai.openai.model');
  const effort = overrideEffort ?? readSetting('ai.openai.effort') ?? '';

  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}` } });
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }];

  const payload = { model, messages, max_tokens: maxTokens };
  // Only sent when this exact model is known to take it - a model that
  // rejects the parameter gets an ordinary completion instead of a 400.
  if (effort) {
    const meta = await modelMeta('openai', model, apiKey);
    if (meta.effortLevels.includes(effort)) payload.reasoning_effort = effort;
  }

  const res = await outboundFetch(`${config.ai.openai.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status, `OpenAI error: ${body?.error?.message || res.statusText}`);

  return { text: body.choices?.[0]?.message?.content?.trim() ?? '', model: body.model, usage: body.usage, raw: body };
}

/**
 * The only output sizes OpenAI's image model will produce.
 *
 * Any other size has to be reached by asking for the nearest shape and then
 * scaling, which is done in the browser where a canvas is free - rather than by
 * pulling a native image library into a project that has to install cleanly on
 * a Windows machine with no build tools.
 */
export const SUPPORTED_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

/**
 * Pick the supported size whose shape is closest to what was asked for, so the
 * scale afterwards is a resize and not a distortion.
 */
export function nearestSupportedSize(size) {
  const m = /^(\d{2,5})\s*[x\u00d7*]\s*(\d{2,5})$/i.exec(String(size || '').trim());
  if (!m) return { request: '1024x1024', exact: true, width: 1024, height: 1024 };

  const width = Number(m[1]);
  const height = Number(m[2]);
  const wanted = width / height;

  let best = SUPPORTED_IMAGE_SIZES[0];
  let bestGap = Infinity;
  for (const candidate of SUPPORTED_IMAGE_SIZES) {
    const [cw, ch] = candidate.split('x').map(Number);
    const gap = Math.abs(Math.log(cw / ch) - Math.log(wanted));
    if (gap < bestGap) { bestGap = gap; best = candidate; }
  }
  return {
    request: best,
    exact: SUPPORTED_IMAGE_SIZES.includes(`${width}x${height}`),
    width,
    height,
  };
}

/**
 * Image editing / generation. Only OpenAI exposes this today.
 *
 * `n` asks for several results from one prompt. Sizes outside the three the
 * model supports are honoured by asking for the closest shape and reporting
 * what was actually produced, so the caller can scale it.
 */
export async function editImage({ prompt, image, size = '1024x1024', n = 1, signal }) {
  const apiKey = readSetting('ai.openai.api_key');
  if (!apiKey) throw badRequest('Image editing needs an OpenAI API key (Settings > AI).');
  const model = readSetting('ai.openai.image_model');
  const count = Math.min(Math.max(1, Number(n) || 1), 10);
  const target = nearestSupportedSize(size);

  const shape = (body) => ({
    images: (body.data ?? []).map((d) => ({ b64: d.b64_json ?? null, url: d.url ?? null })),
    // Kept so existing callers that read .b64 still work.
    b64: body.data?.[0]?.b64_json ?? null,
    url: body.data?.[0]?.url ?? null,
    producedSize: target.request,
    requestedSize: `${target.width}x${target.height}`,
    needsResize: !target.exact,
    raw: body,
  });

  if (image) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', target.request);
    if (count > 1) form.append('n', String(count));
    form.append('image', new Blob([image.buffer], { type: image.mime || 'image/png' }), image.filename || 'image.png');
    const res = await outboundFetch(`${config.ai.openai.base}/v1/images/edits`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AppError(res.status, `OpenAI image edit failed: ${body?.error?.message || res.statusText}`);
    return shape(body);
  }

  const res = await outboundFetch(`${config.ai.openai.base}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size: target.request, n: count }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status, `OpenAI image generation failed: ${body?.error?.message || res.statusText}`);
  return shape(body);
}

const IMPLS = { manus: manusComplete, anthropic: anthropicComplete, openai: openaiComplete };

/** Single entry point for text generation. */
export async function complete({ provider, ...opts }) {
  const chosen = resolveProvider(provider, { needsImages: (opts.images?.length ?? 0) > 0 });
  const started = Date.now();
  const result = await IMPLS[chosen](opts);
  return { ...result, provider: chosen, durationMs: Date.now() - started };
}
