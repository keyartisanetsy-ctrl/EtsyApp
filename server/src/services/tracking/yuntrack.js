/**
 * YunTrack adapter.
 *
 * YunTrack sits behind an Aliyun WAF that rejects requests from datacentre
 * ranges, so this can fail with a 405 even though the number is valid. When it
 * does, the parcel is left on its last known state, `check_error` is recorded,
 * and the operator can still open the parcel with the deep link or set the
 * status by hand. The response parser is deliberately tolerant: YunTrack has
 * shipped several payload shapes and this accepts all of them.
 */
import { classify, fromProviderCode, STATUS } from './status.js';

const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

/** YunTrack returns .NET-style "/Date(1699999999000)/" as well as ISO strings. */
export function parseDate(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();
  const dotnet = /\/Date\((\d+)/.exec(String(value));
  if (dotnet) return new Date(Number(dotnet[1])).toISOString();
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Normalise any of the known YunTrack payload shapes into one parcel record. */
export function normalise(node, requestedCode) {
  const track = node?.Track ?? node?.track ?? node;
  const code = pick(node, 'TrackNumber', 'trackNumber', 'Number', 'number', 'WaybillNumber')
    ?? requestedCode;

  const rawEvents =
    track?.TrackingList ?? track?.trackingList ?? track?.Events ?? track?.events ??
    node?.TrackingList ?? node?.Events ?? [];

  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .map((e) => {
      const desc = pick(e, 'TrackContent', 'trackContent', 'Description', 'description',
                        'StatusDescription', 'Content', 'context') ?? '';
      return {
        at: parseDate(pick(e, 'TrackDate', 'trackDate', 'Date', 'date', 'time', 'ProcessDate')),
        description: String(desc).trim(),
        location: String(pick(e, 'TrackLocation', 'trackLocation', 'Location', 'location', 'City') ?? '').trim(),
      };
    })
    .filter((e) => e.description || e.at)
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  const providerStatus = pick(track ?? {}, 'PackageStatus', 'packageStatus', 'Status', 'status');
  const numericCode = pick(track ?? {}, 'TrackStatus', 'StatusCode', 'statusCode');

  const status =
    fromProviderCode(numericCode) ??
    classify(String(providerStatus ?? '')) ??
    classify(events[0]?.description ?? '') ??
    (events.length ? STATUS.IN_TRANSIT : STATUS.NOT_FOUND);

  return {
    code,
    status,
    statusDetail: String(providerStatus ?? events[0]?.description ?? '').slice(0, 300),
    originCountry: pick(track ?? {}, 'CountryCode', 'Origin', 'origin') ?? null,
    destinationCountry: pick(track ?? {}, 'DestinationCountryCode', 'Destination', 'destination') ?? null,
    events,
    raw: node,
  };
}

export async function fetchTracking(codes, { endpoint, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.yuntrack.com',
        Referer: 'https://www.yuntrack.com/parcelTracking',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      },
      body: JSON.stringify({ NumberList: codes, Year: 0 }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`YunTrack responded ${res.status}. ${res.status === 405 || res.status === 403
        ? 'The endpoint is refusing automated requests from this network; use the deep link or set the status manually.'
        : text.slice(0, 200)}`);
    }

    let body;
    try { body = JSON.parse(text); } catch { throw new Error('YunTrack returned a non-JSON response (likely a WAF challenge page).'); }

    const list = body?.ResultList ?? body?.resultList ?? body?.data ?? (Array.isArray(body) ? body : []);
    const byCode = new Map();
    for (const node of Array.isArray(list) ? list : []) {
      const parcel = normalise(node);
      if (parcel.code) byCode.set(String(parcel.code), parcel);
    }
    return codes.map((c) => byCode.get(String(c)) ?? { code: c, status: STATUS.NOT_FOUND, events: [], statusDetail: 'No data returned', raw: null });
  } finally {
    clearTimeout(timer);
  }
}
