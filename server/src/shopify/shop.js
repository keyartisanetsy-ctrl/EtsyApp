import { getStoredShopifyToken, listShopifyAccounts } from './client.js';
import { unauthorized } from '../lib/errors.js';

/** The active store's internal id, required by most write operations. */
export function requireShopifyShopId() {
  const token = getStoredShopifyToken();
  if (!token) throw unauthorized('No Shopify store is connected. Open the Shopify tab and connect one.');
  return token.id;
}

/** The active store's internal id, or null when nothing is connected. Use
 *  this to scope local queries: it must never throw, because the screens
 *  render before a store is connected. */
export function activeShopifyShopId() {
  try { return getStoredShopifyToken()?.id ?? null; } catch { return null; }
}

export function currentShopifyShop() {
  const token = getStoredShopifyToken();
  if (!token) return null;
  return {
    id: token.id,
    shopDomain: token.shop_domain,
    shopName: token.shop_name,
    label: token.label || '',
    airtableName: token.airtable_name || token.shop_domain,
  };
}

export { listShopifyAccounts };
