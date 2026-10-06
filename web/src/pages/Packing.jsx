import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api, { withBase } from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Empty, Stat, Thumb, Modal, Checkbox, useAsync, useToast, useErrorToast,
} from '../components/ui.jsx';

const FILTER_KEY = 'packing.filters';

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => localDay(new Date(Date.now() - n * 86_400_000));
const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

function loadFilters() {
  const fallback = { etsy: true, shopify: true, from: daysAgo(30), to: localDay(new Date()), autoAssign: false, warehouse: '' };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'), to: localDay(new Date()) }; } catch { return fallback; }
}

const scoreKind = (s) => (s >= 0.8 ? 'green' : s >= 0.55 ? 'amber' : 'grey');
const CHANNEL_BADGE = { etsy: 'orange', shopify: 'green' };

function ChannelBadge({ channel }) {
  return <span className={`badge ${CHANNEL_BADGE[channel] ?? 'grey'}`}>{channel === 'etsy' ? 'Etsy' : 'Shopify'}</span>;
}

// --------------------------------------------------------------- add parcel

/**
 * One arrival, the way the warehouse sends it: the photo and a line like
 * "中通 3324 1件". Paste a screenshot straight from WeChat (Ctrl+V anywhere on
 * the page), drop a file on the box, or pick one.
 */
function AddParcel({ warehouse, onWarehouse, onAdded }) {
  const showError = useErrorToast();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const textRef = useRef(null);

  const take = useCallback((f) => {
    if (!f || !f.type?.startsWith('image/')) return;
    setFile(f);
  }, []);

  useEffect(() => {
    if (!file) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const onPaste = (e) => {
      const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (img) { e.preventDefault(); take(img); textRef.current?.focus(); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [take]);

  const submit = async () => {
    if (!file && !text.trim()) return;
    setBusy(true);
    try {
      const form = new FormData();
      if (file) form.append('photo', file);
      form.append('text', text);
      form.append('warehouse', warehouse);
      form.append('receivedOn', localDay(new Date()));
      const parcel = await api.upload('/packing/parcels', form);
      setFile(null);
      setText('');
      onAdded(parcel);
    } catch (err) { showError(err, 'Could not add that parcel'); } finally { setBusy(false); }
  };

  return (
    <div className="card mb16">
      <div className="card-head"><h3>New arrival</h3></div>
      <div className="card-sub">
        Paste the photo from WeChat (Ctrl+V), then the line under it - carrier, last 4 digits and piece count, like 中通 3324 1件.
        Adding an arrival only saves it; the AI looks for its order when you press Find match.
      </div>
      <div className="flex" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <label
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
          style={{
            width: 150, height: 150, border: `2px dashed ${over ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 10,
            display: 'grid', placeItems: 'center', cursor: 'pointer', overflow: 'hidden', textAlign: 'center',
            background: 'var(--surface-2)',
          }}
        >
          {preview
            ? <img src={preview} alt="Parcel" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span className="muted small" style={{ padding: 10 }}>Paste, drop or click to add the photo</span>}
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <div className="flex col" style={{ flex: 1, minWidth: 260, gap: 8 }}>
          <input ref={textRef} className="input" value={text} placeholder="中通 3324 1件"
                 onChange={(e) => setText(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <input className="input" value={warehouse} placeholder="Warehouse (仓库) - optional, remembered"
                 onChange={(e) => onWarehouse(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <div className="flex gap8">
            <button className="btn primary" disabled={busy || (!file && !text.trim())} onClick={submit}>
              {busy ? <Spinner /> : '＋'} Add arrival
            </button>
            {file && <button className="btn ghost" disabled={busy} onClick={() => setFile(null)}>Clear photo</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- modals

function EditParcel({ parcel, onClose, onSaved }) {
  const showError = useErrorToast();
  const [form, setForm] = useState({
    carrier: parcel.carrier, last4: parcel.last4, quantity: parcel.quantity,
    warehouse: parcel.warehouse, note: parcel.note, receivedOn: parcel.receivedOn || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/packing/parcels/${parcel.id}`, form); onSaved(); }
    catch (err) { showError(err, 'Could not save that'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${parcel.label}`}
           footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? <Spinner /> : 'Save'}</button></>}>
      <div className="grid c2" style={{ gap: 10 }}>
        <label className="flex col small">Carrier (快递)<input className="input" value={form.carrier} onChange={set('carrier')} /></label>
        <label className="flex col small">Last 4 digits<input className="input" value={form.last4} maxLength={4} onChange={set('last4')} /></label>
        <label className="flex col small">Pieces (件)<input className="input" type="number" min="1" value={form.quantity} onChange={set('quantity')} /></label>
        <label className="flex col small">Warehouse (仓库)<input className="input" value={form.warehouse} onChange={set('warehouse')} /></label>
        <label className="flex col small">Received on<input className="input" type="date" value={form.receivedOn} onChange={set('receivedOn')} /></label>
        <label className="flex col small">Note<input className="input" value={form.note} onChange={set('note')} /></label>
      </div>
    </Modal>
  );
}

/** Pick the order item by hand when the AI could not, or got it wrong. */
function AssignPicker({ parcel, range, onClose, onAssign }) {
  const [q, setQ] = useState('');
  const { data, loading } = useAsync(
    () => api.get('/packing/open-items', { channels: range.channels, from: range.from, to: range.to }),
    [range.channels.join(','), range.from, range.to]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = data?.items ?? [];
    if (!needle) return all;
    return all.filter((i) => [i.title, i.sku, i.orderRef, i.buyer, i.variant].join(' ').toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <Modal open lg onClose={onClose} title={`Assign ${parcel.label} to an order item`}>
      <div className="flex gap12 mb12" style={{ alignItems: 'flex-start' }}>
        <Thumb src={parcel.photoUrl} size="lg" />
        <input className="input" autoFocus value={q} placeholder="Search title, SKU, order code or buyer" onChange={(e) => setQ(e.target.value)} />
      </div>
      {loading ? <Spinner /> : !items.length ? <Empty icon="∅" title="Nothing open in this range" /> : (
        <table className="data">
          <tbody>
            {items.map((i) => (
              <tr key={`${i.channel}:${i.itemId}`}>
                <td style={{ width: 70 }}><Thumb src={i.imageUrl} size="lg" /></td>
                <td>
                  <div><strong>{i.title}</strong>{i.variant && <span className="muted"> · {i.variant}</span>}</div>
                  <div className="small muted"><ChannelBadge channel={i.channel} /> <span className="mono">{i.orderRef}</span> · {i.buyer} · {shortDay(i.orderedAt)} · needs {i.remaining}</div>
                </td>
                <td className="right"><button className="btn sm primary" onClick={() => onAssign({ channel: i.channel, orderId: i.orderId, itemId: i.itemId })}>Assign</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------- arrivals

function Suggestions({ parcel, onAssign, busy }) {
  const s = parcel.suggestions;
  return (
    <div className="flex" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', padding: '6px 4px' }}>
      <a href={parcel.photoUrl ? withBase(parcel.photoUrl) : undefined} target="_blank" rel="noreferrer">
        <img src={parcel.photoUrl ? withBase(parcel.photoUrl) : ''} alt="Warehouse"
             style={{ width: 170, height: 170, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
      </a>
      <div style={{ flex: 1, minWidth: 300 }}>
        <div className="small muted mb8">
          {s.items.length ? `Best guesses among ${s.considered} product${s.considered === 1 ? '' : 's'} (${s.from} → ${s.to})` : 'Nothing in this range looks like it'}
          {s.unreadable && <span className="badge amber" style={{ marginLeft: 6 }}>photo hard to read</span>}
          {s.truncated && <span className="badge grey" style={{ marginLeft: 6 }}>only the oldest {s.considered} compared</span>}
          {s.skipped > 0 && <span className="badge grey" style={{ marginLeft: 6 }}>{s.skipped} listing photo{s.skipped === 1 ? '' : 's'} could not be loaded</span>}
        </div>
        <div className="flex col" style={{ gap: 8 }}>
          {s.items.map((it) => (
            <div key={it.imageUrl} className="card" style={{ padding: 10, margin: 0 }}>
              <div className="flex" style={{ alignItems: 'flex-start', gap: 12 }}>
                <img src={it.imageUrl} alt={it.title} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                <div style={{ flex: 1 }}>
                  <div><strong>{it.title}</strong> <span className={`badge ${scoreKind(it.score)}`}>{Math.round(it.score * 100)}%</span></div>
                  {it.reason && <div className="small muted mb4">{it.reason}</div>}
                  <div className="flex col" style={{ gap: 4 }}>
                    {it.demands.map((d) => (
                      <div key={`${d.channel}:${d.itemId}`} className="flex gap8 small" style={{ flexWrap: 'wrap' }}>
                        <ChannelBadge channel={d.channel} />
                        <span className="mono"><strong>{d.orderRef}</strong></span>
                        <span className="muted">{d.buyer} · {shortDay(d.orderedAt)} · needs {d.remaining}{d.sku ? ` · ${d.sku}` : ''}</span>
                        <button className="btn xs primary" disabled={busy}
                                onClick={() => onAssign({ channel: d.channel, orderId: d.orderId, itemId: d.itemId, source: 'ai', score: it.score })}>Assign</button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ParcelRow({ parcel, range, busy, onMatch, onAssign, onUnmatch, onEdit, onDelete, onPicker }) {
  const [open, setOpen] = useState(false);
  const s = parcel.suggestions;
  const top = s?.items?.[0];
  const m = parcel.match;
  useEffect(() => { if (s && parcel.status === 'unmatched') setOpen(true); }, [s?.ranAt, parcel.status]); // eslint-disable-line

  return (
    <>
      <tr>
        <td>
          <div className="mono"><strong>{parcel.label}</strong></div>
          <div className="small muted">{parcel.receivedOn}{parcel.note ? ` · ${parcel.note}` : ''}</div>
        </td>
        <td>
          {parcel.code
            ? <div><div className="mono"><strong>{parcel.code}</strong></div>{m && <ChannelBadge channel={m.channel} />}</div>
            : <span className="muted">—</span>}
        </td>
        <td>
          <div className="flex gap4">
            <a href={parcel.photoUrl ? withBase(parcel.photoUrl) : undefined} target="_blank" rel="noreferrer"><Thumb src={parcel.photoUrl} size="lg" /></a>
            {m?.item?.imageUrl && <Thumb src={m.item.imageUrl} size="lg" alt="Listing" />}
          </div>
        </td>
        <td>{parcel.warehouse || <span className="muted">—</span>}</td>
        <td>
          {parcel.status === 'packed' && <span className="badge green">Packed</span>}
          {m && (
            <div className="small" style={{ marginTop: parcel.status === 'packed' ? 4 : 0 }}>
              <div><strong>{m.item?.title ?? m.itemId}</strong>{m.item?.variant && <span className="muted"> · {m.item.variant}</span>}</div>
              <div className="muted">
                {m.item?.buyer}{m.item?.orderedAt ? ` · ${shortDay(m.item.orderedAt)}` : ''}{' '}
                <span className={`badge ${m.source === 'ai' ? 'violet' : 'grey'}`}>{m.source === 'ai' ? `AI${m.score ? ` ${Math.round(m.score * 100)}%` : ''}` : 'Manual'}</span>
              </div>
            </div>
          )}
          {!m && top && (
            <button className="btn xs ghost" onClick={() => setOpen((v) => !v)}>
              <span className={`badge ${scoreKind(top.score)}`}>{Math.round(top.score * 100)}%</span> {top.title.slice(0, 40)} {open ? '▴' : '▾'}
            </button>
          )}
          {!m && s && !top && <span className="small muted">No likely match in range</span>}
          {!m && !s && <span className="small muted">Not matched yet</span>}
        </td>
        <td>
          <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
            {!m && <button className="btn xs primary" disabled={busy || !parcel.photoUrl} onClick={() => onMatch(parcel.id)}
                            title={parcel.photoUrl ? 'Compare the photo with the unshipped orders in the date range' : 'Add a photo first'}>{busy ? <Spinner /> : s ? 'Re-match' : 'Find match'}</button>}
            {!m && <button className="btn xs" disabled={busy} onClick={() => onPicker(parcel)}>Assign…</button>}
            {m && <button className="btn xs" disabled={busy} onClick={() => onUnmatch(parcel.id)}>Unmatch</button>}
            <button className="btn xs ghost" onClick={() => onEdit(parcel)}>Edit</button>
            <button className="btn xs danger" disabled={busy} onClick={() => onDelete(parcel)}>Delete</button>
          </div>
        </td>
      </tr>
      {open && !m && s && (
        <tr><td colSpan={6} style={{ background: 'var(--surface-2)' }}>
          <Suggestions parcel={parcel} busy={busy} onAssign={(t) => onAssign(parcel.id, t)} />
        </td></tr>
      )}
    </>
  );
}

// -------------------------------------------------------------------- queue

const STATUS_LABEL = { ready: 'Ready to pack', partial: 'Partly here', waiting: 'Waiting', packed: 'Packed' };
const STATUS_KIND = { ready: 'green', partial: 'amber', waiting: 'grey', packed: 'blue' };

function QueueOrder({ order, busy, onPack }) {
  return (
    <div className="card mb12" style={{ padding: 12 }}>
      <div className="flex gap8" style={{ flexWrap: 'wrap' }}>
        <ChannelBadge channel={order.channel} />
        <strong className="mono">{order.ref}</strong>
        <span className="muted small">{order.buyer} · {shortDay(order.orderedAt)}</span>
        <span className={`badge ${STATUS_KIND[order.status]}`}>{STATUS_LABEL[order.status]}</span>
        <div style={{ flex: 1 }} />
        {order.status === 'ready' && <button className="btn sm primary" disabled={busy} onClick={() => onPack(order, true)}>{busy ? <Spinner /> : '📦'} Mark packed</button>}
        {order.status === 'packed' && <button className="btn sm ghost" disabled={busy} onClick={() => onPack(order, false)}>Undo packed</button>}
      </div>
      <table className="data" style={{ marginTop: 8 }}>
        <tbody>
          {order.items.map((it) => (
            <tr key={it.itemId}>
              <td style={{ width: 70 }}><Thumb src={it.imageUrl} size="lg" alt="Listing" /></td>
              <td style={{ width: 70 + 66 * Math.max(0, it.parcels.length - 1) }}>
                <div className="flex gap4">
                  {it.parcels.length
                    ? it.parcels.map((p) => <a key={p.id} href={p.photoUrl ? withBase(p.photoUrl) : undefined} target="_blank" rel="noreferrer" title={p.label}><Thumb src={p.photoUrl} size="lg" alt={p.label} /></a>)
                    : <Thumb src={null} size="lg" fallback="…" />}
                </div>
              </td>
              <td>
                <div><strong>{it.title}</strong>{it.variant && <span className="muted"> · {it.variant}</span>}</div>
                <div className="small muted">{it.sku}{it.parcels.length ? ` · ${it.parcels.map((p) => p.label).join(', ')}` : ''}</div>
              </td>
              <td className="right">
                <span className={`badge ${it.received >= it.quantity ? 'green' : it.received > 0 ? 'amber' : 'grey'}`}>{it.received} / {it.quantity}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------- page

export default function Packing() {
  const toast = useToast();
  const showError = useErrorToast();
  const [filters, setFilters] = useState(loadFilters);
  const [tab, setTab] = useState('arrivals');
  const [status, setStatus] = useState('all');
  const [queueFilter, setQueueFilter] = useState('ready');
  const [working, setWorking] = useState({});
  const [progress, setProgress] = useState(null);
  const [editing, setEditing] = useState(null);
  const [picking, setPicking] = useState(null);
  const cancelRef = useRef(false);

  const channels = useMemo(() => [filters.etsy && 'etsy', filters.shopify && 'shopify'].filter(Boolean), [filters.etsy, filters.shopify]);
  const range = useMemo(() => ({ channels, from: filters.from, to: filters.to }), [channels, filters.from, filters.to]);
  const rangeKey = `${channels.join(',')}|${filters.from}|${filters.to}`;

  useEffect(() => {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* private window */ }
  }, [filters]);

  const parcels = useAsync(() => api.get('/packing/parcels', { status }), [status]);
  const queue = useAsync(() => (channels.length ? api.get('/packing/queue', range) : Promise.resolve(null)), [rangeKey]);
  const refresh = useCallback(() => { parcels.reload(); queue.reload(); }, [parcels, queue]);

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const flag = (id, on) => setWorking((w) => ({ ...w, [id]: on }));

  const confirm = async (id, target) => {
    flag(id, true);
    try {
      await api.post(`/packing/parcels/${id}/confirm`, target);
      toast({ kind: 'ok', title: 'Matched' });
      refresh();
    } catch (err) { showError(err, 'Could not match that'); } finally { flag(id, false); }
  };

  /** One parcel: ask the AI, and - if it is sure - assign it to the oldest order waiting for that product. */
  const matchOne = useCallback(async (id, { quiet = false } = {}) => {
    flag(id, true);
    try {
      const p = await api.post(`/packing/parcels/${id}/match`, range);
      const s = p.suggestions;
      if (filters.autoAssign && s?.confident) {
        const top = s.items[0];
        const d = top.demands.find((x) => x.remaining > 0) ?? top.demands[0];
        if (d) await api.post(`/packing/parcels/${id}/confirm`, { channel: d.channel, orderId: d.orderId, itemId: d.itemId, source: 'ai', score: top.score });
      } else if (!quiet && !s?.items?.length) {
        toast({ kind: 'info', title: 'No likely match', body: 'Nothing in this date range looks like that photo.' });
      }
      return true;
    } catch (err) { showError(err, 'Matching failed'); return false; } finally { flag(id, false); parcels.reload(); queue.reload(); }
  }, [range, filters.autoAssign]); // eslint-disable-line react-hooks/exhaustive-deps

  const matchAll = async () => {
    const todo = (parcels.data?.rows ?? []).filter((p) => p.status === 'unmatched' && p.photoUrl);
    if (!todo.length) return;
    cancelRef.current = false;
    for (let i = 0; i < todo.length; i += 1) {
      if (cancelRef.current) break;
      setProgress({ done: i, total: todo.length });
      // eslint-disable-next-line no-await-in-loop
      const ok = await matchOne(todo[i].id, { quiet: true });
      if (!ok) break;
    }
    setProgress(null);
    refresh();
  };

  // Adding an arrival only records it. The AI is never asked until "Find match" or "Match all" is pressed.
  const onAdded = (parcel) => {
    toast({ kind: 'ok', title: `Added ${parcel.label}` });
    if (status !== 'all' && status !== 'unmatched') setStatus('all'); else parcels.reload();
  };

  const unmatch = async (id) => {
    flag(id, true);
    try { await api.post(`/packing/parcels/${id}/unmatch`, {}); refresh(); }
    catch (err) { showError(err, 'Could not unmatch'); } finally { flag(id, false); }
  };

  const remove = async (parcel) => {
    if (!window.confirm(`Delete ${parcel.label}${parcel.code ? ` (matched to ${parcel.code})` : ''}?`)) return;
    flag(parcel.id, true);
    try { await api.del(`/packing/parcels/${parcel.id}`); refresh(); }
    catch (err) { showError(err, 'Could not delete'); } finally { flag(parcel.id, false); }
  };

  const pack = async (order, packed) => {
    const key = `${order.channel}:${order.orderId}`;
    flag(key, true);
    try {
      await api.post('/packing/orders/pack', { channel: order.channel, orderId: order.orderId, packed });
      refresh();
    } catch (err) { showError(err, 'Could not update that order'); } finally { flag(key, false); }
  };

  const exportSheet = async () => {
    try {
      const r = await api.post('/packing/export', {});
      toast({ kind: 'ok', title: 'Packing sheet ready', body: `${r.filename} · ${r.rows} rows` });
      window.location.href = withBase(`/api/exports/download/${encodeURIComponent(r.filename)}`);
    } catch (err) { showError(err, 'Export failed'); }
  };

  const summary = queue.data?.summary;
  const counts = parcels.data?.counts;
  const unmatchedWithPhoto = (parcels.data?.rows ?? []).filter((p) => p.status === 'unmatched' && p.photoUrl).length;
  const orders = (queue.data?.orders ?? []).filter((o) => queueFilter === 'all' || o.status === queueFilter);

  return (
    <Page title="Packing" subtitle="Match what the warehouse received to the orders that have not shipped"
          actions={<button className="btn" onClick={exportSheet}>⤓ Export sheet (.xlsx)</button>}>
      <div className="card mb16">
        <div className="flex gap12" style={{ flexWrap: 'wrap' }}>
          <strong className="small">Orders to look through</strong>
          <Checkbox checked={filters.etsy} onChange={(v) => setFilter({ etsy: v })} label="Etsy" />
          <Checkbox checked={filters.shopify} onChange={(v) => setFilter({ shopify: v })} label="Shopify" />
          <label className="flex gap4 small">From <input className="input sm" type="date" value={filters.from} max={filters.to} onChange={(e) => setFilter({ from: e.target.value })} /></label>
          <label className="flex gap4 small">To <input className="input sm" type="date" value={filters.to} min={filters.from} onChange={(e) => setFilter({ to: e.target.value })} /></label>
          {[7, 14, 30, 60].map((n) => (
            <button key={n} className="btn xs ghost" onClick={() => setFilter({ from: daysAgo(n), to: localDay(new Date()) })}>{n}d</button>
          ))}
          <div style={{ flex: 1 }} />
          <span title="Off by default: after Find match, the AI's best guesses are shown and nothing is assigned until you press Assign. Turn on to have a very confident match assigned straight away.">
            <Checkbox checked={filters.autoAssign} onChange={(v) => setFilter({ autoAssign: v })} label="Assign automatically when the AI is sure" />
          </span>
        </div>
        <div className="small muted mt4">
          Only orders placed in this range that have not shipped (no tracking yet, not canceled) are compared. Oldest orders come first.
          {queue.data && !queue.data.connected.etsy && filters.etsy && ' Etsy is not connected.'}
          {queue.data && !queue.data.connected.shopify && filters.shopify && ' Shopify is not connected.'}
        </div>
      </div>

      <div className="grid c5 mb16">
        <Stat label="Ready to pack" value={summary?.ready ?? '—'} kind="good" onClick={() => { setTab('queue'); setQueueFilter('ready'); }} />
        <Stat label="Partly here" value={summary?.partial ?? '—'} onClick={() => { setTab('queue'); setQueueFilter('partial'); }} />
        <Stat label="Waiting" value={summary?.waiting ?? '—'} onClick={() => { setTab('queue'); setQueueFilter('waiting'); }} />
        <Stat label="Packed" value={summary?.packed ?? '—'} onClick={() => { setTab('queue'); setQueueFilter('packed'); }} />
        <Stat label="Unmatched parcels" value={counts?.unmatched ?? '—'} kind={counts?.unmatched ? 'alert' : ''} onClick={() => { setTab('arrivals'); setStatus('unmatched'); }} />
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'arrivals' ? 'active' : ''}`} onClick={() => setTab('arrivals')}>Warehouse arrivals{counts ? ` (${counts.total})` : ''}</button>
        <button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>Packing queue{summary ? ` (${summary.orders})` : ''}</button>
      </div>

      {tab === 'arrivals' && (
        <>
          <AddParcel warehouse={filters.warehouse} onWarehouse={(v) => setFilter({ warehouse: v })} onAdded={onAdded} />
          <div className="flex gap8 mb12" style={{ flexWrap: 'wrap' }}>
            {['all', 'unmatched', 'matched', 'packed'].map((s) => (
              <button key={s} className={`btn xs ${status === s ? 'primary' : 'ghost'}`} onClick={() => setStatus(s)}>
                {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}{counts ? ` (${s === 'all' ? counts.total : counts[s]})` : ''}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {progress && <span className="small muted">Matching {progress.done + 1} of {progress.total}…</span>}
            {progress
              ? <button className="btn sm" onClick={() => { cancelRef.current = true; }}>Stop</button>
              : <button className="btn sm primary" disabled={!unmatchedWithPhoto || !channels.length} onClick={matchAll}>Match all unmatched ({unmatchedWithPhoto})</button>}
          </div>
          {parcels.loading && !parcels.data ? <Spinner /> : !parcels.data?.rows.length ? (
            <Empty icon="📦" title="No arrivals yet" />
          ) : (
            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="data">
                <thead>
                  <tr><th>Tracking code<div className="small muted">跟踪号码</div></th><th>Code<div className="small muted">编号</div></th>
                    <th>Image<div className="small muted">图片</div></th><th>Warehouse<div className="small muted">仓库</div></th><th>Match</th><th /></tr>
                </thead>
                <tbody>
                  {parcels.data.rows.map((p) => (
                    <ParcelRow key={p.id} parcel={p} range={range} busy={!!working[p.id]}
                               onMatch={matchOne} onAssign={confirm} onUnmatch={unmatch}
                               onEdit={setEditing} onDelete={remove} onPicker={setPicking} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'queue' && (
        <>
          <div className="flex gap8 mb12" style={{ flexWrap: 'wrap' }}>
            {['ready', 'partial', 'waiting', 'packed', 'all'].map((s) => (
              <button key={s} className={`btn xs ${queueFilter === s ? 'primary' : 'ghost'}`} onClick={() => setQueueFilter(s)}>
                {s === 'all' ? 'All' : STATUS_LABEL[s]}{summary ? ` (${s === 'all' ? summary.orders : summary[s]})` : ''}
              </button>
            ))}
          </div>
          {queue.loading && !queue.data ? <Spinner /> : !orders.length ? (
            <Empty icon="📦" title={queueFilter === 'ready' ? 'Nothing is ready to pack yet' : 'No orders here'}>
              {queueFilter === 'ready' ? 'An order is ready once every item on it has a matched parcel.' : undefined}
            </Empty>
          ) : orders.map((o) => (
            <QueueOrder key={`${o.channel}:${o.orderId}`} order={o} busy={!!working[`${o.channel}:${o.orderId}`]} onPack={pack} />
          ))}
        </>
      )}

      {editing && <EditParcel parcel={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {picking && (
        <AssignPicker parcel={picking} range={range} onClose={() => setPicking(null)}
                      onAssign={async (t) => { const id = picking.id; setPicking(null); await confirm(id, { ...t, source: 'manual' }); }} />
      )}
    </Page>
  );
}
