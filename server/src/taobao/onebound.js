/**
 * OneBound (万邦数据) - a paid, documented data API for reading a live
 * Taobao/Tmall product: https://open.onebound.cn
 *
 * This is not scraping - Taobao's own pages are script-rendered and blocked
 * to bots, so the rest of this app never tries to read them directly (see
 * services/taobao.js). OneBound is a real API a seller pays for, which is
 * what makes checking a live product's stock and price possible at all.
 *
 * No signature/HMAC step - per OneBound's own docs, a request is just
 * key + secret + parameters in the query string. Getting a parameter wrong
 * still gets billed ("参数不要乱传，否则不管成功失败都会扣费" - wrong
 * parameters are charged whether the call succeeds or not), so every call
 * here is deliberate: this app only ever calls OneBound when a person presses
 * a "check stock" button, never on a timer or in a background sync.
 */
import { readSetting } from '../services/settings.js';
import { outboundFetch } from '../lib/outbound.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('onebound');
const BASE = 'https://api-gw.onebound.cn';

export function getCredentials() {
  return { key: readSetting('taobao.onebound_key'), secret: readSetting('taobao.onebound_secret') };
}

export const hasCredentials = () => !!getCredentials().key;

async function call(apiName, params = {}, { platform = 'taobao' } = {}) {
  const { key, secret } = getCredentials();
  if (!key) throw badRequest('Set your OneBound API key first, in Supply book → Stock check settings.');

  const url = new URL(`${BASE}/${platform}/${apiName}/`);
  url.searchParams.set('key', key);
  url.searchParams.set('secret', secret || '');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await outboundFetch(url.toString());
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw badRequest(`OneBound did not return JSON: ${text.slice(0, 200)}`); }

  // Different endpoints wrap the product differently - item_get_pro_v1 nests
  // it under "item" with an error_code/reason envelope; the plainer
  // endpoints return the product fields directly. Handle both.
  const item = body.item ?? body;
  const errorCode = body.error_code ?? item?.error_code;
  if (errorCode !== undefined && errorCode !== null && String(errorCode) !== '0000' && String(errorCode) !== '0') {
    throw badRequest(item?.reason || body.reason || `OneBound error ${errorCode}`);
  }
  if (!item || (item.num_iid === undefined && item.title === undefined)) {
    log.warn(`unexpected OneBound shape for ${apiName}: ${text.slice(0, 300)}`);
    throw badRequest('OneBound did not return a recognisable product - the item id may be wrong or the listing removed.');
  }
  return item;
}

/** Fast, cheap: current price, main sku list, approximate overall stock. */
export const itemGet = (numIid, { platform = 'taobao' } = {}) =>
  call('item_get', { num_iid: numIid, is_promotion: 1 }, { platform });

/** More complete: exact per-sku quantities, delist_time, promotion price. */
export const itemGetPro = (numIid, { platform = 'taobao' } = {}) =>
  call('item_get_pro', { num_iid: numIid }, { platform });

/** The newest shape; falls back to item_get_pro if it is not enabled on this key. */
export async function itemGetProV1(numIid, { platform = 'taobao' } = {}) {
  try { return await call('item_get_pro_v1', { num_iid: numIid }, { platform }); }
  catch (err) { log.warn(`item_get_pro_v1 unavailable (${err.message}), falling back to item_get_pro`); return itemGetPro(numIid, { platform }); }
}
