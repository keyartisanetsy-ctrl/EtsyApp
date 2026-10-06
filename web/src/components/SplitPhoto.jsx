import React, { useEffect, useMemo, useRef, useState } from 'react';
import api, { withBase } from '../lib/api.js';
import { leftoverShare, splitPhoto } from '../lib/photo.js';
import { Modal, Spinner, Checkbox, useToast, useErrorToast } from './ui.jsx';
import RegionEditor, { REGION_COLORS, newRegionId } from './RegionEditor.jsx';

const withIds = (boxes) => boxes.map((b) => ({ label: '', ...b, id: newRegionId() }));

const PRESETS = [
  { id: 'lr', label: '◧◨ Left / right', boxes: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
  { id: 'tb', label: '⬒⬓ Top / bottom', boxes: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }] },
  { id: 'thirds', label: '▥ Thirds', boxes: [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }] },
];

/**
 * One photo that shows products for several customers: mark each product with
 * a box (the AI can suggest them), and each box is cut out into its own
 * arrival - its own photo, to be matched to its own customer's order - while
 * those parts are taken out of the original photo.
 */
export default function SplitPhoto({ parcel, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [regions, setRegions] = useState([]);
  const [busy, setBusy] = useState('');
  const [finished, setFinished] = useState(false);
  const touched = useRef(false);

  const leftover = useMemo(() => leftoverShare(regions), [regions]);
  // Likely finished once every reported piece has a box (or the boxes cover nearly the whole photo);
  // a tight box always leaves a margin of table around it, so the leftover share alone cannot tell.
  useEffect(() => {
    if (!touched.current) setFinished(regions.length > 0 && (regions.length >= parcel.quantity || leftover < 0.06));
  }, [regions, leftover, parcel.quantity]);

  const suggest = async () => {
    setBusy('detect');
    try {
      const res = await api.post(`/packing/parcels/${parcel.id}/detect`, {});
      if (!res.regions.length) {
        toast({ kind: 'info', title: 'No separate products found', body: 'Draw a box around each product by hand.' });
      } else {
        setRegions(withIds(res.regions));
        touched.current = false;
      }
    } catch (err) { showError(err, 'The AI could not look at this photo'); } finally { setBusy(''); }
  };

  const save = async () => {
    setBusy('save');
    try {
      const { crops, remainder } = await splitPhoto(withBase(parcel.photoUrl), regions);
      const form = new FormData();
      form.append('regions', JSON.stringify(regions.map(({ x, y, w, h }) => ({ x, y, w, h }))));
      form.append('done', finished || !remainder ? '1' : '0');
      crops.forEach((blob, i) => form.append('crops', blob, `piece-${i + 1}.jpg`));
      if (remainder && !finished) form.append('remainder', remainder, 'rest.jpg');
      const result = await api.upload(`/packing/parcels/${parcel.id}/split`, form);
      toast({ kind: 'ok', title: `Split into ${result.children.length} arrival${result.children.length === 1 ? '' : 's'}` });
      onDone(result);
    } catch (err) { showError(err, 'Could not split that photo'); setBusy(''); }
  };

  const count = regions.length;
  return (
    <Modal open lg onClose={() => !busy && onClose()} title={`Split photo - ${parcel.label}`}
           footer={(
             <>
               <button className="btn" disabled={!!busy} onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={!count || !!busy} onClick={save}>
                 {busy === 'save' ? <Spinner /> : '✂'} Split into {count || '…'} arrival{count === 1 ? '' : 's'}
               </button>
             </>
           )}>
      <div className="small muted mb12">
        Drag across the photo to draw a box around one customer's product. Move a box by dragging it, resize it by its edges.
        Each box becomes its own arrival with just that product in the photo, ready to be matched to its customer's order.
      </div>
      <div className="flex" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0, textAlign: 'center' }}>
          <RegionEditor src={withBase(parcel.photoUrl)} regions={regions} onChange={(r) => { setRegions(r); }} disabled={!!busy} />
        </div>
        <div style={{ flex: '0 0 250px' }} className="flex col">
          <button className="btn" disabled={!!busy} onClick={suggest}>
            {busy === 'detect' ? <Spinner /> : '✦'} Suggest boxes (AI)
          </button>
          <div className="small muted">Or split quickly:</div>
          <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p.id} className="btn xs" disabled={!!busy} onClick={() => { setRegions(withIds(p.boxes)); touched.current = false; }}>{p.label}</button>
            ))}
            <button className="btn xs ghost" disabled={!!busy || !count} onClick={() => { setRegions([]); touched.current = false; }}>Clear</button>
          </div>

          <div className="small" style={{ marginTop: 8 }}>
            {count ? (
              <div className="flex col" style={{ gap: 4 }}>
                {regions.map((r, i) => (
                  <div key={r.id} className="flex gap8">
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: REGION_COLORS[i % REGION_COLORS.length], flex: '0 0 auto' }} />
                    <span>Box {i + 1}{r.label ? <span className="muted"> · {r.label}</span> : null}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn xs ghost" disabled={!!busy} onClick={() => setRegions(regions.filter((x) => x.id !== r.id))}>Remove</button>
                  </div>
                ))}
              </div>
            ) : <span className="muted">No boxes yet.</span>}
          </div>

          {count > 0 && (
            <div className="small" style={{ marginTop: 8 }}>
              <div className="muted mb4">
                The warehouse reported {parcel.quantity} piece{parcel.quantity === 1 ? '' : 's'}; {Math.round(leftover * 100)}% of the photo is outside the boxes.
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
    </Modal>
  );
}
