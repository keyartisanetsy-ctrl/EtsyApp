import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Spinner, useErrorToast } from './ui.jsx';

/**
 * The real stock - what is on the shelf - of the SKUs on screen: { sku: { qty, countedAt } } for the ones somebody
 * counts. One count per SKU, whichever shop sells it; kept in this app only.
 */
export function useRealStock(skus) {
  const key = [...new Set((skus ?? []).filter(Boolean))].sort().join('\u0001');
  const [map, setMap] = useState({});
  const load = useCallback(() => {
    if (!key) { setMap({}); return; }
    api.post('/catalog/stock/real-map', { skus: key.split('\u0001') }).then((r) => setMap(r.real ?? {})).catch(() => {});
  }, [key]);
  useEffect(() => { load(); }, [load]);
  return { real: map, reload: load };
}

/** One SKU's real stock: type a number and leave the field - it is saved at once. Blank stops counting this SKU. */
export function RealStockCell({ sku, counted, onSaved, width = 62 }) {
  const showError = useErrorToast();
  const shown = counted != null ? String(counted) : '';
  const [value, setValue] = useState(shown);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(shown); }, [shown, sku]);
  const save = async () => {
    if (value.trim() === shown) return;
    setBusy(true);
    try { await api.post('/catalog/stock/real', { sku, qty: value.trim() === '' ? null : value.trim() }); onSaved?.(); }
    catch (err) { setValue(shown); showError(err, 'Could not save the real stock'); } finally { setBusy(false); }
  };
  return (
    <span className="flex gap4" style={{ alignItems: 'center' }}>
      <input className="input sm right mono" type="number" min="0" style={{ width }} value={value} disabled={!sku || busy} placeholder={sku ? 'not counted' : '–'}
             aria-label={`Real stock of ${sku || 'this variant'}`}
             title={sku ? 'What is really on the shelf - one count for this SKU in every shop. Saved when you leave the field; orders take pieces off it, never below 0.' : 'Give this variant a SKU first - the real stock is kept per SKU'}
             onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      {busy && <Spinner />}
    </span>
  );
}
