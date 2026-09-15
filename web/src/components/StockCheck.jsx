import React, { useState } from 'react';
import api from '../lib/api.js';
import { Spinner, Help, useErrorToast } from './ui.jsx';

/**
 * One supply link's stock status - Etsy SKU, Shopify variant, or the supply
 * book itself all show the exact same thing, since it is the same question
 * ("is what I am selling actually in stock at the supplier?") regardless of
 * which storefront the SKU belongs to.
 *
 * Shows the last cached result for free on mount; a fresh check only ever
 * happens when the button is pressed, because OneBound bills per call.
 */
export default function StockCheckCell({ url, compact = false }) {
  const showError = useErrorToast();
  const [cached, setCached] = useState(undefined); // undefined = not loaded yet, null = no link/no check yet
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    let alive = true;
    setCached(undefined);
    setResult(null);
    if (!url) { setCached(null); return; }
    api.get('/supply/stock-cache', { url }).then((r) => { if (alive) setCached(r); }).catch(() => { if (alive) setCached(null); });
    return () => { alive = false; };
  }, [url]);

  const check = async () => {
    setBusy(true);
    try { setResult(await api.post('/supply/stock-check', { url })); }
    catch (err) { showError(err, 'Stock check failed'); } finally { setBusy(false); }
  };

  if (!url) return <span className="small muted">{compact ? '—' : 'no supply link'}</span>;

  const shown = result ?? cached;
  const label = shown === undefined ? null
    : shown === null ? (compact ? 'check?' : 'not checked yet')
    : shown.allVariantsOut ? 'OUT OF STOCK'
    : shown.inStock ? (compact ? 'in stock' : 'In stock')
    : (shown.summary || 'Out of stock');

  const badgeKind = shown && (shown.allVariantsOut || shown.inStock === false) ? 'red'
    : shown && shown.inStock ? 'green' : 'muted';

  const reasonText = shown?.variants?.filter((v) => v.outOfStock).map((v) => `${v.label || 'variant'}: ${v.reason}`).join('; ');

  return (
    <span className="flex gap4" style={{ alignItems: 'center' }}>
      {label && <span className={`badge ${badgeKind}`} title={reasonText || undefined}>{label}</span>}
      <button className="btn xs ghost" onClick={check} disabled={busy} title="Ask OneBound for this product's live stock and price">
        {busy ? <Spinner /> : '↻'}
      </button>
      {!compact && <Help text="Checks the supplier's real, live stock per variant via the OneBound API. A variant with 0 or missing stock - or a nonsense repeating-digit price like 333/9999/99999, a common sold-out placeholder - is flagged as out of stock. Costs one paid API call, so it only runs when you press this button." />}
    </span>
  );
}
