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
    anthropic: { configured: !!readSetting('ai.anthropic.api_key'), supportsImages: true, async: false, model: readSetting('ai.anthropic.model') },
    openai: { configured: !!readSetting('ai.openai.api_key'), supportsImages: true, async: false, model: readSetting('ai.openai.model') },
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

// --------------------------------------------------------------- Anthropic

async function anthropicComplete({ prompt, system, images = [], maxTokens = 4096, signal }) {
  const apiKey = readSetting('ai.anthropic.api_key');
  const model = readSetting('ai.anthropic.model');

  const content = [];
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: img.base64 } });
  }
  content.push({ type: 'text', text: prompt });

  const res = await outboundFetch(`${config.ai.anthropic.base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': config.ai.anthropic.version, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content }] }),
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

async function openaiComplete({ prompt, system, images = [], maxTokens = 4096, signal }) {
  const apiKey = readSetting('ai.openai.api_key');
  const model = readSetting('ai.openai.model');

  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}` } });
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }];

  const res = await outboundFetch(`${config.ai.openai.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
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
