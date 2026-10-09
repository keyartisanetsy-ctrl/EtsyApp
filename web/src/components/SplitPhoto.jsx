import React, { useEffect, useMemo, useRef, useState } from 'react';
import api, { withBase } from '../lib/api.js';
import { leftoverShare, splitPhoto } from '../lib/photo.js';
import { Modal, Spinner, Checkbox, useToast, useErrorToast } from './ui.jsx';
import RegionEditor, { REGION_COLORS, newRegionId } from './RegionEditor.jsx';
import PhotoBrain from './PhotoBrain.jsx';

/** Boxes that came without a product number each get the next free one. */
function numbered(boxes) {
  let next = boxes.reduce((m, b) => Math.max(m, Number(b.group) || 0), 0);
  return boxes.map((b) => ({ label: '', ...b, group: Number(b.group) > 0 ? Number(b.group) : (next += 1), id: b.id || newRegionId() }));
}

const PRESETS = [
  { id: 'lr', label: '◧◨ Left / right', boxes: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
  { id: 'tb', label: '⬒⬓ Top / bottom', boxes: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }] },
  { id: 'thirds', label: '▥ Thirds', boxes: [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }] },
];

const ENGINES = [['', 'Automatic'], ['openai', 'OpenAI'], ['anthropic', 'Claude'], ['gemini', 'Gemini'], ['openrouter', 'OpenRouter']];

/**
 * One photo that shows products for several customers: mark each part with a box (the AI can
 * suggest them, and works out which parts are one product - the warehouse often lays a kit and its
 * accessory set in separate trays). Boxes with the same product number become ONE arrival holding all
 * of those photos; every other product gets its own arrival, to be matched to its own customer's order.
 */
export default function SplitPhoto({ parcel, range, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [regions, setRegionsRaw] = useState([]);
  const [busy, setBusy] = useState('');
  const [finished, setFinished] = useState(false);
  const [engine, setEngine] = useState('');
  const [said, setSaid] = useState(null);
  const touched = useRef(false);

  const setRegions = (r) => setRegionsRaw(numbered(r));
  const leftover = useMemo(() => leftoverShare(regions), [regions]);
  const products = useMemo(() => new Set(regions.map((r) => r.group)).size, [regions]);
  // A product's parts are counted once (the biggest count among them), the same way the server makes its arrivals.
  const pieces = useMemo(() => {
    const per = new Map();
    for (const r of regions) per.set(r.group, Math.max(per.get(r.group) ?? 0, Number(r.count) || 1));
    return [...per.values()].reduce((a, b) => a + b, 0);
  }, [regions]);

  // Likely finished once every reported piece has a product (or the boxes cover nearly the whole photo);
  // a tight box always leaves a margin of table around it, so the leftover share alone cannot tell.
  useEffect(() => {
    if (!touched.current) setFinished(regions.length > 0 && (pieces >= parcel.quantity || leftover < 0.06));
  }, [regions, pieces, leftover, parcel.quantity]);

  const suggest = async () => {
    setBusy('detect');
    setSaid(null);
    try {
      const res = await api.post(`/packing/parcels/${parcel.id}/detect`, {
        provider: engine || undefined, channels: range?.channels, from: range?.from, to: range?.to,
      });
      setSaid({ provider: res.provider, tried: res.tried ?? [], note: res.note });
      if (!res.regions.length) {
        toast({ kind: 'info', title: 'No separate products found', body: 'Draw a box around each product by hand.' });
      } else {
        setRegions(res.regions);
        touched.current = false;
      }
    } catch (err) { showError(err, 'The AI could not look at this photo'); } finally { setBusy(''); }
  };

  const save = async () => {
    setBusy('save');
    try {
      const { crops, remainder } = await splitPhoto(withBase(parcel.photoUrl), regions);
      const form = new FormData();
      form.append('regions', JSON.stringify(regions.map(({ x, y, w, h, group, label, count }) => ({ x, y, w, h, group, label, count: Math.max(1, Number(count) || 1) }))));
      form.append('done', finished || !remainder ? '1' : '0');
      crops.forEach((blob, i) => form.append('crops', blob, `piece-${i + 1}.jpg`));
      if (remainder && !finished) form.append('remainder', remainder, 'rest.jpg');
      const result = await api.upload(`/packing/parcels/${parcel.id}/split`, form);
      toast({ kind: 'ok', title: `Split into ${result.children.length} arrival${result.children.length === 1 ? '' : 's'}` });
      onDone(result);
    } catch (err) { showError(err, 'Could not split that photo'); setBusy(''); }
  };

  const patch = (id, change) => setRegions(regions.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const count = regions.length;
  const options = Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1);

  return (
    <Modal open lg onClose={() => !busy && onClose()} title={`Split photo - ${parcel.label}`}
           footer={(
             <>
               <button className="btn" disabled={!!busy} onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={!count || !!busy} onClick={save}>
                 {busy === 'save' ? <Spinner /> : '✂'} Split into {products || '…'} arrival{products === 1 ? '' : 's'}
               </button>
             </>
           )}>
      <div className="small muted mb12">
        Drag across the photo to draw a box around one part. Move a box by dragging it, resize it by its edges.
        Each product becomes its own arrival with just its photo(s), ready to be matched to its customer's order.
        If the warehouse put one product's parts in different places, give those boxes the <strong>same product number</strong> - they stay together as one arrival.
      </div>
      <div className="flex" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0, textAlign: 'center' }}>
          <RegionEditor src={withBase(parcel.photoUrl)} regions={regions} onChange={(r) => { setRegions(r); }} disabled={!!busy} />
        </div>
        <div style={{ flex: '0 0 300px' }} className="flex col">
          <div className="flex gap4" style={{ alignItems: 'center' }}>
            <button className="btn" style={{ flex: 1 }} disabled={!!busy} onClick={suggest}>
              {busy === 'detect' ? <Spinner /> : '✦'} Suggest boxes (AI)
            </button>
            <select className="select sm" style={{ width: 110 }} value={engine} onChange={(e) => setEngine(e.target.value)} title="Which AI looks at the photo">
              {ENGINES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {said && (
            <div className="small muted" data-testid="engine-said">
              Looked with {said.provider}{said.tried.length ? ` (${said.tried.map((t) => `${t.engine} failed: ${t.error}`).join('; ')})` : ''}.
              {said.note ? ` ${said.note}` : ''}
            </div>
          )}
          <div className="small muted">Or split quickly:</div>
          <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p.id} className="btn xs" disabled={!!busy} onClick={() => { setRegions(p.boxes.map((b) => ({ ...b }))); touched.current = false; }}>{p.label}</button>
            ))}
            <button className="btn xs ghost" disabled={!!busy || !count} onClick={() => { setRegions([]); touched.current = false; }}>Clear</button>
          </div>

          <div className="small" style={{ marginTop: 8 }}>
            {count ? (
              <div className="flex col" style={{ gap: 6 }}>
                {regions.map((r, i) => (
                  <div key={r.id} className="flex gap4" style={{ alignItems: 'center' }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: REGION_COLORS[(r.group - 1) % REGION_COLORS.length], flex: '0 0 auto' }} />
                    <input className="input sm" style={{ flex: 1, minWidth: 0 }} value={r.label} placeholder={`Part ${i + 1}`} aria-label={`Name of part ${i + 1}`}
                           disabled={!!busy} onChange={(e) => patch(r.id, { label: e.target.value })} />
                    <input className="input sm" style={{ width: 54, textAlign: 'center' }} type="number" min="1" max="99" value={r.count ?? 1} disabled={!!busy}
                           aria-label={`Pieces in part ${i + 1}`} title="How many identical pieces this box holds (stacked boxes)"
                           onChange={(e) => patch(r.id, { count: Math.max(1, Number(e.target.value) || 1) })} />
                    <select className="select sm" style={{ width: 92 }} value={r.group} disabled={!!busy} aria-label={`Product of part ${i + 1}`}
                            title="Parts with the same product number stay together as one arrival"
                            onChange={(e) => patch(r.id, { group: Number(e.target.value) })}>
                      {[...new Set([...options, r.group])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>Product {n}</option>)}
                    </select>
                    <button className="btn xs ghost" disabled={!!busy} onClick={() => setRegions(regions.filter((x) => x.id !== r.id))}>✕</button>
                  </div>
                ))}
                {count > 1 && (
                  <div className="flex gap4">
                    <button className="btn xs" disabled={!!busy} onClick={() => setRegions(regions.map((r) => ({ ...r, group: 1 })))}
                            title="All these parts are one customer product">Join all as one product</button>
                    <button className="btn xs ghost" disabled={!!busy} onClick={() => setRegions(regions.map((r, i) => ({ ...r, group: i + 1 })))}
                            title="Every part is a different product">Separate all</button>
                  </div>
                )}
              </div>
            ) : <span className="muted">No boxes yet.</span>}
          </div>

          {count > 0 && (
            <div className="small" style={{ marginTop: 8 }}>
              <div className="muted mb4">
                {count} part{count === 1 ? '' : 's'} → {products} product{products === 1 ? '' : 's'}, {pieces} piece{pieces === 1 ? '' : 's'} counted. The warehouse reported {parcel.quantity} piece{parcel.quantity === 1 ? '' : 's'}; {Math.round(leftover * 100)}% of the photo is outside the boxes.
              </div>
              <Checkbox checked={finished} onChange={(v) => { touched.current = true; setFinished(v); }} label="Nothing else is left in this photo" />
              <div className="muted" style={{ marginTop: 4 }}>
                {finished
                  ? 'The original arrival is finished once the pieces are split out.'
                  : 'The rest of the photo stays with the original arrival, so it can be matched or split again.'}
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={{ marginTop: 12 }}><PhotoBrain /></div>
    </Modal>
  );
}
