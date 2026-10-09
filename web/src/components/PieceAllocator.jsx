import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api.js';
import { Modal, Spinner, Empty, Thumb, useAsync, useToast, useErrorToast } from './ui.jsx';

const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const num = (v) => Math.max(0, Math.floor(Number(v) || 0));

/** Type a SKU, or pick one the shops sell (with how many are on the shelf now). */
export function SkuPicker({ value, onChange, placeholder = 'SKU', autoFocus = false }) {
  const [hits, setHits] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    clearTimeout(timer.current);
    const q = String(value ?? '').trim();
    if (q.length < 2) { setHits([]); return undefined; }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      try {
        const r = await api.get('/packing/skus', { q });
        if (mine === seq.current) setHits(r.skus ?? []);
      } catch { /* typing a SKU by hand still works */ }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [value]);

  const exact = hits.some((h) => h.sku.toLowerCase() === String(value ?? '').trim().toLowerCase());
  return (
    <div style={{ position: 'relative' }}>
      <input className="input mono" value={value} placeholder={placeholder} autoFocus={autoFocus} aria-label="SKU"
             onChange={(e) => { onChange(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && hits.length > 0 && !exact && (
        <div className="card" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', maxHeight: 260, overflowY: 'auto', padding: 4 }} data-testid="sku-hits">
          {hits.map((h) => (
            <button key={h.sku} type="button" className="btn ghost" style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', alignItems: 'center' }}
                    onMouseDown={(e) => { e.preventDefault(); onChange(h.sku); setOpen(false); }}>
              <Thumb src={h.imageUrl} size="sm" />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="mono"><strong>{h.sku}</strong></span>
                <span className="small muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title}{h.variation ? ` · ${h.variation}` : ''}</span>
              </span>
              <span className="small muted">{h.stock == null ? 'not counted' : `${h.stock} on shelf`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Put pieces of an arrival onto the shelf: which SKU and how many. */
export function StockDialog({ parcel, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(parcel.quantity);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/packing/parcels/${parcel.id}/stock`, { sku: sku.trim(), qty: num(qty) });
      toast({ kind: 'ok', title: `${num(qty)} piece${num(qty) === 1 ? '' : 's'} put into the stock of ${sku.trim()}` });
      onDone(r);
    } catch (err) { showError(err, 'Could not put those into stock'); setBusy(false); }
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title={`Put ${parcel.label} into stock`}
           footer={(
             <>
               <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={busy || !sku.trim() || !num(qty) || num(qty) > parcel.quantity} onClick={save}>
                 {busy ? <Spinner /> : '▤'} Put {num(qty) || '…'} into stock
               </button>
             </>
           )}>
      <div className="flex gap12 mb12" style={{ alignItems: 'flex-start' }}>
        <Thumb src={parcel.photoUrl} size="lg" />
        <div className="small muted" style={{ flex: 1 }}>
          These pieces are not for a customer's order - they go on the shelf. The real stock of the SKU goes up by that many (the Real stock page shows where they came from).
          {parcel.quantity > 1 ? ' Put fewer than all of them to keep the rest of the arrival for orders.' : ''}
        </div>
      </div>
      <div className="grid c2" style={{ gap: 10 }}>
        <label className="flex col small">SKU of this product<SkuPicker value={sku} onChange={setSku} autoFocus placeholder="Type or search a SKU" /></label>
        <label className="flex col small">Pieces (this arrival has {parcel.quantity})
          <input className="input" type="number" min="1" max={parcel.quantity} value={qty} onChange={(e) => setQty(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

/**
 * Give an arrival's pieces to orders: type how many pieces go to each order item (any shop), and what happens to the rest -
 * left on the arrival for later, or put on the shelf under a SKU. One row with "Assign" still gives the whole arrival to one item.
 * The AI can count the pieces first (the warehouse often sends more than was ordered: the extra ones belong on the shelf).
 */
export function AssignPicker({ parcel, range, onClose, onAssign, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [q, setQ] = useState('');
  const [pieces, setPieces] = useState(parcel.quantity);
  const [qtys, setQtys] = useState({});
  const [rest, setRest] = useState('keep');       // keep | stock
  const [restQty, setRestQty] = useState('');
  const [sku, setSku] = useState('');
  const [counting, setCounting] = useState(false);
  const [counted, setCounted] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data, loading } = useAsync(
    () => api.get('/packing/open-items', { channels: range.channels, from: range.from, to: range.to }),
    [range.channels.join(','), range.from, range.to]);
  const all = data?.items ?? [];
  const keyOf = (i) => `${i.channel}:${i.itemId}`;
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((i) => [i.title, i.sku, i.orderRef, i.buyer, i.variant].join(' ').toLowerCase().includes(needle));
  }, [all, q]);

  const chosen = all.filter((i) => num(qtys[keyOf(i)]) > 0);
  const given = chosen.reduce((n, i) => n + num(qtys[keyOf(i)]), 0);
  const left = Math.max(0, pieces - given);
  const toStock = rest === 'stock' ? Math.min(left, restQty === '' ? left : num(restQty)) : 0;
  const over = given > pieces;
  const defaultSku = chosen.find((i) => i.sku)?.sku ?? '';

  const setQty = (i, v) => setQtys((cur) => ({ ...cur, [keyOf(i)]: v }));
  const bump = (i, d) => {
    const now = num(qtys[keyOf(i)]);
    const next = Math.max(0, now + d);
    // The first piece given to an item is as many as it still needs (up to what is left).
    setQty(i, now === 0 && d > 0 ? Math.max(1, Math.min(num(i.remaining) || 1, left || 1)) : next);
  };

  const count = async () => {
    setCounting(true);
    setCounted(null);
    try {
      const first = chosen[0] ?? null;
      const r = await api.post(`/packing/parcels/${parcel.id}/count`, { channel: first?.channel, itemId: first?.itemId });
      setCounted(r);
    } catch (err) { showError(err, 'The AI could not count the pieces'); } finally { setCounting(false); }
  };
  const useCount = async () => {
    try {
      await api.post(`/packing/parcels/${parcel.id}/set-count`, { quantity: counted.count });
      setPieces(counted.count);
      setCounted(null);
      toast({ kind: 'ok', title: `${counted.count} pieces on this arrival now` });
    } catch (err) { showError(err, 'Could not change the count'); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const parts = chosen.map((i) => ({ channel: i.channel, orderId: i.orderId, itemId: i.itemId, qty: num(qtys[keyOf(i)]) }));
      const stock = toStock > 0 ? { sku: (sku || defaultSku).trim(), qty: toStock } : null;
      if (stock && !stock.sku) { toast({ kind: 'err', title: 'Say which SKU the pieces for the stock are' }); setBusy(false); return; }
      const r = await api.post(`/packing/parcels/${parcel.id}/allocate`, { parts, stock });
      toast({ kind: 'ok', title: `${given + toStock} piece${given + toStock === 1 ? '' : 's'} placed`, body: `${chosen.length ? `${chosen.length} order item${chosen.length === 1 ? '' : 's'}` : ''}${chosen.length && toStock ? ' + ' : ''}${toStock ? `${toStock} into stock` : ''}${left - toStock > 0 ? ` · ${left - toStock} still waiting on the arrival` : ''}` });
      onDone(r);
    } catch (err) { showError(err, 'Could not place those pieces'); setBusy(false); }
  };

  const nothing = given === 0 && toStock === 0;
  return (
    <Modal open lg onClose={() => !busy && onClose()} title={`Assign ${parcel.label} to order items`}
           footer={(
             <>
               <span className="small muted" style={{ marginRight: 'auto' }}>
                 {given} of {pieces} piece{pieces === 1 ? '' : 's'} given to {chosen.length} item{chosen.length === 1 ? '' : 's'}
                 {toStock > 0 ? ` · ${toStock} to stock` : ''}{left - toStock > 0 ? ` · ${left - toStock} stay on the arrival` : ''}
                 {over ? <strong style={{ color: 'var(--bad)' }}> · more than the arrival has</strong> : null}
               </span>
               <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={busy || nothing || over} onClick={save} data-testid="allocate">
                 {busy ? <Spinner /> : '✓'} Place {given + toStock || '…'} piece{given + toStock === 1 ? '' : 's'}
               </button>
             </>
           )}>
      <div className="flex gap12 mb12" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Thumb src={parcel.photoUrl} size="lg" />
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="flex gap8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{pieces} piece{pieces === 1 ? '' : 's'} on this arrival</strong>
            <button className="btn xs" disabled={counting || !parcel.photoUrl} onClick={count}
                    title="Uses AI credits: count the units in the photo (of the first chosen product, when one is chosen)">
              {counting ? <Spinner /> : '✦'} Count pieces (AI)
            </button>
            {counted && (
              <span className="small" data-testid="counted">
                AI counts <strong>{counted.count}</strong>{counted.confidence != null ? ` (${Math.round(counted.confidence * 100)}% sure)` : ''}{counted.note ? ` - ${counted.note}` : ''}
                {counted.count !== pieces && <button className="btn xs primary" style={{ marginLeft: 6 }} onClick={useCount}>Use {counted.count}</button>}
              </span>
            )}
          </div>
          <div className="small muted mt4">
            Type how many pieces go to each order item. Orders may be in different shops. Whatever is left can stay on the arrival or go on the shelf.
          </div>
          <input className="input mt8" autoFocus value={q} placeholder="Search title, SKU, order code or buyer" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {loading ? <Spinner /> : !items.length ? <Empty icon="∅" title="Nothing open in this range" /> : (
        <table className="data">
          <tbody>
            {items.map((i) => {
              const n = num(qtys[keyOf(i)]);
              return (
                <tr key={keyOf(i)} style={n > 0 ? { background: 'var(--surface-2)' } : undefined}>
                  <td style={{ width: 70 }}><Thumb src={i.imageUrl} size="lg" /></td>
                  <td>
                    <div><strong>{i.title}</strong>{i.variant && <span className="muted"> · {i.variant}</span>}</div>
                    <div className="small muted">
                      <span className="badge grey">{i.channel === 'etsy' ? 'Etsy' : 'Shopify'}</span> <span className="mono">{i.orderRef}</span> · {i.buyer} · {shortDay(i.orderedAt)} · needs {i.remaining}{i.sku ? ` · ${i.sku}` : ''}
                    </div>
                  </td>
                  <td className="right" style={{ whiteSpace: 'nowrap' }}>
                    <span className="flex gap4" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                      <button className="btn xs" aria-label="One less" disabled={n === 0} onClick={() => bump(i, -1)}>−</button>
                      <input className="input sm" style={{ width: 52, textAlign: 'center' }} type="number" min="0" aria-label={`Pieces for ${i.orderRef}`} value={qtys[keyOf(i)] ?? ''} placeholder="0"
                             onChange={(e) => setQty(i, e.target.value)} />
                      <button className="btn xs" aria-label="One more" onClick={() => bump(i, 1)}>＋</button>
                      <button className="btn sm primary" disabled={busy} title="Give the whole arrival to this item"
                              onClick={() => onAssign({ channel: i.channel, orderId: i.orderId, itemId: i.itemId })}>Assign</button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {left > 0 && (
        <div className="card mt12" data-testid="rest-box" style={{ background: 'var(--surface-2)' }}>
          <div className="small"><strong>{left} piece{left === 1 ? '' : 's'} left over.</strong> {left > 0 && given > 0 ? 'The shop often buys more than the orders need.' : ''}</div>
          <div className="flex gap12 mt8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="flex gap4 small"><input type="radio" name="rest" checked={rest === 'keep'} onChange={() => setRest('keep')} /> Leave them on the arrival for other orders</label>
            <label className="flex gap4 small"><input type="radio" name="rest" checked={rest === 'stock'} onChange={() => setRest('stock')} /> Put them into stock</label>
          </div>
          {rest === 'stock' && (
            <div className="flex gap8 mt8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="flex col small" style={{ minWidth: 260, flex: 1 }}>SKU of this product
                <SkuPicker value={sku || defaultSku} onChange={setSku} placeholder="Type or search a SKU" /></label>
              <label className="flex col small" style={{ width: 110 }}>Pieces
                <input className="input" type="number" min="1" max={left} value={restQty === '' ? left : restQty} onChange={(e) => setRestQty(e.target.value)} /></label>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

