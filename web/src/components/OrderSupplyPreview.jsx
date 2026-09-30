import React, { useState } from 'react';
import api from '../lib/api.js';
import { Thumb, Spinner, useErrorToast } from './ui.jsx';
import WarehousePhotoCell from './WarehousePhoto.jsx';

/**
 * Click-to-edit text field, the same shape as the shipping-cost cell already
 * used on the Shopify orders list: a small button showing the value (or "+
 * add" when empty), and an input + save/cancel once clicked. Saving an empty
 * string is how a value gets removed - one control does both.
 */
function InlineField({ value, placeholder, mono, onSave }) {
  const showError = useErrorToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const start = () => { setDraft(value || ''); setEditing(true); };
  const save = async () => {
    setBusy(true);
    try { await onSave(draft.trim()); setEditing(false); }
    catch (err) { showError(err, 'Could not save that'); }
    finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <button className="btn xs ghost" onClick={start} style={{ maxWidth: 150 }}>
        {value
          ? <span className={mono ? 'mono' : ''} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 140, verticalAlign: 'bottom' }}>{value}</span>
          : <span className="muted">+ add</span>}
      </button>
    );
  }
  return (
    <span className="flex gap4">
      <input className="input xs" style={{ width: 120 }} autoFocus value={draft} placeholder={placeholder}
             onChange={(e) => setDraft(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
      <button className="btn xs primary" disabled={busy} onClick={save} title="Save (empty removes it)">{busy ? '…' : '✓'}</button>
      <button className="btn xs ghost" disabled={busy} onClick={() => setEditing(false)}>✕</button>
    </span>
  );
}

/**
 * Supplier link, supplier order number and inbound tracking number - added,
 * edited and removed right here, not just glanced at. Shared between the
 * Etsy and Shopify orders lists; `channel` picks which endpoints a save
 * writes to, since the two platforms keep this data in different tables.
 *
 * The supply link is per-item (a SKU can have its own supplier page), so it
 * targets whichever item the list preview is showing - `order.supplyLinkSku`,
 * resolved server-side the same way the value itself is. The order number and
 * tracking number are order-level, so they always target the order itself.
 */
export function SupplyCell({ order, channel, onChanged }) {
  const isShopify = channel === 'shopify';

  const saveLink = async (value) => {
    if (!order.supplyLinkSku) throw new Error('This item has no SKU yet - set one first.');
    const path = isShopify
      ? `/shopify/variants/meta/${encodeURIComponent(order.supplyLinkSku)}`
      : `/skus/${encodeURIComponent(order.supplyLinkSku)}/meta`;
    await api.put(path, { supplyLink: value });
    onChanged();
  };

  const saveOrderField = async (field, value) => {
    if (isShopify) await api.post(`/shopify/orders/${encodeURIComponent(order.orderId)}/supplier-info`, { [field]: value });
    else await api.post(`/orders/${order.receiptId}/flags`, { [field]: value });
    onChanged();
  };

  return (
    <div className="small" style={{ lineHeight: 1.9 }}>
      <div className="flex gap4" style={{ alignItems: 'center' }}>
        <span className="dim" style={{ width: 30, display: 'inline-block' }}>Link</span>
        {order.supplyLinkSku
          ? <InlineField value={order.supplyLink} placeholder="https://…" onSave={saveLink} />
          : <span className="muted small">no SKU</span>}
        {order.supplyLink && (
          <a href={order.supplyLink} target="_blank" rel="noreferrer" className="btn xs ghost" title="Open">↗</a>
        )}
        {order.itemsWithSupplyLink > 1 && <span className="muted small">+{order.itemsWithSupplyLink - 1}</span>}
      </div>
      <div className="flex gap4" style={{ alignItems: 'center' }}>
        <span className="dim" style={{ width: 30, display: 'inline-block' }}>Ord#</span>
        <InlineField value={order.supplierOrderRef} placeholder="order #" mono onSave={(v) => saveOrderField('supplierOrderRef', v)} />
      </div>
      <div className="flex gap4" style={{ alignItems: 'center' }}>
        <span className="dim" style={{ width: 30, display: 'inline-block' }}>Trk#</span>
        <InlineField value={order.supplyTrackingNumber} placeholder="tracking #" mono onSave={(v) => saveOrderField('supplyTrackingNumber', v)} />
      </div>
    </div>
  );
}

/**
 * Every item's own photo(s) on the order, right next to the Warehouse
 * column, so a mismatch between what was actually stocked and what the
 * listing shows is catchable at a glance - or with the AI compare button in
 * the Warehouse cell right beside it, which checks each item's warehouse
 * photo against exactly that item's own picture. A single-item order shows
 * exactly what it always did; a multi-item order now shows every item's
 * photo, not just one. Etsy keeps a separate variant-specific photo (set on
 * the SKU page) on top of the listing's own cover photo, so both show when
 * they differ; Shopify already resolves one photo per line item, so there is
 * only ever one per item there.
 */
export function ProductImageCell({ order }) {
  const items = order.items?.length ? order.items : [{ imageUrl: order.imageUrl, variantImageUrl: order.variantImageUrl }];
  const photos = items.flatMap((it, i) => {
    const hasVariant = it.variantImageUrl && it.variantImageUrl !== it.imageUrl;
    return [
      it.imageUrl ? { key: `${i}-main`, url: it.imageUrl, alt: 'Listing photo' } : null,
      hasVariant ? { key: `${i}-variant`, url: it.variantImageUrl, alt: 'Variant photo' } : null,
    ].filter(Boolean);
  });
  if (!photos.length) return <span className="muted small">no photo</span>;
  return (
    <div className="flex gap4" style={{ flexWrap: 'wrap', maxWidth: 150 }}>
      {photos.map((p) => <Thumb key={p.key} src={p.url} alt={p.alt} />)}
    </div>
  );
}

/**
 * The warehouse photo for every item on the order - upload, replace, remove
 * or AI-compare each one individually, using the same control as the order
 * detail drawer (WarehousePhotoCell). A multi-item order used to only ever
 * show and check one "preview" item; now every item gets its own row, and a
 * "Check all" button covers all of them in one action.
 */
export function WarehouseCell({ order, channel, onChanged }) {
  const isShopify = channel === 'shopify';
  const items = order.items ?? [];
  if (!items.length) return <span className="muted small">no items</span>;

  const orderPath = isShopify
    ? `/shopify/orders/${encodeURIComponent(order.orderId)}`
    : `/orders/${order.receiptId}`;

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 6 }}>
      {items.map((it) => {
        const itemId = isShopify ? it.lineItemId : it.transactionId;
        const item = isShopify
          ? { lineItemId: itemId, warehousePhotoUrl: it.warehousePhotoUrl }
          : { transactionId: itemId, warehousePhotoUrl: it.warehousePhotoUrl };
        return <WarehousePhotoCell key={itemId} channel={channel} orderPath={orderPath} item={item} onChanged={onChanged} />;
      })}
      <CheckAllButton channel={channel} orderPath={orderPath} items={items} onChanged={onChanged} />
    </div>
  );
}

/**
 * One click to AI-compare every item on the order that already has a
 * warehouse photo, instead of pressing "AI compare" once per item - the
 * point of a multi-item order showing every product is that all of them
 * actually get checked, not just whichever one used to be picked as the
 * "preview" item.
 */
function CheckAllButton({ channel, orderPath, items, onChanged }) {
  const showError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);
  const checkable = items.filter((it) => it.warehousePhotoUrl);
  if (checkable.length < 2) return null;

  const runAll = async () => {
    setBusy(true);
    setSummary(null);
    const tally = { match: 0, mismatch: 0, unsure: 0, failed: 0 };
    for (const it of checkable) {
      const itemId = channel === 'shopify' ? it.lineItemId : it.transactionId;
      try {
        const res = await api.post(`${orderPath}/items/${encodeURIComponent(itemId)}/warehouse-check`, {});
        tally[res.verdict] = (tally[res.verdict] ?? 0) + 1;
      } catch (err) {
        tally.failed += 1;
        showError(err, `Could not check item ${itemId}`);
      }
    }
    setSummary(tally);
    setBusy(false);
    onChanged();
  };

  return (
    <div>
      <button className="btn xs" disabled={busy} onClick={runAll}
        title="Ask the AI to compare every item's own warehouse photo against its own listing photo">
        {busy ? <Spinner /> : `Check all ${checkable.length} items`}
      </button>
      {summary && (
        <div className="small dim mt4">
          {summary.match} match
          {summary.mismatch > 0 && <strong style={{ color: 'var(--bad, #e05252)' }}>, {summary.mismatch} mismatch</strong>}
          {summary.mismatch === 0 && ', 0 mismatch'}
          {summary.unsure > 0 && `, ${summary.unsure} unsure`}
          {summary.failed > 0 && `, ${summary.failed} failed`}
        </div>
      )}
    </div>
  );
}
