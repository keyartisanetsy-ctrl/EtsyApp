/** Optional 17TRACK adapter - a paid API that works from any network, so it is
 *  the fallback when YunTrack refuses automated requests. */
import { fromProviderCode, classify, STATUS } from './status.js';
import { outboundFetch } from '../../lib/outbound.js';

const BASE = 'https://api.17track.net/track/v2.2';

export async function fetchTracking(codes, { apiKey }) {
  if (!apiKey) throw new Error('17TRACK API key is not configured.');
  const headers = { '17token': apiKey, 'Content-Type': 'application/json' };

  await outboundFetch(`${BASE}/register`, {
    method: 'POST', headers,
    body: JSON.stringify(codes.map((number) => ({ number }))),
  }).catch(() => null); // already-registered numbers return an error we can ignore

  const res = await outboundFetch(`${BASE}/gettrackinfo`, {
    method: 'POST', headers,
    body: JSON.stringify(codes.map((number) => ({ number }))),
  });
  if (!res.ok) throw new Error(`17TRACK responded ${res.status}`);
  const body = await res.json();

  const accepted = body?.data?.accepted ?? [];
  const byCode = new Map();
  for (const item of accepted) {
    const info = item.track_info ?? {};
    const events = (info.tracking?.providers?.[0]?.events ?? []).map((e) => ({
      at: e.time_iso ?? e.time_utc ?? null,
      description: e.description ?? '',
      location: e.location ?? '',
    }));
    byCode.set(String(item.number), {
      code: String(item.number),
      status: fromProviderCode(info.latest_status?.status_code)
        ?? classify(info.latest_status?.status ?? '')
        ?? classify(events[0]?.description ?? '')
        ?? STATUS.IN_TRANSIT,
      statusDetail: info.latest_status?.status ?? '',
      originCountry: info.shipping_info?.shipper_address?.country ?? null,
      destinationCountry: info.shipping_info?.recipient_address?.country ?? null,
      events,
      raw: item,
    });
  }
  return codes.map((c) => byCode.get(String(c)) ?? { code: c, status: STATUS.NOT_FOUND, events: [], statusDetail: 'Not registered', raw: null });
}
