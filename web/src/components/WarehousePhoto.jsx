import React, { useState } from 'react';
import api from '../lib/api.js';
import { Thumb, Spinner, useAsync, useErrorToast } from './ui.jsx';

/**
 * One order item's warehouse photo: upload it, see it next to the item's own
 * picture, and optionally ask the AI whether the two show the same product -
 * the same "compare by eye, or let the AI say" the seller asked for. Shared
 * between Etsy orders and Shopify orders since both keep the same shape of
 * data (a channel, an item id, an image URL, an optional warehouse photo).
 */
export default function WarehousePhotoCell({ channel, orderPath, item, onChanged }) {
  const showError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const itemId = channel === 'etsy' ? item.transactionId : item.lineItemId;
  const base = `${orderPath}/items/${encodeURIComponent(itemId)}`;

  const { data: existing } = useAsync(
    () => (item.warehousePhotoUrl ? api.get(`${base}/warehouse-check`) : null), [base, item.warehousePhotoUrl]);
  const check = result ?? (existing?.checked === false ? null : existing);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('photo', file);
      await api.upload(`${base}/warehouse-photo`, form);
      setResult(null);
      onChanged();
    } catch (err) { showError(err, 'Could not upload that'); } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await api.del(`${base}/warehouse-photo`); setResult(null); onChanged(); }
    catch (err) { showError(err, 'Could not remove that'); } finally { setBusy(false); }
  };

  const runCheck = async () => {
    setBusy(true);
    try { setResult(await api.post(`${base}/warehouse-check`, {})); }
    catch (err) { showError(err, 'AI compare failed'); } finally { setBusy(false); }
  };

  const badgeKind = check?.verdict === 'match' ? 'green' : check?.verdict === 'mismatch' ? 'red' : 'muted';

  return (
    <div className="flex gap4" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Thumb src={item.warehousePhotoUrl} />
      <div className="flex" style={{ flexDirection: 'column', gap: 4 }}>
        <label className="btn xs ghost" style={{ cursor: 'pointer' }}>
          {busy ? <Spinner /> : item.warehousePhotoUrl ? 'Replace' : 'Upload'}
          <input type="file" accept="image/*" style={{ display: 'none' }} disabled={busy}
                 onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {item.warehousePhotoUrl && (
          <div className="flex gap4">
            <button className="btn xs ghost" disabled={busy} onClick={remove}>Remove</button>
            <button className="btn xs" disabled={busy} onClick={runCheck}
                    title="Ask the AI whether this photo matches the item's own listing photo">AI compare</button>
          </div>
        )}
        {check && (
          <span className={`badge ${badgeKind}`} title={check.summary || undefined}>
            {check.verdict === 'match' ? 'Matches' : check.verdict === 'mismatch' ? 'Mismatch' : check.summary || 'Unsure'}
          </span>
        )}
      </div>
    </div>
  );
}
