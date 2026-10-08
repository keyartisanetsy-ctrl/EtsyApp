/**
 * Run something as the shop an order belongs to.
 *
 * Several order helpers read "the open shop" (the one chosen in the top bar). The packing list and the supply entries
 * work on the orders of every connected shop at once, so each order operation has to run inside its own shop's
 * context, whichever shop happens to be open - otherwise an order of another shop is "not in the local mirror".
 */
import { getDb } from '../db/index.js';
import { withShop } from '../etsy/client.js';
import { withShopifyShop } from '../shopify/client.js';

/** The shop id an order belongs to, or null when the order is not in the local mirror. */
export function shopOfOrder(channel, orderId) {
  const db = getDb();
  if (channel === 'etsy') return db.prepare('SELECT shop_id FROM receipts WHERE receipt_id = ?').get(Number(orderId))?.shop_id ?? null;
  if (channel === 'shopify') return db.prepare('SELECT shop_id FROM shopify_orders WHERE order_id = ?').get(String(orderId))?.shop_id ?? null;
  return null;
}

/** fn() inside the order's own shop (returns whatever fn returns, promise included). An unknown order runs fn as it is. */
export function inOrderShop(channel, orderId, fn) {
  const shopId = shopOfOrder(channel, orderId);
  if (shopId == null) return fn();
  return channel === 'etsy' ? withShop(shopId, fn) : withShopifyShop(shopId, fn);
}
