import React from 'react';
import { ShopBadge } from './ui.jsx';

/**
 * Orders still to ship in EVERY connected shop, one chip each, with the total - so a count in one shop's Orders page is
 * never mistaken for "all of them" when the Airtable sheets (and the warehouse) hold every shop's orders.
 */
export default function UnshippedShops({ shops, olderThanRange = 0, compact = false }) {
  if (!shops?.length) return null;
  const total = shops.reduce((n, s) => n + s.unshipped, 0);
  return (
    <div className="flex gap8 small" style={{ flexWrap: 'wrap', alignItems: 'center', padding: compact ? 0 : '8px 16px' }} data-testid="unshipped-shops">
      <strong>Still to ship, all shops: {total}</strong>
      {shops.map((s) => (
        <span key={`${s.channel}:${s.shopId}`} className="flex gap4" style={{ alignItems: 'center' }}
              title={s.oldest ? `${s.unshipped} not shipped yet; the oldest was placed ${s.oldest}` : `${s.unshipped} not shipped yet`}>
          <ShopBadge channel={s.channel} name={s.name} /> {s.unshipped}
        </span>
      ))}
      {olderThanRange > 0 && <span className="badge amber" title="Widen the From date above to see them">{olderThanRange} older than this date range</span>}
    </div>
  );
}
