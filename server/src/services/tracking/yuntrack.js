/**
 * YunTrack adapter.
 *
 * YunTrack publishes no developer API, but its own tracking page
 * (https://www.yuntrack.com/parcelTracking?id=<code>) is a Vue app that calls
 * services.yuntrack.com/Track/Query. This implements that same call: the
 * request shape, the HMAC signature and the status codes below were all read
 * off the page's own published bundle, so the contract matches what the site
 * itself sends rather than being guessed.
 *
 *   POST {API_ROOT}/Track/Query
 *   headers: Authorization: "Nebula token:<token>"   (empty for anonymous)
 *   body:    { NumberList, CaptchaVerification, Timestamp, Signature }
 *   Signature = HMAC-SHA256(`Timestamp=<ts>&NumberList=<json>`, SIGN_KEY) hex
 *
 * The endpoint sits behind an Aliyun WAF that rejects some datacentre IPs with
 * a 405 interstitial. That is an IP-reputation block, not a bad request, so it
 * is reported as such and the browser provider is offered as the way round it.
 */
import crypto from 'node:crypto';
import { STATUS } from './status.js';

/** Client-side constant shipped in the public page bundle (not a credential). */
const SIGN_KEY = 'f3c42837e3b46431ddf5d7db7d67017d';
export const API_ROOT = 'https://services.yuntrack.com';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * YunTrack's own TrackingStatus codes, from the page's `filtersStatus` filter:
 *   0 Not Found | 10 Processing | 20,30 Transit | 40,60,70,100 Alert
 *   50 Delivered | 90 Returned
 */
export const YUNTRACK_STATUS = {
  0: STATUS.NOT_FOUND,
  10: STATUS.PRE_SHIPPED,      // "Processing" - label made, not yet moving
  20: STATUS.IN_TRANSIT,
  30: STATUS.IN_TRANSIT,
  40: STATUS.EXCEPTION,        // YunTrack groups 40/60/70/100 under "Alert"
  50: STATUS.DELIVERED,
  60: STATUS.EXCEPTION,
  70: STATUS.EXCEPTION,
  90: STATUS.RETURNED,
  100: STATUS.EXCEPTION,
};

/** The label YunTrack itself shows for a code, so the UI can echo their wording. */
export const YUNTRACK_LABEL = {
  0: 'Not Found', 10: 'Processing', 20: 'Transit', 30: 'Transit',
  40: 'Alert', 50: 'Delivered', 60: 'Alert', 70: 'Alert', 90: 'Returned', 100: 'Alert',
};

export const sign = (timestamp, numberList) =>
  crypto.createHmac('sha256', SIGN_KEY)
    .update(`Timestamp=${timestamp}&NumberList=${JSON.stringify(numberList)}`)
    .digest('hex');

export function buildRequest(codes, { captchaVerification = '' } = {}) {
  const NumberList = codes.map(String);
  const Timestamp = Date.now();
  return {
    NumberList,
    CaptchaVerification: captchaVerification,
    Timestamp,
    Signature: sign(Timestamp, NumberList),
  };
}

/** YunTrack dates arrive as ISO-ish strings, epoch millis, or .NET /Date(...)/. */
export function parseDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();
  const dotnet = /\/Date\((\d+)/.exec(String(value));
  if (dotnet) return new Date(Number(dotnet[1])).toISOString();
  const d = new Date(String(value).trim().replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The page splits ProcessContent on "----" into description and location
 * (see its own `contentAndLocation` helper).
 */
export function splitContent(content) {
  const text = String(content ?? '').trim();
  if (!text.includes('----')) return { description: text, location: '' };
  const [description, ...rest] = text.split('----');
  return { description: description.trim(), location: rest.join('----').trim() };
}

/** Flatten ProcessGroupList -> ProcessDetailList into a newest-first event list. */
export function extractEvents(trackInfo) {
  const events = [];
  for (const group of trackInfo?.ProcessGroupList ?? []) {
    for (const detail of group?.ProcessDetailList ?? []) {
      const { description, location } = splitContent(detail?.ProcessContent);
      if (!description && !detail?.ProcessDate) continue;
      events.push({
        // ProcessDate can be a time-only fragment; fall back to the group date.
        at: parseDate(detail?.ProcessDate) ?? parseDate(group?.ProcessGroupDate),
        description,
        location: location || String(detail?.Comments ?? '').trim(),
        isPod: !!detail?.IsPod,
        podUrl: detail?.Pod ?? null,
      });
    }
  }
  // De-duplicate: the page unshifts a copy of the first detail into each group.
  const seen = new Set();
  return events
    .filter((e) => {
      const key = `${e.at ?? ''}|${e.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.at ?? 0) - new Date(a.at ?? 0));
}

/** Normalise one ResultList entry into the shape the tracking board stores. */
export function normalise(entry, requestedCode) {
  const info = entry?.TrackInfo ?? {};
  const code = info.WaybillNumber ?? entry?.WaybillNumber ?? requestedCode;

  const events = extractEvents(info);
  const rawCode = info.LastTrackEvent?.TrackingStatus ?? info.TrackingStatus;
  const status = YUNTRACK_STATUS[Number(rawCode)] ?? (events.length ? STATUS.IN_TRANSIT : STATUS.NOT_FOUND);

  return {
    code,
    status,
    providerCode: rawCode ?? null,
    statusDetail: (info.TrackingName || YUNTRACK_LABEL[Number(rawCode)] || info.ltsDigest || events[0]?.description || '').slice(0, 300),
    originCountry: info.CountryCode ?? info.OriginCountry ?? null,
    destinationCountry: info.DestinationCountryCode ?? info.DestinationCountry ?? null,
    events,
    podUrl: events.find((e) => e.isPod)?.podUrl ?? null,
    raw: entry,
  };
}

/** Raised when the WAF blocks us rather than the request being wrong. */
export class YunTrackBlocked extends Error {
  constructor(status) {
    super(
      `YunTrack's WAF refused this request (HTTP ${status}). The tracking numbers and the request are fine — `
      + 'this network is being rejected by IP reputation. Switch tracking.provider to "yuntrack-browser" to read '
      + 'the same page a browser would, or to "seventeentrack", or open the parcel link and set the status by hand.',
    );
    this.name = 'YunTrackBlocked';
    this.blocked = true;
  }
}

export async function fetchTracking(codes, { endpoint = `${API_ROOT}/Track/Query`, token = '', timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Authorization: `Nebula token:${token}`,
        Origin: 'https://www.yuntrack.com',
        Referer: 'https://www.yuntrack.com/',
        'User-Agent': BROWSER_UA,
      },
      body: JSON.stringify(buildRequest(codes)),
      signal: controller.signal,
    });

    const text = await res.text();

    // The WAF answers with an HTML interstitial, not JSON.
    if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
      if (res.status === 405 || res.status === 403 || /doctype/i.test(text)) throw new YunTrackBlocked(res.status);
      throw new Error(`YunTrack responded ${res.status}: ${text.slice(0, 160)}`);
    }

    let body;
    try { body = JSON.parse(text); } catch { throw new YunTrackBlocked(res.status); }

    const list = body?.ResultList ?? body?.resultList ?? [];
    const byCode = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
      const parcel = normalise(entry);
      if (parcel.code) byCode.set(String(parcel.code).toUpperCase(), parcel);
    }

    return codes.map((c) => byCode.get(String(c).toUpperCase()) ?? {
      code: c, status: STATUS.NOT_FOUND, events: [], statusDetail: 'YunTrack returned no record for this number', raw: null,
    });
  } finally {
    clearTimeout(timer);
  }
}
