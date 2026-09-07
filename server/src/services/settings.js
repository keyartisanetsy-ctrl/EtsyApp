/**
 * App settings resolve DB-first, then .env, then a built-in default, so the
 * UI can change anything without editing files, and .env still works for
 * headless deployments.
 */
import config from '../config.js';
import { getDb, getSetting, setSetting, deleteSetting } from '../db/index.js';
import { maskSecret } from '../lib/crypto.js';

/** key -> { env fallback, default, secret? } */
export const SETTING_DEFS = {
  'etsy.keystring':        { env: config.etsy.keystring, def: '', secret: true, label: 'Etsy keystring' },
  'etsy.shared_secret':    { env: config.etsy.sharedSecret, def: '', secret: true, label: 'Etsy shared secret' },
  'etsy.redirect_uri':     { env: config.etsy.redirectUri, def: `http://${config.publicHost}:${config.port}/api/auth/callback`, label: 'OAuth redirect URI' },

  'ai.provider':           { env: config.ai.defaultProvider, def: 'manus', label: 'Default AI provider',
    options: [
      { value: 'manus', label: 'Manus (agent, async, text only)' },
      { value: 'anthropic', label: 'Anthropic (fast, reads images)' },
      { value: 'openai', label: 'OpenAI (fast, reads images, edits images)' },
    ] },
  'ai.manus.api_key':      { env: config.ai.manus.apiKey, def: '', secret: true, label: 'Manus API key' },
  'ai.manus.agent_profile':{ env: config.ai.manus.agentProfile, def: 'manus-1.6', label: 'Manus agent profile' },
  'ai.anthropic.api_key':  { env: config.ai.anthropic.apiKey, def: '', secret: true, label: 'Anthropic API key' },
  'ai.anthropic.model':    { env: config.ai.anthropic.model, def: 'claude-sonnet-4-5', label: 'Anthropic model' },
  'ai.openai.api_key':     { env: config.ai.openai.apiKey, def: '', secret: true, label: 'OpenAI API key' },
  'ai.openai.model':       { env: config.ai.openai.model, def: 'gpt-4o', label: 'OpenAI model' },
  'ai.openai.image_model': { env: config.ai.openai.imageModel, def: 'gpt-image-1', label: 'OpenAI image model' },

  'tracking.provider':     { env: config.tracking.provider, def: 'yuntrack', label: 'Tracking provider',
    options: [
      { value: 'yuntrack', label: 'YunTrack (direct query)' },
      { value: 'yuntrack-browser', label: 'YunTrack (via a real browser)' },
      { value: 'seventeentrack', label: '17TRACK (paid API key)' },
      { value: 'manual', label: 'Manual only (no automatic lookups)' },
    ] },
  'tracking.url_template': { env: config.tracking.publicUrlTemplate, def: 'https://www.yuntrack.com/parcelTracking?id={code}', label: 'Tracking link template' },
  'tracking.stale_days':   { env: String(config.tracking.staleAfterDays), def: '4', label: 'Alert after N days without movement' },
  'tracking.sync_minutes': { env: String(config.tracking.autoSyncMinutes), def: '180', label: 'Auto-sync interval (minutes)' },
  'tracking.seventeentrack_key': { env: config.tracking.seventeentrackKey, def: '', secret: true, label: '17TRACK API key' },
  'tracking.api_endpoint':  { env: process.env.YUNTRACK_API || '', def: 'https://services.yuntrack.com/Track/Query', label: 'YunTrack query endpoint' },
  'tracking.browser_headed':{ env: '', def: 'false', label: 'Show the browser window (to solve a captcha once)' },
  'tracking.browser_path':  { env: process.env.PLAYWRIGHT_CHROMIUM_PATH || '', def: '', label: 'Chromium path for the browser provider' },

  'privacy.proxy_url':     { env: process.env.OUTBOUND_PROXY || '', def: '', label: 'Outbound proxy (masks your IP)' },
  'privacy.share_ai':      { env: '', def: 'true', label: 'Allow AI features to send your text to the AI provider',
    options: [ { value: 'true', label: 'Yes - AI features work' }, { value: 'false', label: 'No - block all AI calls' } ] },

  'etsy.write_gap_ms':     { env: '', def: '1200', label: 'Pause between writes to Etsy (milliseconds)' },

  'reporting.currency':    { env: '', def: 'USD', label: 'Currency to report money in',
    options: [
      { value: 'USD', label: 'USD - US dollar' },
      { value: 'TRY', label: 'TRY - Turkish lira' },
      { value: 'EUR', label: 'EUR - Euro' },
      { value: 'GBP', label: 'GBP - Pound' },
      { value: 'CNY', label: 'CNY - Yuan' },
    ] },

  'fx.history_days':       { env: '', def: '95', label: 'How many days of exchange rates to keep' },
  'fx.auto_refresh':       { env: '', def: 'true', label: 'Refresh exchange rates automatically',
    options: [ { value: 'true', label: 'Yes - keep the daily rates current' }, { value: 'false', label: 'No - only when I press refresh' } ] },
  'orders.code_template':  { env: '', def: '{YY}-{MM}{DD}-{NN}', label: 'Short order code shape (e.g. 26-0907-01 for 7 September)' },
  'orders.shipping_cost_currency': { env: '', def: 'CNY', label: 'Currency you normally pay shipping in' },

  'airtable.token':        { env: process.env.AIRTABLE_TOKEN || '', def: '', secret: true, label: 'Airtable personal access token' },
  'airtable.auto_push':    { env: '', def: 'false', label: 'Send new orders to Airtable automatically after each sync',
    options: [ { value: 'false', label: 'No - I press the button myself' }, { value: 'true', label: 'Yes - push new orders automatically' } ] },

  'pricing.discount_percent': { env: String(config.pricing.discountPercent), def: '30', label: 'Discount percentage' },
  'orders.ship_days_min':  { env: '', def: '2', label: 'Expected dispatch: minimum business days' },
  'orders.ship_days_max':  { env: '', def: '5', label: 'Expected dispatch: maximum business days' },
  'orders.default_carrier':   { env: '', def: '', label: 'Default carrier for bulk tracking' },
  'orders.notify_buyer':      { env: '', def: 'true', label: 'Email the buyer when tracking is added' },
};

export function readSetting(key) {
  const def = SETTING_DEFS[key];
  if (!def) return getSetting(key, '');
  const stored = getSetting(key, null);
  if (stored !== null && stored !== '') return stored;
  return def.env || def.def;
}

export function writeSetting(key, value) {
  const def = SETTING_DEFS[key] || {};
  if (value === '' || value === null || value === undefined) {
    deleteSetting(key);
    return readSetting(key);
  }
  setSetting(key, String(value), !!def.secret);
  return readSetting(key);
}

/** Safe for the UI: secrets are masked, never returned in full. */
export function listSettings() {
  return Object.entries(SETTING_DEFS).map(([key, def]) => {
    const value = readSetting(key);
    const stored = getSetting(key, null);
    return {
      key,
      label: def.label,
      secret: !!def.secret,
      options: def.options ?? null,
      value: def.secret ? maskSecret(value) : value,
      isSet: !!value,
      source: stored ? 'app' : def.env ? 'env' : 'default',
    };
  });
}

export const getDiscountPercent = () => {
  const n = Number(readSetting('pricing.discount_percent'));
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : 30;
};

export const getStaleDays = () => {
  const n = Number(readSetting('tracking.stale_days'));
  return Number.isFinite(n) && n > 0 ? n : 4;
};

export const trackingUrl = (code) =>
  readSetting('tracking.url_template').replace('{code}', encodeURIComponent(code || ''));

export const isTruthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
