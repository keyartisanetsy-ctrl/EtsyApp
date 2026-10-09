import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api, { withBase } from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Empty, Stat, Thumb, Modal, Checkbox, CopyButton, useAsync, useToast, useErrorToast,
} from '../components/ui.jsx';
import SplitPhoto from '../components/SplitPhoto.jsx';
import PhotoBrain from '../components/PhotoBrain.jsx';
import ItemSupplyBox from '../components/ItemSupply.jsx';
import UnshippedShops from '../components/UnshippedShops.jsx';
import { normalizePhoto, splitPhoto } from '../lib/photo.js';

const FILTER_KEY = 'packing.filters';

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => localDay(new Date(Date.now() - n * 86_400_000));
const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

function loadFilters() {
  const fallback = { etsy: true, shopify: true, from: daysAgo(30), to: localDay(new Date()), autoAssign: false, autoSplit: true, warehouse: '' };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'), to: localDay(new Date()) }; } catch { return fallback; }
}

/** An example code for today, like 26-1008-01 - the shape the app hands out. */
const exampleCode = () => { const d = new Date(); return `${String(d.getFullYear()).slice(2)}-${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-01`; };

const scoreKind = (s) => (s >= 0.8 ? 'green' : s >= 0.55 ? 'amber' : 'grey');

/** Whichever look for an order ran last - the AI's or the free matcher's. */
const latestSuggestions = (p) => {
  const ai = p.suggestions;
  const free = p.quick;
  if (!ai) return free;
  if (!free) return ai;
  return String(free.ranAt) > String(ai.ranAt) ? free : ai;
};

const SOURCE_BADGE = { ai: ['violet', 'AI'], quick: ['blue', 'Free'], manual: ['grey', 'Manual'] };
function EvidenceChips({ items }) {
  if (!items?.length) return null;
  return (
    <>
      {items.map((e, i) => (
        <span key={`${e.kind}${i}`} className={`badge ${e.strong ? 'green' : e.kind === 'warn' ? 'red' : e.kind === 'state' ? 'blue' : 'grey'}`}>{e.label}</span>
      ))}
    </>
  );
}
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
function AddParcel({ warehouse, onWarehouse, range, onAdded }) {
  const showError = useErrorToast();
  // Every photo of the package: the first is its own, the others are more angles, the other tray, or the carrier's label.
  const [shots, setShots] = useState([]);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const textRef = useRef(null);

  const take = useCallback((list) => {
    const images = [...(list ?? [])].filter((f) => f?.type?.startsWith('image/'));
    if (!images.length) return;
    setShots((cur) => [...cur, ...images.map((file) => ({ file, kind: 'product', url: URL.createObjectURL(file), key: `${file.name}-${file.size}-${Math.random()}` }))].slice(0, 12));
  }, []);
  const drop = (key) => setShots((cur) => cur.filter((x) => x.key !== key));

  useEffect(() => () => shots.forEach((x) => URL.revokeObjectURL(x.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPaste = (e) => {
      const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); take(imgs); textRef.current?.focus(); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [take]);

  const submit = async () => {
    if (!shots.length && !text.trim()) return;
    setBusy(true);
    try {
      const form = new FormData();
      const products = shots.filter((x) => x.kind === 'product');
      const labels = shots.filter((x) => x.kind === 'label');
      // A package with only label photos still needs one photo of its own - the first one.
      const own = products[0] ?? labels[0];
      if (own) form.append('photo', await normalizePhoto(own.file));
      for (const x of products.slice(own === products[0] ? 1 : 0)) form.append('photos', await normalizePhoto(x.file));
      for (const x of labels.filter((l) => l !== own)) form.append('labels', await normalizePhoto(x.file));
      form.append('text', text);
      form.append('warehouse', warehouse);
      form.append('receivedOn', localDay(new Date()));
      form.append('code', code.trim());
      form.append('channels', range.channels.join(','));
      form.append('from', range.from);
      form.append('to', range.to);
      const parcel = await api.upload('/packing/parcels', form);
      shots.forEach((x) => URL.revokeObjectURL(x.url));
      setShots([]);
      setText('');
      setCode('');
      onAdded(parcel);
    } catch (err) { showError(err, 'Could not add that parcel'); } finally { setBusy(false); }
  };

  return (
    <div className="card mb16">
      <div className="card-head"><h3>New arrival</h3></div>
      <div className="card-sub">
        Paste the photo from WeChat (Ctrl+V), then the line under it - carrier, last 4 digits and piece count, like 中通 3324 1件.
        One package can have <strong>several photos</strong> (another side, the other tray of the same product, the carrier's label) - paste or drop them all; mark a label photo with 🏷.
        Know the order already? Type its code (like {exampleCode()}) - or its order number (#2419) if it has no code yet - and the arrival goes straight onto that order.
        An order gets its code the moment its first parcel is added (today's date, numbered 01, 02, 03...).
        Otherwise the free matcher looks for the order as soon as you add it - tracking number, order state, text read off the photos and colours, no AI credits.
        The AI only runs when you press Find match - and, while "Split photos with several products" is on, once on each new photo to see whether it shows more than one product (then each product becomes its own arrival, ready to match). Split one by hand with ✂ Split on its row.
      </div>
      <div className="flex" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ width: 230 }}>
          <label
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
            style={{
              minHeight: 150, border: `2px dashed ${over ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 10,
              display: 'grid', placeItems: 'center', cursor: 'pointer', overflow: 'hidden', textAlign: 'center',
              background: 'var(--surface-2)',
            }}
          >
            {shots.length
              ? (
                <div className="flex" style={{ flexWrap: 'wrap', gap: 6, padding: 6, justifyContent: 'center' }}>
                  {shots.map((x, i) => (
                    <div key={x.key} data-testid="new-shot" style={{ position: 'relative', width: 66, height: 66 }} onClick={(e) => e.preventDefault()}>
                      <img src={x.url} alt={`Photo ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6, border: i === 0 ? '2px solid var(--brand)' : '1px solid var(--border)' }} />
                      <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); drop(x.key); }}
                              style={{ position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: 9, border: 0, background: '#111', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: '18px', padding: 0 }}>×</button>
                      <button type="button" aria-label={`Photo ${i + 1} is a label`} title="This photo is the carrier's label"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShots((cur) => cur.map((y) => (y.key === x.key ? { ...y, kind: y.kind === 'label' ? 'product' : 'label' } : y))); }}
                              style={{ position: 'absolute', bottom: -4, left: -4, width: 20, height: 20, borderRadius: 10, border: 0, background: x.kind === 'label' ? 'var(--brand)' : '#555', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: '20px', padding: 0 }}>🏷</button>
                    </div>
                  ))}
                </div>
              )
              : <span className="muted small" style={{ padding: 10 }}>Paste, drop or click to add the photo(s)</span>}
            <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
          </label>
          {shots.length > 0 && <div className="small muted" style={{ marginTop: 4 }}>{shots.length} photo{shots.length === 1 ? '' : 's'} - click the box to add more</div>}
        </div>
        <div className="flex col" style={{ flex: 1, minWidth: 260, gap: 8 }}>
          <input ref={textRef} className="input" value={text} placeholder="中通 3324 1件"
                 onChange={(e) => setText(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <input className="input mono" value={code} placeholder={`Order code or number (optional) - ${exampleCode()} / #2419`}
                 onChange={(e) => setCode(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <input className="input" value={warehouse} placeholder="Warehouse (仓库) - optional, remembered"
                 onChange={(e) => onWarehouse(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <div className="flex gap8">
            <button className="btn primary" disabled={busy || (!shots.length && !text.trim())} onClick={submit}>
              {busy ? <Spinner /> : '＋'} Add arrival
            </button>
            {shots.length > 0 && <button className="btn ghost" disabled={busy} onClick={() => { shots.forEach((x) => URL.revokeObjectURL(x.url)); setShots([]); }}>Clear photos</button>}
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

function Suggestions({ parcel, s, onAssign, onSplit, onChoose, busy }) {
  const free = s.engine === 'quick';
  const strong = s.items.filter((i) => i.score >= 0.6);
  return (
    <div className="flex" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', padding: '6px 4px' }}>
      <a href={parcel.photoUrl ? withBase(parcel.photoUrl) : undefined} target="_blank" rel="noreferrer">
        <img src={parcel.photoUrl ? withBase(parcel.photoUrl) : ''} alt="Warehouse"
             style={{ width: 170, height: 170, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
      </a>
      <div style={{ flex: 1, minWidth: 300 }}>
        <div className="small muted mb8">
          {free && <span className="badge blue" style={{ marginRight: 6 }} title="No AI was used: tracking number, order state, text read off the photo and colours">Free match</span>}
          {s.items.length ? `Best guesses among ${s.considered} ${free ? 'item' : 'product'}${s.considered === 1 ? '' : 's'} (${s.from} → ${s.to})` : 'Nothing in this range looks like it'}
          {free && (
            <>
              <span className={`badge ${s.signals?.tracking ? 'green' : 'grey'}`} style={{ marginLeft: 6 }}>{s.signals?.tracking ? 'tracking matched' : 'no tracking match'}</span>
              <span className={`badge ${s.signals?.text ? 'green' : 'grey'}`} style={{ marginLeft: 6 }}>{s.signals?.text ? 'text read' : parcel.hasText ? 'text had no usable words' : 'no text read'}</span>
              <span className={`badge ${s.signals?.colours ? 'green' : 'grey'}`} style={{ marginLeft: 6 }}>{s.signals?.colours ? 'colours compared' : 'colours not compared'}</span>
            </>
          )}
          {s.unreadable && <span className="badge amber" style={{ marginLeft: 6 }}>photo hard to read</span>}
          {s.truncated && <span className="badge grey" style={{ marginLeft: 6 }}>only the oldest {s.considered} compared</span>}
          {s.skipped > 0 && <span className="badge grey" style={{ marginLeft: 6 }}>{s.skipped} listing photo{s.skipped === 1 ? '' : 's'} could not be loaded</span>}
          {s.usage?.calls > 0 && (
            <span className="badge grey" style={{ marginLeft: 6 }}
                  title={`${s.usage.input.toLocaleString()} tokens in, ${s.usage.output.toLocaleString()} out${s.closeLook ? ' - a second, closer look was needed' : ''}`}>
              AI: {s.usage.calls} call{s.usage.calls === 1 ? '' : 's'} · {(s.usage.input + s.usage.output).toLocaleString()} tokens
            </span>
          )}
        </div>
        {free && s.needsItem && (
          <div className="flex gap8 mb8" style={{ flexWrap: 'wrap' }}>
            <span className="badge amber">Order {s.needsItem.code}: {s.needsItem.reason}</span>
            <button className="btn xs primary" disabled={busy} onClick={() => onChoose(parcel, s.needsItem)}>Choose the item</button>
          </div>
        )}
        {strong.length >= 2 && (
          <div className="flex gap8 mb8" style={{ flexWrap: 'wrap' }}>
            <span className="badge amber">{strong.length} of the products look like they are in this photo</span>
            <button className="btn xs primary" disabled={busy} onClick={onSplit}>✂ Split photo</button>
            <span className="small muted">so each customer's product gets its own photo</span>
          </div>
        )}
        <div className="flex col" style={{ gap: 8 }}>
          {s.items.map((it) => (
            <div key={it.imageUrl} className="card" style={{ padding: 10, margin: 0 }}>
              <div className="flex" style={{ alignItems: 'flex-start', gap: 12 }}>
                <img src={it.imageUrl} alt={it.title} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                <div style={{ flex: 1 }}>
                  <div><strong>{it.title}</strong> <span className={`badge ${scoreKind(it.score)}`}>{Math.round(it.score * 100)}%</span> <EvidenceChips items={it.evidence} /></div>
                  {it.reason && <div className="small muted mb4">{it.reason}</div>}
                  <div className="flex col" style={{ gap: 4 }}>
                    {it.demands.map((d) => (
                      <div key={`${d.channel}:${d.itemId}`} className="flex gap8 small" style={{ flexWrap: 'wrap' }}>
                        <ChannelBadge channel={d.channel} />
                        <span className="mono"><strong>{d.orderRef}</strong></span>
                        <span className="muted">{d.buyer} · {shortDay(d.orderedAt)} · needs {d.remaining}{d.sku ? ` · ${d.sku}` : ''}</span>
                        <EvidenceChips items={d.evidence} />
                        <button className="btn xs primary" disabled={busy}
                                onClick={() => onAssign({ channel: d.channel, orderId: d.orderId, itemId: d.itemId, source: free ? 'quick' : 'ai', score: d.score ?? it.score })}>Assign</button>
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

/** The badge for an order's hold: ⏸ while the parcel is to be kept, ▶ once the rest has arrived. */
function HoldBadge({ hold }) {
  const active = hold.state === 'active';
  return (
    <span className={`badge ${active ? 'amber' : 'green'}`}
          title={active ? 'The warehouse is asked to keep this parcel until the rest of its order arrives' : 'Everything has arrived - the held parcels go out together'}>
      {active ? '⏸' : '▶'} {hold.code}
    </span>
  );
}

/**
 * A parcel of an order that was not all here when it arrived: it carries a HOLD code, and the
 * warehouse is asked - in Chinese, ready to copy into WeChat - to keep it a little while.
 * Once the last piece is matched the message becomes "send them together".
 */
function HoldNotice({ hold, busy, onRelease }) {
  const active = hold.state === 'active';
  return (
    <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', maxWidth: 440 }}>
      <div className="flex gap8" style={{ flexWrap: 'wrap' }}>
        <HoldBadge hold={hold} />
        <span className="small muted">
          {active ? `waiting for the rest of this order - ${hold.received} of ${hold.needed} pieces are here`
            : hold.forced ? 'released by hand - send the parcels together' : 'the whole order is here - send the parcels together'}
        </span>
      </div>
      <div className="small" lang="zh" style={{ marginTop: 4 }}>{hold.messageZh}</div>
      <div className="small muted" style={{ marginTop: 2 }}>{hold.messageEn}</div>
      <div className="flex gap4" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <CopyButton text={hold.messageZh} label="Copy 中文 message" className="btn xs primary" />
        {active && (
          <button className="btn xs" disabled={busy} onClick={() => onRelease(true)}
                  title="The missing piece will not come through the warehouse: let the parcels go as they are">Release hold</button>
        )}
        {!active && hold.forced && <button className="btn xs" disabled={busy} onClick={() => onRelease(false)}>Hold again</button>}
      </div>
    </div>
  );
}

/**
 * The Taobao order number and cost of the order this parcel belongs to. They are saved on the
 * order (the same fields the Orders pages show), and can be sent on to the order's Airtable row.
 */
function SupplyBox({ parcel, busy, onSave }) {
  const s = parcel.match.supply ?? { taobaoOrder: '', cost: null, currency: null };
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState(s.taobaoOrder);
  const [cost, setCost] = useState(s.cost ?? '');
  const [ccy, setCcy] = useState(s.currency || 'CNY');
  useEffect(() => { setRef(s.taobaoOrder); setCost(s.cost ?? ''); setCcy(s.currency || 'CNY'); }, [s.taobaoOrder, s.cost, s.currency]);

  const summary = [s.taobaoOrder && `Taobao ${s.taobaoOrder}`, s.cost != null && `${s.cost} ${s.currency || 'CNY'}`].filter(Boolean).join(' · ');
  const values = { taobaoOrder: ref, cost: String(cost), currency: ccy };
  return (
    <div style={{ marginTop: 6, maxWidth: 440 }}>
      <button className={`btn xs ${summary ? '' : 'ghost'}`} onClick={() => setOpen((v) => !v)}
              title="The Taobao order number and what the order cost - saved on the order, and sendable to its Airtable row">
        🛒 {summary || 'Taobao order & cost'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
            <input className="input sm" style={{ flex: '2 1 190px' }} value={ref} placeholder="Taobao order number"
                   aria-label={`Taobao order number for ${parcel.label}`} onChange={(e) => setRef(e.target.value)} />
            <input className="input sm" style={{ flex: '1 1 70px', maxWidth: 100 }} type="number" min="0" step="0.01" value={cost} placeholder="Cost"
                   aria-label={`Supply cost for ${parcel.label}`} onChange={(e) => setCost(e.target.value)} />
            <input className="input sm" style={{ width: 56 }} value={ccy} maxLength={4} aria-label="Cost currency" onChange={(e) => setCcy(e.target.value.toUpperCase())} />
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            For the whole order. Bought in several Taobao orders? Write them all, separated by commas, and the total cost.
          </div>
          <div className="flex gap4" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn xs" disabled={busy} onClick={() => onSave(parcel, values, 'none')}>Save</button>
            <button className="btn xs primary" disabled={busy} onClick={() => onSave(parcel, values, 'check')}
                    title="Save, then put them in the Taobao-order and cost columns of this order's Airtable row. If Airtable already has different values you are asked first.">
              Save & send to Airtable
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Airtable already holds different values for this order: change them, or keep what is there. */
function AirtableDecision({ decision, busy, onAnswer, onClose }) {
  return (
    <Modal open onClose={onClose} title="Airtable already has this order's Taobao order / cost"
           footer={(
             <>
               <button className="btn" disabled={busy} onClick={() => onAnswer('keep')}>Keep (don't change)</button>
               <button className="btn primary" disabled={busy} onClick={() => onAnswer('change')}>{busy ? <Spinner /> : 'Change'}</button>
             </>
           )}>
      <div className="small muted mb8">
        {decision.parcel.label} · order {decision.parcel.code || decision.parcel.match.orderId}. Nothing has been sent yet.
        "Change" replaces what Airtable has with what you entered; "Keep" leaves Airtable as it is (anything it has empty is still filled in).
        What you entered stays saved here either way.
      </div>
      <table className="data">
        <thead><tr><th>Airtable column</th><th>Airtable has</th><th>You entered</th></tr></thead>
        <tbody>
          {decision.conflicts.map((c) => (
            <tr key={`${c.destination}:${c.column}`}>
              <td><strong>{c.column}</strong><div className="small muted">{c.field} · {c.destination}</div></td>
              <td className="mono">{c.current}</td>
              <td className="mono"><strong>{c.next}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/**
 * The order code of an arrival, always editable: type 26-0710-01 and press
 * Enter (or leave the box) to put the arrival on that order; clear it to
 * release the arrival. A code only names an order - when the order has several
 * items and the parcel does not clearly look like one of them, you are asked
 * which.
 */
function CodeCell({ parcel, busy, onCode }) {
  const [value, setValue] = useState(parcel.code ?? '');
  const [bad, setBad] = useState(false);
  const sent = useRef(parcel.code ?? '');
  useEffect(() => { setValue(parcel.code ?? ''); sent.current = parcel.code ?? ''; setBad(false); }, [parcel.code]);

  const commit = async () => {
    const next = value.trim();
    if (next === (parcel.code ?? '') || next === sent.current) return;
    sent.current = next;
    const ok = await onCode(parcel, next);
    setBad(!ok);
    if (!ok) sent.current = parcel.code ?? '';
  };
  const m = parcel.match;
  return (
    <div>
      <input className="input sm mono" style={{ width: 118, fontWeight: parcel.code ? 700 : 400, borderColor: bad ? 'var(--bad)' : undefined }}
             value={value} placeholder={exampleCode()} disabled={busy} aria-label={`Order code for ${parcel.label}`}
             title="Type the order code (or the order number, #2419) and press Enter. Clear it to release this arrival."
             onChange={(e) => { setValue(e.target.value); setBad(false); }}
             onKeyDown={(e) => {
               if (e.key === 'Enter') { e.preventDefault(); commit(); }
               if (e.key === 'Escape') { setValue(parcel.code ?? ''); setBad(false); }
             }}
             onBlur={commit} />
      {m && <div style={{ marginTop: 3 }}><ChannelBadge channel={m.channel} /></div>}
      {parcel.hold && <div style={{ marginTop: 3 }}><HoldBadge hold={parcel.hold} /></div>}
    </div>
  );
}

/** An order with several items: say which one this parcel is. */
function ItemChooser({ parcel, needsItem, busy, onChoose, onClose }) {
  return (
    <Modal open lg onClose={onClose} title={`Which item is ${parcel.label}?`}>
      <div className="flex gap12 mb12" style={{ alignItems: 'flex-start' }}>
        <Thumb src={parcel.photoUrl} size="lg" />
        <div>
          <div>Order <strong className="mono">{needsItem.code}</strong>{needsItem.buyer ? ` · ${needsItem.buyer}` : ''} has more than one item.</div>
          <div className="small muted">{needsItem.reason}</div>
        </div>
      </div>
      <table className="data">
        <tbody>
          {needsItem.items.map((i) => (
            <tr key={i.itemId}>
              <td style={{ width: 70 }}><Thumb src={i.imageUrl} size="lg" /></td>
              <td>
                <div><strong>{i.title}</strong>{i.variant && <span className="muted"> · {i.variant}</span>}</div>
                <div className="small muted">{i.sku}{i.sku ? ' · ' : ''}{i.received} of {i.quantity} here{i.remaining <= 0 ? ' (complete)' : ''} <EvidenceChips items={i.evidence} /></div>
              </td>
              <td className="right"><button className="btn sm primary" disabled={busy} onClick={() => onChoose(i)}>This one</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/** The other photos of one package, each with a way to take it out or make it an arrival of its own again. */
function ExtraPhotos({ parcel, busy, onAdd, onRemove, onDetach }) {
  const input = useRef(null);
  const editable = parcel.status !== 'split' && parcel.status !== 'packed';
  return (
    <div className="flex gap4" style={{ flexWrap: 'wrap', marginTop: 4, alignItems: 'flex-start' }}>
      {parcel.extraPhotos.map((x) => (
        <div key={x.id} data-testid="extra-photo" style={{ textAlign: 'center' }}>
          <a href={withBase(x.url)} target="_blank" rel="noreferrer" title={x.kind === 'label' ? 'Carrier label' : 'Another photo of this package'}>
            <Thumb src={x.url} size="lg" />
          </a>
          <div className="small muted">
            {x.kind === 'label' ? '🏷' : ''}
            {editable && (
              <>
                {' '}<button className="btn xs ghost" disabled={busy} title="Make this photo an arrival of its own" aria-label="Make this photo its own arrival" onClick={() => onDetach(parcel, x)}>⇱</button>
                <button className="btn xs ghost" disabled={busy} title="Remove this photo" aria-label="Remove this photo" onClick={() => onRemove(parcel, x)}>✕</button>
              </>
            )}
          </div>
        </div>
      ))}
      {editable && parcel.photoCount < 12 && (
        <>
          <button className="btn xs" disabled={busy} title="Add more photos of this package: another side, the other tray, or the carrier's label" onClick={() => input.current?.click()}>＋ Photos</button>
          <button className="btn xs" disabled={busy} title="Add the carrier's label photo (its text fills in a missing carrier line)"
                  onClick={() => { input.current.dataset.kind = 'label'; input.current.click(); }}>＋ 🏷 Label</button>
          <input ref={input} type="file" accept="image/*" multiple style={{ display: 'none' }} data-testid="add-photos"
                 onChange={(e) => { const kind = e.target.dataset.kind || 'product'; e.target.dataset.kind = ''; onAdd(parcel, [...e.target.files], kind); e.target.value = ''; }} />
        </>
      )}
    </div>
  );
}

/** Gather other arrivals' photos onto this one - the warehouse reported one package as several. */
function MergePicker({ parcel, rows, onClose, onMerge }) {
  const [picked, setPicked] = useState([]);
  const others = rows.filter((p) => p.id !== parcel.id && p.status === 'unmatched' && p.photoUrl && !p.parentId && !p.canRestore);
  const toggle = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <Modal open lg onClose={onClose} title={`Merge arrivals into ${parcel.label}`}
           footer={(
             <>
               <button className="btn" onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={!picked.length} onClick={() => onMerge(parcel, picked)}>Merge {picked.length || ''} into this arrival</button>
             </>
           )}>
      <div className="small muted mb12">
        Tick the arrivals that are really parts of this same package (for example the warehouse sent the second half of a product as its own photo).
        Their photos are added to this arrival, which keeps its own carrier line; the ticked ones disappear. You can take a photo back out later with ⇱.
      </div>
      <div className="flex" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div style={{ textAlign: 'center' }}><Thumb src={parcel.photoUrl} size="lg" /><div className="small"><strong>{parcel.label}</strong><div className="muted">this one</div></div></div>
        <div style={{ alignSelf: 'center', fontSize: 22 }}>＋</div>
        {!others.length && <span className="muted small" style={{ alignSelf: 'center' }}>There is no other open arrival with a photo.</span>}
        {others.map((p) => (
          <label key={p.id} data-testid="merge-option" style={{ textAlign: 'center', cursor: 'pointer', padding: 4, borderRadius: 8, border: `2px solid ${picked.includes(p.id) ? 'var(--brand)' : 'transparent'}` }}>
            <Thumb src={p.photoUrl} size="lg" />
            <div className="small"><input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} /> <span className="mono">{p.label}</span></div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ParcelRow({ parcel, range, busy, reading, onMatch, onFree, onAssign, onUnmatch, onEdit, onDelete, onPicker, onSplit, onUnsplit, onCode, onChoose, onRelease, onSupply, onItemSaved, onAddPhotos, onRemovePhoto, onDetachPhoto, onMerge }) {
  const [open, setOpen] = useState(false);
  const s = latestSuggestions(parcel);
  const top = s?.items?.[0];
  const m = parcel.match;
  // Open the guesses when a look for an order finishes while you watch - not for every old arrival each time the page loads.
  const seenAt = useRef(s?.ranAt);
  useEffect(() => { if (s && parcel.status === 'unmatched' && s.ranAt !== seenAt.current) setOpen(true); }, [s?.ranAt, parcel.status]); // eslint-disable-line

  return (
    <>
      <tr style={parcel.status === 'split' ? { opacity: 0.65 } : undefined}>
        <td style={parcel.parentId ? { paddingLeft: 26 } : undefined}>
          <div className="mono">
            {parcel.parentId && <span className="muted" title="Cut out of a photo that showed several products">↳ </span>}
            <strong>{parcel.label}</strong>
          </div>
          <div className="small muted">
            {parcel.receivedOn}{parcel.note ? ` · ${parcel.note}` : ''}
            {parcel.children > 0 && parcel.status !== 'split' ? ` · ${parcel.children} split off` : ''}
          </div>
        </td>
        <td>
          {parcel.status === 'split' ? <span className="muted">—</span>
            : parcel.status === 'packed'
              ? <div><div className="mono"><strong>{parcel.code}</strong></div>{m && <ChannelBadge channel={m.channel} />}</div>
              : <CodeCell parcel={parcel} busy={busy} onCode={onCode} />}
        </td>
        <td>
          <div className="flex gap4">
            <a href={parcel.photoUrl ? withBase(parcel.photoUrl) : undefined} target="_blank" rel="noreferrer"><Thumb src={parcel.photoUrl} size="lg" /></a>
            {m?.item?.imageUrl && <Thumb src={m.item.imageUrl} size="lg" alt="Listing" />}
          </div>
          {parcel.originalPhotoUrl && (
            <a className="small" href={withBase(parcel.originalPhotoUrl)} target="_blank" rel="noreferrer" title="The photo as the warehouse sent it">original ↗</a>
          )}
          {(parcel.extraPhotos.length > 0 || (parcel.photoUrl && parcel.status !== 'split')) && (
            <ExtraPhotos parcel={parcel} busy={busy} onAdd={onAddPhotos} onRemove={onRemovePhoto} onDetach={onDetachPhoto} />
          )}
        </td>
        <td>{parcel.warehouse || <span className="muted">—</span>}</td>
        <td>
          {parcel.status === 'split' && (
            <span className="small muted">All pieces were split into {parcel.children} arrival{parcel.children === 1 ? '' : 's'} below</span>
          )}
          {parcel.status === 'packed' && <span className="badge green">Packed</span>}
          {m && (
            <div className="small" style={{ marginTop: parcel.status === 'packed' ? 4 : 0 }}>
              <div><strong>{m.item?.title ?? m.itemId}</strong>{m.item?.variant && <span className="muted"> · {m.item.variant}</span>}</div>
              <div className="muted">
                {m.item?.buyer}{m.item?.orderedAt ? ` · ${shortDay(m.item.orderedAt)}` : ''}{' '}
                <span className={`badge ${(SOURCE_BADGE[m.source] ?? SOURCE_BADGE.manual)[0]}`}>
                  {(SOURCE_BADGE[m.source] ?? SOURCE_BADGE.manual)[1]}{m.source !== 'manual' && m.score ? ` ${Math.round(m.score * 100)}%` : ''}
                </span>
              </div>
            </div>
          )}
          {parcel.hold && <HoldNotice hold={parcel.hold} busy={busy} onRelease={(release) => onRelease(parcel, release)} />}
          {m && <SupplyBox parcel={parcel} busy={busy} onSave={onSupply} />}
          {m && <ItemSupplyBox parcel={parcel} onSaved={onItemSaved} />}
          {!m && top && (
            <button className="btn xs ghost" onClick={() => setOpen((v) => !v)}>
              <span className={`badge ${scoreKind(top.score)}`}>{Math.round(top.score * 100)}%</span> {top.title.slice(0, 40)} {open ? '▴' : '▾'}
            </button>
          )}
          {!m && s && !top && parcel.status !== 'split' && <span className="small muted">No likely match in range</span>}
          {!m && !s && parcel.status !== 'split' && <span className="small muted">Not matched yet</span>}
          {!m && s?.needsItem && <div><button className="btn xs" disabled={busy} onClick={() => onChoose(parcel, s.needsItem)}>Which item of {s.needsItem.code}? ▸</button></div>}
          {!m && parcel.photoUrl && parcel.status !== 'split' && (reading || parcel.hasText) && (
            <div className="small muted" style={{ marginTop: 2 }}>{reading ? 'reading the text on the photo…' : '✓ text read from photo'}</div>
          )}
        </td>
        <td>
          <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
            {parcel.status === 'split' ? (
              <button className="btn xs" disabled={busy} onClick={() => onUnsplit(parcel)} title="Put the original photo back and remove the arrivals cut out of it">Restore original</button>
            ) : (
              <>
                {!m && <button className="btn xs" disabled={busy} onClick={() => onFree(parcel)}
                                title="Free, no AI: tracking number, order state, text read off the photo and colours. Assigns by itself only when the tracking number settles it.">{busy ? <Spinner /> : '⚡'} Free match</button>}
                {!m && <button className="btn xs primary" disabled={busy || !parcel.photoUrl} onClick={() => onMatch(parcel.id)}
                                title={parcel.photoUrl ? 'Uses AI credits: compare the photo with the unshipped orders in the date range' : 'Add a photo first'}>{busy ? <Spinner /> : parcel.suggestions ? 'Re-match' : 'Find match'}</button>}
                {!m && <button className="btn xs" disabled={busy} onClick={() => onPicker(parcel)}>Assign…</button>}
                {!m && parcel.photoUrl && (
                  <button className="btn xs" disabled={busy} onClick={() => onSplit(parcel)}
                          title="This photo shows products for more than one customer - cut each one out into its own arrival">✂ Split</button>
                )}
                {!m && !parcel.parentId && !parcel.canRestore && (
                  <button className="btn xs" disabled={busy} onClick={() => onMerge(parcel)}
                          title="Other arrivals are really parts of this same package - gather their photos here">⇉ Merge</button>
                )}
                {m && <button className="btn xs" disabled={busy} onClick={() => onUnmatch(parcel.id)}>Unmatch</button>}
                {(parcel.canRestore || parcel.parentId) && (
                  <button className="btn xs ghost" disabled={busy} onClick={() => onUnsplit(parcel)} title="Put the original photo back and remove the arrivals cut out of it">Undo split</button>
                )}
              </>
            )}
            <button className="btn xs ghost" onClick={() => onEdit(parcel)}>Edit</button>
            <button className="btn xs danger" disabled={busy} onClick={() => onDelete(parcel)}>Delete</button>
          </div>
        </td>
      </tr>
      {open && !m && s && (
        <tr><td colSpan={6} style={{ background: 'var(--surface-2)' }}>
          <Suggestions parcel={parcel} s={s} busy={busy} onAssign={(t) => onAssign(parcel.id, t)} onSplit={() => onSplit(parcel)} onChoose={onChoose} />
        </td></tr>
      )}
    </>
  );
}

// -------------------------------------------------------------------- queue

const STATUS_LABEL = { ready: 'Ready to pack', partial: 'Partly here', waiting: 'Waiting', packed: 'Packed' };
const STATUS_KIND = { ready: 'green', partial: 'amber', waiting: 'grey', packed: 'blue' };

/**
 * Hand a waiting order over by hand: type its package code (or leave it blank for the order's own / the next of the day)
 * and its YunExpress tracking number. The order leaves the queue, and both go into its Airtable row. Nothing is sent to
 * Etsy or Shopify - the buyer is not told anything.
 */
function HandoverBox({ order, onChanged }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState(null);
  const looksLikeCode = /^\d{2}-\d{4}-\d+/.test(String(order.ref ?? ''));

  const send = async (airtable) => {
    setBusy(true);
    try {
      const r = await api.post('/packing/orders/dispatch', { channel: order.channel, orderId: order.orderId, code: code.trim(), trackingNumber: tracking, airtable });
      if (r.airtable?.status === 'needs_decision') {
        setDecision(r);   // the order is handed over; Airtable holds something else in those cells
        return;
      }
      setDecision(null);
      const at = r.airtable;
      const where = !at || airtable === 'none' ? 'Airtable was not touched.'
        : at.status === 'sent' ? 'Written to Airtable.'
          : at.status === 'nothing_to_change' ? 'Airtable already had it.'
            : at.status === 'not_in_airtable' ? 'This order is not in Airtable yet - push it there first, then hand it over again to write the cells.'
              : at.status === 'not_mapped' ? 'No Airtable column was found for the code / tracking number.'
                : at.status === 'error' ? `Airtable said: ${at.message}` : '';
      toast({ kind: at?.status === 'error' || at?.status === 'not_in_airtable' || at?.status === 'not_mapped' ? 'warn' : 'ok', duration: 9000,
        title: `${r.code} · ${r.trackingNumber} - handed over`, body: `${order.ref} left the queue. ${where}` });
      setOpen(false); setCode(''); setTracking('');
      onChanged?.();
    } catch (err) { showError(err, 'Could not hand this order over'); } finally { setBusy(false); }
  };
  const answer = async (choice) => { await send(choice); };

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}
              title="Give this order its package code and YunExpress tracking number yourself - it leaves the queue and both go to Airtable">
        ✋ Hand over by hand {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', maxWidth: 560 }}>
          <div className="flex gap8" style={{ flexWrap: 'wrap' }}>
            <label className="flex col small" style={{ flex: '1 1 150px' }}>Package code
              <input className="input mono" value={code} placeholder={looksLikeCode ? order.ref : `blank = ${exampleCode()}`} aria-label={`Package code for ${order.ref}`}
                     onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="flex col small" style={{ flex: '2 1 220px' }}>YunExpress tracking number
              <input className="input mono" value={tracking} placeholder="YT2617900709012345" aria-label={`Tracking number for ${order.ref}`}
                     onChange={(e) => setTracking(e.target.value)} />
            </label>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            The order leaves "Waiting" and both are written into its Airtable row. Nothing goes to {order.channel === 'etsy' ? 'Etsy' : 'Shopify'} and the buyer is not told.
          </div>
          <div className="flex gap4" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn xs primary" disabled={busy || !tracking.trim()} onClick={() => send('check')}>{busy ? <Spinner /> : 'Hand over & send to Airtable'}</button>
            <button className="btn xs" disabled={busy || !tracking.trim()} onClick={() => send('none')} title="Only take it off the queue here">Hand over, leave Airtable alone</button>
          </div>
        </div>
      )}
      {decision && (
        <Modal open onClose={() => { setDecision(null); onChanged?.(); }} title="Airtable already has something else in this order's row"
               footer={(
                 <>
                   <button className="btn" disabled={busy} onClick={() => answer('keep')}>Keep (don't change)</button>
                   <button className="btn primary" disabled={busy} onClick={() => answer('change')}>{busy ? <Spinner /> : 'Change'}</button>
                 </>
               )}>
          <div className="small muted mb8">
            The order is handed over here already ({decision.code} · {decision.trackingNumber}). "Change" replaces what Airtable has; "Keep" leaves it as it is (empty cells are still filled).
          </div>
          <table className="data">
            <thead><tr><th>Airtable column</th><th>Airtable has</th><th>You entered</th></tr></thead>
            <tbody>
              {decision.airtable.conflicts.map((c) => (
                <tr key={`${c.destination}:${c.column}`}>
                  <td><strong>{c.column}</strong><div className="small muted">{c.field} · {c.destination}</div></td>
                  <td className="mono">{c.current}</td>
                  <td className="mono"><strong>{c.next}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}

function QueueOrder({ order, busy, onPack, onChanged }) {
  return (
    <div className="card mb12" style={{ padding: 12 }}>
      <div className="flex gap8" style={{ flexWrap: 'wrap' }}>
        <ChannelBadge channel={order.channel} />
        {order.shopName && <span className="badge grey">{order.shopName}</span>}
        <strong className="mono">{order.ref}</strong>
        <span className="muted small">{order.buyer} · {shortDay(order.orderedAt)}</span>
        <span className={`badge ${STATUS_KIND[order.status]}`}>{STATUS_LABEL[order.status]}</span>
        {order.hold && <HoldBadge hold={order.hold} />}
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
      {order.status !== 'packed' && <HandoverBox order={order} onChanged={onChanged} />}
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
  const [splitting, setSplitting] = useState(null);
  const [choosing, setChoosing] = useState(null);
  const [reading, setReading] = useState({});
  const [deciding, setDeciding] = useState(null);
  const [merging, setMerging] = useState(null);
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

  /** Said when a match leaves its order waiting for other pieces, or completes it. */
  const holdToast = (p) => {
    if (p?.hold?.state === 'active') {
      toast({ kind: 'info', title: `${p.label} → on hold ${p.hold.code}`, duration: 10000,
        body: `The rest of that order has not arrived (${p.hold.received} of ${p.hold.needed} pieces). Copy the 中文 message from its row and send it to the warehouse.` });
    } else if (p?.hold?.state === 'released' && !p.hold.forced) {
      toast({ kind: 'ok', title: `Order complete - send the ${p.hold.code} parcels together`, duration: 8000, body: 'The 中文 message on the row tells the warehouse.' });
    }
  };

  const confirm = async (id, target) => {
    flag(id, true);
    try {
      const p = await api.post(`/packing/parcels/${id}/confirm`, target);
      toast({ kind: 'ok', title: 'Matched' });
      holdToast(p);
      refresh();
    } catch (err) { showError(err, 'Could not match that'); } finally { flag(id, false); }
  };

  /** What the browser reads off every photo of a parcel (OCR, free), kept on the parcel for the free matcher. */
  const readText = useCallback(async (parcel) => {
    if (!parcel.photoUrl) return null;
    setReading((r) => ({ ...r, [parcel.id]: true }));
    try {
      const { readPhotoText } = await import('../lib/ocr.js');
      let all = '';
      if (!parcel.hasText) {
        const text = await readPhotoText(withBase(parcel.photoUrl));
        await api.post(`/packing/parcels/${parcel.id}/text`, { text });
        all = text;
      }
      for (const x of parcel.extraPhotos ?? []) {
        if (x.hasText) continue;
        // eslint-disable-next-line no-await-in-loop
        const text = await readPhotoText(withBase(x.url));
        // eslint-disable-next-line no-await-in-loop
        await api.post(`/packing/parcels/${parcel.id}/photos/${x.id}/text`, { text });
        all = `${all} ${text}`.trim();
      }
      return all || null;
    } catch (err) {
      toast({ kind: 'info', title: 'Could not read the text on that photo', body: `${err?.message ?? err} - the free match still uses tracking and colours.` });
      return null;
    } finally { setReading((r) => ({ ...r, [parcel.id]: false })); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The free matcher once. Resolves to the parcel, or null when it failed (an error is shown unless `silent`). */
  const quickOne = useCallback(async (id, { silent = false } = {}) => {
    try {
      const p = await api.post(`/packing/parcels/${id}/quick`, { ...range, assign: filters.autoAssign ? 'sure' : 'tracking' });
      if (p.status === 'matched') { toast({ kind: 'ok', title: `${p.label} → ${p.code}`, body: p.quick?.auto?.reason }); holdToast(p); }
      return p;
    } catch (err) { if (!silent) showError(err, 'Free match failed'); return null; }
  }, [range, filters.autoAssign]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The whole free routine for one arrival: tracking / order state / colours
   * right away (that alone settles it when the tracking number is on the order),
   * then - if it is still open - read the words off the photo and look again.
   */
  const freeOne = useCallback(async (parcel, { quiet = false } = {}) => {
    flag(parcel.id, true);
    try {
      let p = await quickOne(parcel.id, { silent: quiet });
      if (!p || p.status === 'matched') return p;
      if (parcel.photoUrl && (!p.hasText || (p.extraPhotos ?? []).some((x) => !x.hasText))) {
        const text = await readText(p);
        if (text) p = (await quickOne(parcel.id, { silent: true })) ?? p;
      }
      if (p.status !== 'matched') {
        if (p.quick?.needsItem && !quiet) setChoosing({ parcel: p, needsItem: p.quick.needsItem });
        else if (!quiet && !p.quick?.items?.length) toast({ kind: 'info', title: 'No likely match', body: 'Nothing in this date range looks like it. Type its order code, or try Find match (AI).' });
      }
      return p;
    } finally { flag(parcel.id, false); parcels.reload(); queue.reload(); }
  }, [quickOne, readText]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * One photo, several products: ask the AI to find them (strictly - only products it is sure of, none inside
   * another), and when there are two or more cut each out into its own arrival. Resolves to the new arrivals,
   * or null when the photo shows one product (or could not be looked at).
   */
  const autoSplitOne = useCallback(async (parcel, { quiet = true } = {}) => {
    if (!parcel.photoUrl || parcel.status !== 'unmatched' || parcel.quantity < 1) return null;
    flag(parcel.id, true);
    try {
      const d = await api.post(`/packing/parcels/${parcel.id}/detect`, { auto: true, channels: range.channels, from: range.from, to: range.to });
      if (!d.auto?.split) {
        if (!quiet) toast({ kind: 'info', title: `${parcel.label}: ${d.auto?.reason ?? 'nothing to split'}`, duration: 7000 });
        return null;
      }
      const { crops } = await splitPhoto(withBase(parcel.photoUrl), d.regions);
      const form = new FormData();
      form.append('regions', JSON.stringify(d.regions.map(({ x, y, w, h, group, label }) => ({ x, y, w, h, group, label }))));
      form.append('done', '1');
      crops.forEach((blob, i) => form.append('crops', blob, `piece-${i + 1}.jpg`));
      const r = await api.upload(`/packing/parcels/${parcel.id}/split`, form);
      toast({ kind: 'ok', title: `${parcel.label}: ${r.children.length} products found and split`, body: d.regions.map((x) => x.label).filter(Boolean).join(' · ') || undefined, duration: 8000 });
      return r.children;
    } catch (err) {
      toast({ kind: 'info', title: `Could not check ${parcel.label} for several products`, body: `${err?.message ?? err} - use ✂ Split on its row if the photo shows more than one.`, duration: 9000 });
      return null;
    } finally { flag(parcel.id, false); parcels.reload(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Split an arrival if its photo shows several products, then run the free match on what is left (each product on its own). */
  const splitThenMatch = useCallback(async (parcel, { quiet = true, split = true } = {}) => {
    const kids = split ? await autoSplitOne(parcel, { quiet }) : null;
    if (!kids?.length) return channels.length ? freeOne(parcel, { quiet }) : null;
    for (const kid of channels.length ? kids : []) {
      // eslint-disable-next-line no-await-in-loop
      await freeOne(kid, { quiet: true });
    }
    return null;
  }, [autoSplitOne, freeOne, channels.length]);

  const splitAll = async () => {
    const todo = (parcels.data?.rows ?? []).filter((p) => p.status === 'unmatched' && p.photoUrl && !p.parentId && !p.canRestore);
    if (!todo.length) return;
    cancelRef.current = false;
    for (let i = 0; i < todo.length; i += 1) {
      if (cancelRef.current) break;
      setProgress({ done: i, total: todo.length, split: true });
      // eslint-disable-next-line no-await-in-loop
      const kids = await autoSplitOne(todo[i], { quiet: true });
      for (const kid of channels.length ? kids ?? [] : []) {
        // eslint-disable-next-line no-await-in-loop
        await freeOne(kid, { quiet: true });
      }
    }
    setProgress(null);
    refresh();
  };

  const freeAll = async () => {
    const todo = (parcels.data?.rows ?? []).filter((p) => p.status === 'unmatched');
    if (!todo.length) return;
    cancelRef.current = false;
    for (let i = 0; i < todo.length; i += 1) {
      if (cancelRef.current) break;
      setProgress({ done: i, total: todo.length, free: true });
      // eslint-disable-next-line no-await-in-loop
      await freeOne(todo[i], { quiet: true });
    }
    setProgress(null);
    refresh();
  };

  /** Put an arrival on the order with this code. Resolves to true when it went through (or needs the item chosen). */
  const assignCode = useCallback(async (parcel, code, itemId = null) => {
    flag(parcel.id, true);
    try {
      const r = await api.post(`/packing/parcels/${parcel.id}/assign-code`, { code, itemId, ...range });
      if (r.needsItem) setChoosing({ parcel, needsItem: r.needsItem });
      else {
        setChoosing(null);
        toast(code ? { kind: 'ok', title: `${parcel.label} → ${r.parcel.code}`, body: r.parcel.match?.item?.title } : { kind: 'ok', title: `${parcel.label} released` });
        if (code) holdToast(r.parcel);
      }
      return true;
    } catch (err) { showError(err, 'That code did not work'); return false; } finally { flag(parcel.id, false); parcels.reload(); queue.reload(); }
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // A new arrival gets its order code at once: the one typed with it, or - free, no AI - whatever the
  // tracking number, order state, photo text and colours settle. The AI is never asked until "Find match" or "Match all" is pressed.
  const onAdded = (parcel) => {
    if (status !== 'all' && status !== 'unmatched') setStatus('all'); else parcels.reload();
    if (parcel.codeError) {
      toast({ kind: 'err', title: `Added ${parcel.label}, but its code did not fit`, body: parcel.codeError, duration: 9000 });
      return;
    }
    if (parcel.needsItem) {
      toast({ kind: 'info', title: `Added ${parcel.label}`, body: 'That order has several items - say which one this is.' });
      setChoosing({ parcel, needsItem: parcel.needsItem });
      return;
    }
    if (parcel.code) { toast({ kind: 'ok', title: `Added ${parcel.label} → ${parcel.code}`, body: parcel.match?.item?.title }); holdToast(parcel); return; }
    toast({ kind: 'ok', title: `Added ${parcel.label}` });
    if (channels.length || (filters.autoSplit && parcel.photoUrl)) splitThenMatch(parcel, { quiet: true, split: filters.autoSplit });
  };

  /** What the answer from Airtable means to the person who pressed the button. */
  const reportAirtable = (parcel, a) => {
    if (!a) { toast({ kind: 'ok', title: 'Saved' }); return; }
    if (a.autoMapped?.length) {
      toast({ kind: 'ok', title: 'Airtable columns mapped for you', duration: 12000,
        body: a.autoMapped.map((m) => `${m.field} → "${m.column}" (${m.destination})`).join(' · ') });
    }
    const where = (a.destinations ?? []).filter((d) => d.status === 'sent').map((d) => d.destination).join(', ');
    if (a.status === 'sent') toast({ kind: 'ok', title: 'Saved and sent to Airtable', body: where });
    else if (a.status === 'nothing_to_change') toast({ kind: 'ok', title: 'Saved', body: a.kept?.length ? 'Airtable was left as it is.' : 'Airtable already has exactly these values.' });
    else if (a.status === 'not_in_airtable') toast({ kind: 'info', title: 'Saved', duration: 9000, body: 'This order is not in Airtable yet - send it from Orders and the Taobao order and cost go with it.' });
    else if (a.status === 'not_mapped') toast({ kind: 'info', title: 'Saved', duration: 9000, body: 'The Airtable destination has no column for the Taobao order number or the cost. Map them in Settings > Airtable.' });
    else if (a.status === 'no_destination') toast({ kind: 'info', title: 'Saved', body: 'There is no Airtable destination for this shop yet (Settings > Airtable).' });
    else if (a.status === 'error') toast({ kind: 'err', title: 'Saved here, but Airtable failed', body: a.message, duration: 9000 });
  };

  /** Save the Taobao order and cost of a parcel's order; with 'check' also send them to Airtable (asking first if that would overwrite). */
  const saveSupply = async (parcel, values, airtable) => {
    const m = parcel.match;
    if (!m) return;
    flag(parcel.id, true);
    try {
      const r = await api.post('/packing/orders/supply', { channel: m.channel, orderId: m.orderId, ...values, airtable });
      if (r.airtable?.status === 'needs_decision') setDeciding({ parcel, conflicts: r.airtable.conflicts });
      else reportAirtable(parcel, r.airtable);
      refresh();
    } catch (err) { showError(err, 'Could not save that'); } finally { flag(parcel.id, false); }
  };

  const answerDecision = async (answer) => {
    const { parcel } = deciding;
    const m = parcel.match;
    flag(parcel.id, true);
    try {
      const r = await api.post('/packing/orders/supply', { channel: m.channel, orderId: m.orderId, airtable: answer });
      setDeciding(null);
      reportAirtable(parcel, r.airtable);
      refresh();
    } catch (err) { showError(err, 'Could not update Airtable'); } finally { flag(parcel.id, false); }
  };

  /** Let an order's held parcels go although the order is not complete - or hold them again. */
  const releaseHold = async (parcel, release) => {
    const m = parcel.match;
    if (!m) return;
    if (release && !window.confirm(`Release ${parcel.hold?.code}? The parcels are sent as they are, without waiting for the rest of the order.`)) return;
    flag(parcel.id, true);
    try {
      await api.post('/packing/orders/hold', { channel: m.channel, orderId: m.orderId, release });
      toast({ kind: 'ok', title: release ? 'Hold released' : 'Order put back on hold' });
      refresh();
    } catch (err) { showError(err, 'Could not change the hold'); } finally { flag(parcel.id, false); }
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

  const unsplit = async (parcel) => {
    if (!window.confirm('Put the original photo back? The arrivals cut out of it are removed, and any order they were matched to is released.')) return;
    flag(parcel.id, true);
    try {
      await api.post(`/packing/parcels/${parcel.id}/unsplit`, {});
      toast({ kind: 'ok', title: 'Original photo restored' });
      refresh();
    } catch (err) { showError(err, 'Could not restore that photo'); } finally { flag(parcel.id, false); }
  };

  /** More photos for an arrival (another side, the other tray, the carrier's label); their text is read for the free match. */
  const addPhotos = async (parcel, files, kind = 'product') => {
    if (!files.length) return;
    flag(parcel.id, true);
    try {
      const form = new FormData();
      for (const f of files) form.append('photos', await normalizePhoto(f));
      form.append('kind', kind);
      const p = await api.upload(`/packing/parcels/${parcel.id}/photos`, form);
      toast({ kind: 'ok', title: `${files.length} photo${files.length === 1 ? '' : 's'} added to ${parcel.label}` });
      parcels.reload();
      readText(p).then(() => parcels.reload());
    } catch (err) { showError(err, 'Could not add those photos'); } finally { flag(parcel.id, false); }
  };

  const removePhoto = async (parcel, photo) => {
    if (!window.confirm('Remove this photo from the arrival?')) return;
    flag(parcel.id, true);
    try { await api.del(`/packing/parcels/${parcel.id}/photos/${photo.id}`); refresh(); }
    catch (err) { showError(err, 'Could not remove that photo'); } finally { flag(parcel.id, false); }
  };

  const detachPhoto = async (parcel, photo) => {
    flag(parcel.id, true);
    try {
      await api.post(`/packing/parcels/${parcel.id}/photos/${photo.id}/detach`, {});
      toast({ kind: 'ok', title: 'That photo is an arrival of its own again' });
      refresh();
    } catch (err) { showError(err, 'Could not take that photo out'); } finally { flag(parcel.id, false); }
  };

  const mergeInto = async (parcel, sourceIds) => {
    flag(parcel.id, true);
    try {
      const p = await api.post(`/packing/parcels/${parcel.id}/merge`, { sourceIds });
      setMerging(null);
      toast({ kind: 'ok', title: `Merged - ${p.label} now has ${p.photoCount} photos` });
      refresh();
      if (channels.length) freeOne(p, { quiet: true });
    } catch (err) { showError(err, 'Could not merge those'); } finally { flag(parcel.id, false); }
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
  const splittable = (parcels.data?.rows ?? []).filter((p) => p.status === 'unmatched' && p.photoUrl && !p.parentId && !p.canRestore).length;
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
          <span title="When a new photo shows two or more different products, each one is cut out into its own arrival and matched on its own. The AI looks at each new photo once (a small cost); it only splits products it is sure of - never the table, a hand, a label or packing.">
            <Checkbox checked={filters.autoSplit} onChange={(v) => setFilter({ autoSplit: v })} label="Split photos with several products" />
          </span>
          <span title="A tracking number that names one order is always assigned straight away. Off by default for everything else: the AI's and the free matcher's best guesses are shown and nothing is assigned until you press Assign. Turn on to also assign when text and colours both clearly agree, or the AI is very confident.">
            <Checkbox checked={filters.autoAssign} onChange={(v) => setFilter({ autoAssign: v })} label="Also assign when the match is very sure" />
          </span>
        </div>
        <div className="small muted mt4">
          Orders of every connected shop placed in this range that have not shipped (no tracking yet, not canceled) are compared. Oldest orders come first.
          {queue.data && !queue.data.connected.etsy && filters.etsy && ' Etsy is not connected.'}
          {queue.data && !queue.data.connected.shopify && filters.shopify && ' Shopify is not connected.'}
        </div>
        {queue.data?.shops?.length > 0 && <div className="mt8"><UnshippedShops shops={queue.data.shops} olderThanRange={queue.data.olderThanRange} compact onFetched={() => queue.reload()} /></div>}
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
          <PhotoBrain />
          <AddParcel warehouse={filters.warehouse} onWarehouse={(v) => setFilter({ warehouse: v })} range={range} onAdded={onAdded} />
          <div className="flex gap8 mb12" style={{ flexWrap: 'wrap' }}>
            {['all', 'unmatched', 'matched', 'packed'].map((s) => (
              <button key={s} className={`btn xs ${status === s ? 'primary' : 'ghost'}`} onClick={() => setStatus(s)}>
                {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}{counts ? ` (${s === 'all' ? counts.total : counts[s]})` : ''}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {progress && <span className="small muted">{progress.split ? 'Looking for several products' : progress.free ? 'Free match' : 'Matching'} {progress.done + 1} of {progress.total}…</span>}
            {progress
              ? <button className="btn sm" onClick={() => { cancelRef.current = true; }}>Stop</button>
              : (
                <>
                  <button className="btn sm" disabled={!splittable} onClick={splitAll}
                          title="Uses AI credits: look at each unmatched photo and cut out every product when it shows several">✂ Split photos ({splittable})</button>
                  <button className="btn sm" disabled={!counts?.unmatched || !channels.length} onClick={freeAll}
                          title="Free, no AI: tracking, order state, text read off the photo, colours">⚡ Free match all ({counts?.unmatched ?? 0})</button>
                  <button className="btn sm primary" disabled={!unmatchedWithPhoto || !channels.length} onClick={matchAll}
                          title="Uses AI credits">Match all with AI ({unmatchedWithPhoto})</button>
                </>
              )}
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
                    <ParcelRow key={p.id} parcel={p} range={range} busy={!!working[p.id]} reading={!!reading[p.id]}
                               onMatch={matchOne} onFree={freeOne} onAssign={confirm} onUnmatch={unmatch}
                               onCode={assignCode} onChoose={(parcel, needsItem) => setChoosing({ parcel, needsItem })} onRelease={releaseHold} onSupply={saveSupply} onItemSaved={refresh}
                               onEdit={setEditing} onDelete={remove} onPicker={setPicking}
                               onSplit={setSplitting} onUnsplit={unsplit}
                               onAddPhotos={addPhotos} onRemovePhoto={removePhoto} onDetachPhoto={detachPhoto} onMerge={setMerging} />
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
            <QueueOrder key={`${o.channel}:${o.orderId}`} order={o} busy={!!working[`${o.channel}:${o.orderId}`]} onPack={pack} onChanged={() => queue.reload()} />
          ))}
        </>
      )}

      {editing && <EditParcel parcel={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {merging && <MergePicker parcel={merging} rows={parcels.data?.rows ?? []} onClose={() => setMerging(null)} onMerge={mergeInto} />}
      {splitting && <SplitPhoto parcel={splitting} range={range} onClose={() => setSplitting(null)} onDone={() => { setSplitting(null); refresh(); }} />}
      {deciding && (
        <AirtableDecision decision={deciding} busy={!!working[deciding.parcel.id]} onAnswer={answerDecision} onClose={() => setDeciding(null)} />
      )}
      {choosing && (
        <ItemChooser parcel={choosing.parcel} needsItem={choosing.needsItem} busy={!!working[choosing.parcel.id]}
                     onClose={() => setChoosing(null)}
                     onChoose={(item) => assignCode(choosing.parcel, choosing.needsItem.code, item.itemId)} />
      )}
      {picking && (
        <AssignPicker parcel={picking} range={range} onClose={() => setPicking(null)}
                      onAssign={async (t) => { const id = picking.id; setPicking(null); await confirm(id, { ...t, source: 'manual' }); }} />
      )}
    </Page>
  );
}
