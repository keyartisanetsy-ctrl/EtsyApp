import { getStoredToken } from './client.js';
import { unauthorized } from '../lib/errors.js';

/** The connected shop's id, required by most write operations. */
export function requireShopId() {
  const token = getStoredToken();
  if (!token) throw unauthorized('No Etsy account connected.');
  if (!token.shop_id) throw unauthorized('Connected, but no shop is linked to this Etsy account.');
  return token.shop_id;
}

export function currentShop() {
  const token = getStoredToken();
  if (!token) return null;
  return { shopId: token.shop_id, shopName: token.shop_name, userId: token.user_id, scopes: token.scopes };
}
