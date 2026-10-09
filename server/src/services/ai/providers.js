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

export const PROVIDERS = ['manus', 'anthropic', 'openai', 'gemini', 'openrouter'];

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
    gemini: {
      configured: !!readSetting('ai.gemini.api_key'), supportsImages: true, async: false,
      model: readSetting('ai.gemini.model'), effort: '',
    },
    openrouter: {
      configured: !!readSetting('ai.openrouter.api_key'), supportsImages: true, async: false,
      model: readSetting('ai.openrouter.model'), effort: '',
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
        ? 'No AI provider with image support is configured. Add an Anthropic, OpenAI, Gemini or OpenRouter key in Settings.'
        : 'No AI provider is configured. Add a Manus, Anthropic, OpenAI, Gemini or OpenRouter key in Settings.',
    );
  }
  if (fallback !== wanted) log.warn(`provider "${wanted}" unusable here, using "${fallback}"`);
  return fallback;
}

// ------------------------------------------------------------------- Manus
//
// Rebuilt against Manus's current v2 API (open.manus.ai/docs/v2) - the
// previous version of this called a v1 shape (`POST /v1/tasks`, an `API_KEY`
// header, a flat `{prompt, agentProfile}` body) that the live API no longer
// documents. v2's real shape: auth is the `x-manus-api-key` header; task
// creation is `POST /v2/task.create` with the prompt nested under
// `message.content` and the intelligence-tier knob is `agent_profile`
// ('lite' | 'standard' | 'max'); polling is `GET /v2/task.detail`, whose
// `status` is 'running' | 'stopped' | 'waiting' | 'error' - 'stopped' does not
// by itself mean finished (see below); and the actual answer text lives in a
// *separate* call, `GET /v2/task.listMessages`, not in task.detail at all.

async function manusTaskDetail(base, apiKey, taskId, signal) {
  const res = await outboundFetch(`${base}/v2/task.detail?task_id=${encodeURIComponent(taskId)}`, {
    headers: { 'x-manus-api-key': apiKey }, signal,
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body?.task ?? null;
}

async function manusTaskMessages(base, apiKey, taskId, signal) {
  const res = await outboundFetch(`${base}/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}&limit=200`, {
    headers: { 'x-manus-api-key': apiKey }, signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status, `Manus error reading task messages: ${body.message || res.statusText}`);
  return body?.messages ?? [];
}

async function manusComplete({ prompt, system, onProgress, signal }) {
  const apiKey = readSetting('ai.manus.api_key');
  const base = config.ai.manus.base;
  const body = {
    message: { content: system ? `${system}\n\n---\n\n${prompt}` : prompt },
    agent_profile: readSetting('ai.manus.agent_profile') || 'standard',
  };

  const res = await outboundFetch(`${base}/v2/task.create`, {
    method: 'POST',
    headers: { 'x-manus-api-key': apiKey, 'Content-Type': 'application/json' },
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

  const taskId = created.task_id;
  if (!taskId) throw new AppError(502, 'Manus did not return a task id.');
  const taskUrl = created.task_url ?? null;
  onProgress?.({ stage: 'submitted', taskId, taskUrl });

  const deadline = Date.now() + config.ai.manus.timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new AppError(504, `Manus task ${taskId} did not finish within the timeout. It may still complete at ${taskUrl ?? 'manus.im'}.`);
    await sleep(config.ai.manus.pollIntervalMs);

    const task = await manusTaskDetail(base, apiKey, taskId, signal);
    if (!task) { log.warn(`Manus poll for task ${taskId} failed, retrying`); continue; }
    onProgress?.({ stage: task.status, taskId, taskUrl });

    if (task.status === 'error') {
      throw new AppError(502, `Manus task failed${task.error_message ? `: ${task.error_message}` : ''}`);
    }
    // Manus's own docs: a "stopped" main run can still have background work
    // in flight, so it is only treated as finished once has_running_background_jobs
    // is explicitly false - otherwise this keeps polling up to the deadline,
    // same as the docs' own "bounded application polling deadline" advice.
    if (task.status === 'stopped' && task.has_running_background_jobs === false) {
      const messages = await manusTaskMessages(base, apiKey, taskId, signal);
      return { text: extractManusText(messages, task), externalId: taskId, externalUrl: taskUrl, raw: { task, messages } };
    }
    // 'running' and 'waiting' both just keep polling - 'waiting' means Manus
    // wants a confirmation this app has no UI to supply; it either resolves
    // on its own or the task times out above, same as any other stall.
  }
}

/** The answer is the assistant_message events from task.listMessages, in order. */
export function extractManusText(messages, task) {
  const chunks = [];
  for (const m of messages ?? []) {
    if (m.type === 'assistant_message' && m.assistant_message?.content) chunks.push(m.assistant_message.content);
  }
  return chunks.join('\n').trim() || (task?.title ?? '');
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
  // Verified against Anthropic's current model table and thinking/effort
  // reference (2026-09-25) - every model Anthropic serves today, not a
  // hand-picked subset. `defaultEffort` is what the model uses when no
  // `effort` is sent at all - most default to 'high'; Opus 5.5 is the one
  // exception, at 'medium'.
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      note: 'The current Opus and the default model. Thinking can’t be turned off - use effort to control depth. Use it for judgement calls: address checks, mapping, anything you would double-check by hand.' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'The current Sonnet. Nearly Opus-level and quicker - a strong everyday default for listing copy and replies.' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'Anthropic’s most capable widely released model - the most demanding reasoning and long-horizon agentic work. Slower and pricier than Opus; save it for the hardest jobs.' },
    { id: 'claude-fable-5', label: 'Claude Fable 5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'Predecessor to Fable 5.1, same tier and price, still served.' },
    { id: 'claude-opus-5', label: 'Claude Opus 5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'Predecessor to Opus 5.5, a little pricier. Kept in case this is what you have pinned.' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'Previous-generation Opus, still served.' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'Previous-generation Opus - this is the generation ‘xhigh’ effort was introduced on.' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max'], defaultEffort: 'high',
      note: 'Older Opus, no ‘xhigh’ level. Kept here in case it is still what you have pinned.' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'One generation behind Sonnet 5.5, still fully current and fast.' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max'], defaultEffort: 'high',
      note: 'Older Sonnet, no ‘xhigh’ level.' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', thinking: 'enabled', effortLevels: [],
      note: 'Fastest and cheapest. Fine for bulk jobs where each answer is small. No reasoning-effort control - only a thinking budget, which this app does not expose per-request.' },
    { id: 'claude-mythos-5-1', label: 'Claude Mythos 5.1 (restricted access)', thinking: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
      note: 'Same tier as Fable 5.1, available only under Anthropic’s Project Glasswing access program - picking it will fail here unless your account has that access.' },
  ],
  // Verified against the live OpenAI model catalog and its reasoning guide
  // (2026-09-25). Limited to models this app can actually call through Chat
  // Completions with text/vision - the catalog also lists audio, realtime,
  // image-generation, embedding and moderation models, which are separate
  // endpoints this app either doesn't use or calls directly (editImage()
  // below), so they are left out of this picker rather than shown as if they
  // would work with a text prompt. `reasoning.mode` ('standard'/'pro') is a
  // second effort-like dimension OpenAI documents for GPT-5.6/6 - it is a
  // Responses-API field, and this app only calls Chat Completions, so it is
  // not wired up; noted here so the gap is a documented choice, not a miss.
  openai: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      note: "OpenAI's current flagship - the most capable, for the hardest end-to-end work. Reads images. Always reasons - no 'none' level." },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      note: 'Built for complex coding and agentic workflows. Reads images. No ‘none’ or ‘minimal’ level.' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      note: "OpenAI's efficient model for high-volume, everyday tasks. Reads images. A solid everyday default." },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      note: 'Previous version of Sol, replaced by GPT-6.1 Sol above but still served.' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', note: 'Previous-generation coding/agentic model.' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', note: 'Previous-generation efficient model.' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', note: 'Previous-generation GPT-5.6 tier model.' },
    { id: 'gpt-5.6-cyber', label: 'GPT-5.6 Cyber', effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', note: 'Specialised for cybersecurity work - not a general pick for listing/order tasks.' },
    { id: 'gpt-5.5', label: 'GPT-5.5', effortLevels: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium', note: 'Previous flagship generation, still served.' },
    { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', effortLevels: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium', note: 'Higher-cost Pro variant of GPT-5.5.' },
    { id: 'gpt-5.2', label: 'GPT-5.2', effortLevels: ['minimal', 'low', 'medium', 'high'], note: 'Older generation, still served.' },
    { id: 'gpt-5.1', label: 'GPT-5.1', effortLevels: ['minimal', 'low', 'medium', 'high'], note: 'Older generation, still served.' },
    { id: 'gpt-5', label: 'GPT-5', effortLevels: ['minimal', 'low', 'medium', 'high'], note: 'Older generation, still served.' },
    { id: 'o3-pro', label: 'o3-pro', effortLevels: ['low', 'medium', 'high'], note: 'Pure reasoning model, no chat tuning. Slower; used for the hardest analytical problems only.' },
    { id: 'o3', label: 'o3', effortLevels: ['low', 'medium', 'high'], note: 'Pure reasoning model, no chat tuning.' },
    { id: 'gpt-4.1', label: 'GPT-4.1', effortLevels: [], note: 'Previous-generation, non-reasoning, still generally available. Reads images.' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', effortLevels: [], note: 'Previous-generation, cheap bulk option. Reads images.' },
    { id: 'gpt-4o', label: 'GPT-4o', effortLevels: [], note: 'Previous-generation, still generally available. Reads images.' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', effortLevels: [], note: 'Previous-generation, cheap bulk option. Reads images.' },
  ],
  // Gemini and OpenRouter take any model id the account can use; these are the
  // vision-capable ones worth offering. No reasoning-effort control is wired up.
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', effortLevels: [], note: 'Fast and cheap, reads images well. A free tier exists - a good first engine for warehouse photos.' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', effortLevels: [], note: 'The cheapest Gemini. Fine for easy photos, may miss details.' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', effortLevels: [], note: 'The most careful Gemini - for photos the others get wrong.' },
  ],
  openrouter: [
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (via OpenRouter)', effortLevels: [], note: 'One OpenRouter key, many engines. Cheap and reads images.' },
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet (via OpenRouter)', effortLevels: [], note: 'Claude through OpenRouter.' },
    { id: 'openai/gpt-4o', label: 'GPT-4o (via OpenRouter)', effortLevels: [], note: 'OpenAI through OpenRouter.' },
    { id: 'qwen/qwen2.5-vl-72b-instruct', label: 'Qwen2.5-VL 72B (via OpenRouter)', effortLevels: [], note: 'Open vision model that is strong with Chinese text on labels and boxes.' },
  ],
  // Manus has no live model-list endpoint (its /v2/agent.list is for the
  // agents you have configured, not Manus's own model tiers) - agent_profile
  // is a small, documented enum, verified against the current v2 API
  // reference (open.manus.ai/docs/v2/task.create), so this static list IS
  // the full truth rather than a fallback the way the other two providers'
  // catalogues are. Older version strings ("manus-1.6" etc.) are still
  // accepted by the API as "versioned forms" but no longer the documented
  // way to ask for a tier, so they are not offered here.
  manus: [
    { id: 'lite', label: 'Manus Lite', note: 'Fastest and cheapest - lighter reasoning, good for a quick, low-stakes task.' },
    { id: 'standard', label: 'Manus Standard', note: 'The default balance of speed, cost and reasoning depth.' },
    { id: 'max', label: 'Manus Max', note: 'Most thorough reasoning Manus offers - slower and costs more credits, for the hardest research/agentic tasks.' },
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

/**
 * OpenAI's model levels only where the family is known to take one - the
 * plain `/v1/models` list returns ids with no capability metadata at all, so
 * this name-based guess is what actually annotates the *live* list (the
 * static MODEL_CATALOGUE above is only the offline fallback). Patterns
 * verified against OpenAI's current model catalog and reasoning guide
 * (2026-09-25): Astra and Luna always reason (no 'none'); Sol (6 and 6.1)
 * additionally drops 'minimal'; the 5.x/o-series reasoning families take the
 * older, shorter scale. Wrong for a future name this does not recognise only
 * means the effort picker stays hidden for it - the model id itself is
 * unaffected and still works normally.
 */
function guessOpenAiEffortLevels(id) {
  if (/^gpt-6-astra/i.test(id)) return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-6(\.\d+)?-sol/i.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-6-luna/i.test(id)) return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-5\.6-(sol|luna|terra|cyber)/i.test(id)) return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-5\.5(-pro)?$/i.test(id)) return ['minimal', 'low', 'medium', 'high'];
  if (/^o[134](-pro|-mini)?$/i.test(id)) return ['low', 'medium', 'high'];
  if (/^gpt-5(\.\d+)?(-mini|-nano|-pro)?$/i.test(id)) return ['minimal', 'low', 'medium', 'high'];
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
  // 'fast' is a quick look at a picture: no extended thinking, whatever the saved
  // effort is for the slower text jobs.
  const effort = overrideEffort === 'fast' ? '' : (overrideEffort ?? readSetting('ai.anthropic.effort') ?? '');

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
    tokens: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
    raw: body,
  };
}

// ------------------------------------------------------------------ OpenAI

/**
 * Which name this OpenAI-compatible endpoint wants for the output cap. OpenAI
 * itself now takes only `max_completion_tokens` (its newer models reject the
 * old `max_tokens` outright), while some compatible servers still only know
 * the old name - so the one that works is tried first and remembered.
 */
const OPENAI_TOKEN_PARAM = new Map();

/** What "fast" means for a reasoning model: the least thinking this model allows. */
const FAST_EFFORT_ORDER = ['none', 'minimal', 'low'];

async function openaiComplete({ prompt, system, images = [], maxTokens = 4096, model: override, effort: overrideEffort, signal }) {
  const apiKey = readSetting('ai.openai.api_key');
  const model = override || readSetting('ai.openai.model');
  const wanted = overrideEffort ?? readSetting('ai.openai.effort') ?? '';

  // `detail` sets what a picture costs: "low" is one flat 85 tokens however big
  // the photo is, "high" is up to ~765 for a normal photo (more for a huge one).
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}`, ...(img.detail ? { detail: img.detail } : {}) },
    });
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }];

  const meta = await modelMeta('openai', model, apiKey);
  const levels = meta.effortLevels ?? [];
  const effort = wanted === 'fast' ? (FAST_EFFORT_ORDER.find((l) => levels.includes(l)) ?? '') : wanted;
  const payload = { model, messages };
  // Only sent when this exact model is known to take it - a model that
  // rejects the parameter gets an ordinary completion instead of a 400.
  if (effort && levels.includes(effort)) payload.reasoning_effort = effort;

  // A reasoning model spends its hidden thinking out of the same output cap
  // as the answer. Capped at just the answer's size it can use everything on
  // thinking and return nothing, so it gets the thinking budget on top - the
  // same per-effort allowance the Anthropic path uses. A ceiling, not a spend.
  const reasons = levels.length > 0 || /^(o\d|gpt-[5-9])/i.test(model);
  const thinkingRoom = !reasons || effort === 'none' ? 0
    : (ANTHROPIC_EFFORT_BUDGET[effort || meta.defaultEffort || 'medium'] ?? ANTHROPIC_EFFORT_BUDGET.medium);
  const budget = maxTokens + thinkingRoom;

  const url = `${config.ai.openai.base}/v1/chat/completions`;
  const remembered = OPENAI_TOKEN_PARAM.get(config.ai.openai.base);
  const order = remembered === 'max_tokens' ? ['max_tokens', 'max_completion_tokens'] : ['max_completion_tokens', 'max_tokens'];

  let res;
  let body;
  for (const param of order) {
    // eslint-disable-next-line no-await-in-loop
    res = await outboundFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, [param]: budget }),
      signal,
    });
    // eslint-disable-next-line no-await-in-loop
    body = await res.json().catch(() => ({}));
    if (res.ok) { OPENAI_TOKEN_PARAM.set(config.ai.openai.base, param); break; }
    const complaint = res.status === 400 && /max_tokens|max_completion_tokens/i.test(String(body?.error?.message ?? ''));
    if (!complaint) break;
  }
  if (!res.ok) throw new AppError(res.status, `OpenAI error: ${body?.error?.message || res.statusText}`);

  const choice = body.choices?.[0];
  const text = choice?.message?.content?.trim() ?? '';
  if (!text && choice?.finish_reason === 'length') {
    throw new AppError(502, 'OpenAI used its whole output allowance thinking and never answered. Lower the reasoning effort in Settings > AI, or try again.');
  }
  return {
    text, model: body.model, usage: body.usage, raw: body,
    tokens: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 },
  };
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
/**
 * Every setting OpenAI's image endpoints take, as the picture-editing box offers them. `values` are the choices of the
 * person; 'auto' / '' mean "leave it to the model" and are not sent.
 */
export const OPENAI_IMAGE_PARAMS = {
  size: { label: 'Size & orientation', def: 'match', choices: [
    { id: 'match', label: 'Match the picture (nearest shape)' },
    { id: 'auto', label: 'Auto (the model decides)' },
    { id: '1024x1024', label: 'Square (1024x1024)' },
    { id: '1024x1536', label: 'Portrait (1024x1536)' },
    { id: '1536x1024', label: 'Landscape (1536x1024)' },
    { id: '2560x1440', label: '2K (2560x1440)' },
    { id: '3840x2160', label: '4K (3840x2160)' },
  ] },
  quality: { label: 'Quality', def: 'medium', choices: [
    { id: 'auto', label: 'Auto' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  ] },
  outputFormat: { label: 'Output format', def: 'jpeg', choices: [
    { id: 'jpeg', label: 'JPEG' }, { id: 'png', label: 'PNG' }, { id: 'webp', label: 'WebP (turned into JPEG for Etsy)' },
  ] },
  outputCompression: { label: 'JPEG / WebP compression (1-100, blank = the model\'s own)', def: '' },
  n: { label: 'Number of images', def: 1, min: 1, max: 4 },
  background: { label: 'Background', def: 'auto', choices: [
    { id: 'auto', label: 'Auto' }, { id: 'transparent', label: 'Transparent (PNG / WebP only)' }, { id: 'opaque', label: 'Opaque' },
  ] },
  moderation: { label: 'Moderation', def: 'auto', choices: [{ id: 'auto', label: 'Auto' }, { id: 'low', label: 'Low (less restrictive)' }] },
  inputFidelity: { label: 'Input fidelity (how closely the original is kept)', def: 'auto', choices: [
    { id: 'auto', label: 'Auto' }, { id: 'high', label: 'High - keep the original closely' }, { id: 'low', label: 'Low' },
  ] },
};

const OPTIONAL_WIRE = { quality: 'quality', outputFormat: 'output_format', outputCompression: 'output_compression', background: 'background', moderation: 'moderation', inputFidelity: 'input_fidelity' };

/**
 * Image editing / generation. Only OpenAI exposes this today.
 *
 * `n` asks for several results from one prompt. Sizes outside the three the
 * model supports are honoured by asking for the closest shape and reporting
 * what was actually produced, so the caller can scale it.
 *
 * `options` (see OPENAI_IMAGE_PARAMS) adds the rest of what the endpoint takes. A setting the chosen model does not
 * know is dropped and the request is repeated without it, and the caller is told which ones were ignored.
 */
export async function editImage({ prompt, image, size = '1024x1024', n = 1, model: modelOverride, options = null, signal }) {
  const apiKey = readSetting('ai.openai.api_key');
  if (!apiKey) throw badRequest('Image editing needs an OpenAI API key (Settings > AI).');
  const model = modelOverride || readSetting('ai.openai.image_model');
  const o = options ?? {};
  const count = Math.min(Math.max(1, Number(o.n ?? n) || 1), 10);
  const sizeChoice = o.size && o.size !== 'match' ? o.size : null;
  const target = nearestSupportedSize(size);
  const requestSize = sizeChoice ?? target.request;

  // the optional settings that were asked for (not 'auto' / blank)
  const optional = {};
  for (const [key, wire] of Object.entries(OPTIONAL_WIRE)) {
    const v = o[key];
    if (v === undefined || v === null || v === '' || v === 'auto') continue;
    optional[wire] = String(v);
  }

  const shape = (body, ignored) => ({
    images: (body.data ?? []).map((d) => ({ b64: d.b64_json ?? null, url: d.url ?? null })),
    // Kept so existing callers that read .b64 still work.
    b64: body.data?.[0]?.b64_json ?? null,
    url: body.data?.[0]?.url ?? null,
    producedSize: requestSize,
    requestedSize: `${target.width}x${target.height}`,
    needsResize: !sizeChoice && !target.exact,
    outputFormat: body.output_format ?? optional.output_format ?? 'png',
    ignored,
    usage: body.usage ?? null,
    raw: body,
  });

  const ignored = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let res;
    if (image) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', requestSize);
      if (count > 1) form.append('n', String(count));
      for (const [k, v] of Object.entries(optional)) form.append(k, v);
      form.append('image', new Blob([image.buffer], { type: image.mime || 'image/png' }), image.filename || 'image.png');
      // eslint-disable-next-line no-await-in-loop
      res = await outboundFetch(`${config.ai.openai.base}/v1/images/edits`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal,
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      res = await outboundFetch(`${config.ai.openai.base}/v1/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, size: requestSize, n: count, ...optional }),
        signal,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const body = await res.json().catch(() => ({}));
    if (res.ok) return shape(body, ignored);
    const message = body?.error?.message || res.statusText;
    // a setting this model does not take: leave it out and ask again
    const culprit = Object.keys(optional).find((wire) => (body?.error?.param === wire) || new RegExp(`\\b${wire}\\b`, 'i').test(message));
    if (res.status === 400 && culprit) { delete optional[culprit]; ignored.push(culprit); continue; }
    throw new AppError(res.status, `OpenAI image ${image ? 'edit' : 'generation'} failed: ${message}`);
  }
  throw new AppError(400, 'OpenAI image edit failed: the model refused the settings.');
}

// -------------------------------------------------------- Manus: edit an image
//
// Manus is an agent, not an image endpoint: the picture goes up as an input file (file.upload, then a `file` part in
// the task message), the agent edits it, and the result comes back as an `image` attachment on an assistant message.

const MANUS_IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

async function manusJson(res, what) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const msg = body?.error?.message || body?.message || res.statusText;
    if (res.status === 429) throw new AppError(429, `Manus rejected the request: ${msg || 'credit limit exceeded'}. Top up the Manus account or switch to ChatGPT.`);
    throw new AppError(res.status || 502, `Manus ${what} failed: ${msg}`);
  }
  return body;
}

/** The images an assistant message produced, from task.listMessages. */
export function manusImageAttachments(messages) {
  const out = [];
  for (const m of messages ?? []) {
    for (const a of m.assistant_message?.attachments ?? []) {
      if (a?.url && (a.type === 'image' || /^image\//i.test(a.content_type || ''))) out.push(a);
    }
  }
  return out;
}

/**
 * Edit one picture with a Manus agent. `profile` is its agent profile (lite | standard | max). Resolves to
 * { buffer, mime, taskUrl }.
 */
export async function manusEditImage({ prompt, image, profile, signal, onProgress }) {
  const apiKey = readSetting('ai.manus.api_key');
  if (!apiKey) throw badRequest('Manus needs an API key (Settings > AI).');
  const base = config.ai.manus.base;
  const headers = { 'x-manus-api-key': apiKey, 'Content-Type': 'application/json' };
  const filename = image.filename || `image.${MANUS_IMAGE_EXT[image.mime] || 'jpg'}`;

  // 1. the input file: a record, the bytes to its upload address, then wait for "uploaded"
  const made = await manusJson(await outboundFetch(`${base}/v2/file.upload`, { method: 'POST', headers, body: JSON.stringify({ filename }), signal }), 'file upload');
  const fileId = made.file?.id;
  if (!fileId || !made.upload_url) throw new AppError(502, 'Manus did not give an upload address for the picture.');
  const put = await outboundFetch(made.upload_url, { method: 'PUT', body: image.buffer, signal });
  if (!put.ok) throw new AppError(502, `Manus would not take the picture (${put.status}).`);
  for (let i = 0; ; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const d = await manusJson(await outboundFetch(`${base}/v2/file.detail?file_id=${encodeURIComponent(fileId)}`, { headers: { 'x-manus-api-key': apiKey }, signal }), 'file check');
    if (d.file?.status === 'uploaded') break;
    if (d.file?.status === 'error' || d.file?.status === 'deleted' || i > 20) throw new AppError(502, `Manus could not use the picture${d.file?.error_message ? `: ${d.file.error_message}` : ''}.`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }

  // 2. the task: the picture and what to do with it, answered with the edited picture as an attachment
  const text = `${prompt}\n\nEdit the attached picture exactly as described and give me back the edited picture itself as an image file `
    + '(same framing and proportions as the original). Do not describe it - just return the finished picture.';
  const created = await manusJson(await outboundFetch(`${base}/v2/task.create`, {
    method: 'POST', headers, signal,
    body: JSON.stringify({
      message: { content: [{ type: 'text', text }, { type: 'file', file_id: fileId }] },
      agent_profile: profile || 'lite', hide_in_task_list: false, interactive_mode: false,
    }),
  }), 'task');
  const taskId = created.task_id;
  if (!taskId) throw new AppError(502, 'Manus did not return a task id.');
  const taskUrl = created.task_url ?? null;
  onProgress?.({ stage: 'submitted', taskId, taskUrl });

  // 3. wait for it to finish, then take the picture it produced
  const deadline = Date.now() + config.ai.manus.timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new AppError(504, `Manus did not finish editing the picture in time. It may still complete at ${taskUrl ?? 'manus.im'}.`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(config.ai.manus.pollIntervalMs);
    // eslint-disable-next-line no-await-in-loop
    const task = await manusTaskDetail(base, apiKey, taskId, signal);
    if (!task) continue;
    onProgress?.({ stage: task.status, taskId, taskUrl });
    if (task.status === 'error') throw new AppError(502, `Manus task failed${task.error_message ? `: ${task.error_message}` : ''}`);
    if (task.status === 'stopped' && task.has_running_background_jobs === false) {
      // eslint-disable-next-line no-await-in-loop
      const messages = await manusTaskMessages(base, apiKey, taskId, signal);
      const pics = manusImageAttachments(messages);
      if (!pics.length) throw new AppError(502, `Manus finished but did not return a picture${taskUrl ? ` - see ${taskUrl}` : ''}.`);
      const pic = pics[pics.length - 1];
      // eslint-disable-next-line no-await-in-loop
      const dl = await outboundFetch(pic.url, { signal });
      if (!dl.ok) throw new AppError(502, `Could not download the picture Manus made (${dl.status}).`);
      return { buffer: Buffer.from(await dl.arrayBuffer()), mime: pic.content_type || dl.headers.get('content-type') || 'image/png', taskUrl };
    }
  }
}

// ------------------------------------------------- Gemini / OpenRouter

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const OPENROUTER_BASE = 'https://openrouter.ai/api';

async function geminiComplete({ prompt, system, images = [], maxTokens = 4096, model: override, signal }) {
  const apiKey = readSetting('ai.gemini.api_key');
  const model = override || readSetting('ai.gemini.model');
  const parts = images.map((img) => ({ inline_data: { mime_type: img.mime || 'image/jpeg', data: img.base64 } }));
  parts.push({ text: prompt });
  const payload = {
    ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048), temperature: 0.2 },
  };
  const res = await outboundFetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status, `Gemini error: ${body?.error?.message || res.statusText}`);
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text || '').join('\n').trim();
  if (!text) throw new AppError(502, `Gemini returned no answer${body.promptFeedback?.blockReason ? ` (${body.promptFeedback.blockReason})` : ''}.`);
  return {
    text, model, raw: body,
    tokens: { input: body.usageMetadata?.promptTokenCount ?? 0, output: body.usageMetadata?.candidatesTokenCount ?? 0 },
  };
}

async function openrouterComplete({ prompt, system, images = [], maxTokens = 4096, model: override, signal }) {
  const apiKey = readSetting('ai.openrouter.api_key');
  const model = override || readSetting('ai.openrouter.model');
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/jpeg'};base64,${img.base64}` } });
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }];
  const res = await outboundFetch(`${OPENROUTER_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status, `OpenRouter error: ${body?.error?.message || res.statusText}`);
  const text = body.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new AppError(502, 'OpenRouter returned no answer.');
  return {
    text, model: body.model || model, raw: body,
    tokens: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 },
  };
}

const IMPLS = { manus: manusComplete, anthropic: anthropicComplete, openai: openaiComplete, gemini: geminiComplete, openrouter: openrouterComplete };

/** Single entry point for text generation. */
export async function complete({ provider, ...opts }) {
  const chosen = resolveProvider(provider, { needsImages: (opts.images?.length ?? 0) > 0 });
  const started = Date.now();
  const result = await IMPLS[chosen](opts);
  return { ...result, provider: chosen, durationMs: Date.now() - started };
}
