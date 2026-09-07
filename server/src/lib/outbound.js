/**
 * Every outbound request the app makes goes through here.
 *
 * The goal is that nothing about the operator, their machine or their location
 * travels with a request beyond what the destination protocol unavoidably
 * sees. Node's fetch would otherwise attach a small set of default headers;
 * they are replaced with an explicit, fixed set so behaviour does not drift
 * with the Node version.
 *
 * What this CANNOT hide: the IP address. Any direct TCP connection reveals it
 * to the other end, and no application-level change alters that. Routing
 * through a VPN or proxy is the only remedy, so a proxy setting exists and the
 * Settings screen states this plainly rather than implying more than is true.
 */
import { readSetting } from '../services/settings.js';
import { createLogger } from './logger.js';

const log = createLogger('outbound');

/**
 * A neutral, constant User-Agent. Node's default is the bare string "node",
 * which leaks nothing, but pinning it means a future Node release cannot start
 * sending version or platform details on our behalf.
 */
export const USER_AGENT = 'EtsyCommandCenter/1.0';

/** Headers Node attaches by default that carry no value for these APIs. */
const STRIPPED = ['accept-language', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'origin', 'referer'];

let proxyAgent = null;
let proxyWarned = false;

/**
 * Build an undici ProxyAgent when a proxy is configured. undici ships with
 * Node, so this needs no dependency; if the runtime lacks it we say so once
 * rather than silently sending traffic direct.
 */
async function getDispatcher() {
  // Settings live in the database, which may not be open yet on the very first
  // call. A missing proxy setting must never break a request.
  let proxyUrl = '';
  try { proxyUrl = readSetting('privacy.proxy_url'); } catch { return null; }
  if (!proxyUrl) return null;
  if (proxyAgent?.url === proxyUrl) return proxyAgent.agent;
  try {
    const { ProxyAgent } = await import('undici');
    proxyAgent = { url: proxyUrl, agent: new ProxyAgent(proxyUrl) };
    log.info(`routing outbound traffic through the configured proxy`);
    return proxyAgent.agent;
  } catch (err) {
    if (!proxyWarned) {
      log.warn(`proxy configured but unusable (${err.message}); traffic is going direct`);
      proxyWarned = true;
    }
    return null;
  }
}

/**
 * fetch with a fixed header set and optional proxying.
 * `headers` supplied by the caller win, so an API's required headers still work.
 */
export async function outboundFetch(url, options = {}) {
  const headers = {
    // Explicit and minimal. No locale, no platform, no machine identifiers.
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    ...(options.headers || {}),
  };

  for (const name of STRIPPED) {
    // Only strip when the caller has not deliberately set it (YunTrack, for
    // instance, needs an Origin to be served at all).
    if (!(name in (options.headers || {})) && !(name.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase()) in (options.headers || {}))) {
      delete headers[name];
    }
  }

  const dispatcher = await getDispatcher();
  return fetch(url, { ...options, headers, ...(dispatcher ? { dispatcher } : {}) });
}

/** Everything this app can talk to, and why. Rendered in Settings. */
export const DESTINATIONS = [
  {
    host: 'openapi.etsy.com / www.etsy.com',
    purpose: 'Your shop data: listings, orders, tracking uploads. Required.',
    sends: 'Your API key, your OAuth token, and the shop data you act on.',
    optional: false,
  },
  {
    host: 'api.manus.ai',
    purpose: 'AI replies and listing text, only when you press an AI button.',
    sends: 'The prompt and the text you supply (which may include a buyer message).',
    optional: true,
  },
  {
    host: 'api.anthropic.com',
    purpose: 'AI replies, listing text and screenshot reading.',
    sends: 'The prompt, your text, and any screenshot you attach.',
    optional: true,
  },
  {
    host: 'api.openai.com',
    purpose: 'AI text and image editing.',
    sends: 'The prompt, your text, and any image you supply.',
    optional: true,
  },
  {
    host: 'api.airtable.com',
    purpose: 'Sending your orders to your own Airtable bases, only when you press Send or enable auto-push.',
    sends: 'Your Airtable token and the order fields you mapped (which include buyer name and address).',
    optional: true,
  },
  {
    host: 'services.yuntrack.com / www.yuntrack.com',
    purpose: 'Parcel tracking lookups.',
    sends: 'Only the tracking numbers you ask about.',
    optional: true,
  },
  {
    host: 'api.17track.net',
    purpose: 'Alternative parcel tracking, only if you configure a key.',
    sends: 'Only the tracking numbers you ask about.',
    optional: true,
  },
];
