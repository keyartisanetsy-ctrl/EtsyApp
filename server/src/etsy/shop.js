import { getStoredToken, listAccounts } from './client.js';
import { unauthorized } from '../lib/errors.js';

/** The active shop's id, required by most write operations. */
export function requireShopId() {
  const token = getStoredToken();
  if (!token) throw unauthorized('No Etsy shop is connected. Open Settings and connect one.');
  if (!token.shop_id) throw unauthorized('Connected, but no shop is linked to this Etsy account.');
  return token.shop_id;
}

/** The active shop's id, or null when nothing is connected. Use this to scope
 *  local queries: it must never throw, because the screens render before a
 *  shop is connected. */
export function activeShopId() {
  try { return getStoredToken()?.shop_id ?? null; } catch { return null; }
}

export function currentShop() {
  const token = getStoredToken();
  if (!token) return null;
  return {
    shopId: token.shop_id,
    shopName: token.shop_name,
    userId: token.user_id,
    label: token.label || '',
    scopes: token.scopes,
  };
}

export { listAccounts };
