import React, { useState } from 'react';
import api from '../lib/api.js';
import { useErrorToast } from './ui.jsx';
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
 * The warehouse photo for whichever item the list preview is showing -
 * upload, replace or remove right here, using the exact same control as the
 * order detail drawer (WarehousePhotoCell), just pointed at that one item.
 */
export function WarehouseCell({ order, channel, onChanged }) {
  const isShopify = channel === 'shopify';
  const itemId = isShopify ? order.warehousePhotoLineItemId : order.warehousePhotoTransactionId;
  if (!itemId) return <span className="muted small">no items</span>;

  const orderPath = isShopify
    ? `/shopify/orders/${encodeURIComponent(order.orderId)}`
    : `/orders/${order.receiptId}`;
  const item = isShopify
    ? { lineItemId: itemId, warehousePhotoUrl: order.warehousePhotoUrl }
    : { transactionId: itemId, warehousePhotoUrl: order.warehousePhotoUrl };

  return (
    <div>
      <WarehousePhotoCell channel={channel} orderPath={orderPath} item={item} onChanged={onChanged} />
      {order.itemCount > 1 && <div className="small dim mt4">{order.itemsWithPhoto}/{order.itemCount} items</div>}
    </div>
  );
}
