import React, { useRef, useState } from 'react';

export const REGION_COLORS = ['#f2643c', '#34d399', '#4a9eff', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#a3e635', '#fb7185', '#60a5fa', '#facc15', '#c084fc'];

const MIN = 0.03;
const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const handlePos = (h) => ({
  left: h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%',
  top: h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%',
});

let counter = 0;
export const newRegionId = () => { counter += 1; return `region-${Date.now()}-${counter}`; };

/**
 * A photo with boxes on it: drag across the photo to draw one, drag a box to
 * move it, pull an edge or corner to resize it. Boxes are fractions of the
 * photo's width and height, so they mean the same thing at any size on screen.
 */
export default function RegionEditor({ src, regions, onChange, disabled = false }) {
  const wrapRef = useRef(null);
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);

  const point = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const begin = (e, state) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    wrapRef.current.setPointerCapture(e.pointerId);
    drag.current = { ...state, start: point(e) };
  };

  const update = (id, patch) => onChange(regions.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (d.mode === 'draw') {
      setDraft({ x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) });
    } else if (d.mode === 'move') {
      update(d.id, {
        x: clamp(d.orig.x + p.x - d.start.x, 0, 1 - d.orig.w),
        y: clamp(d.orig.y + p.y - d.start.y, 0, 1 - d.orig.h),
      });
    } else if (d.mode === 'resize') {
      let left = d.orig.x;
      let right = d.orig.x + d.orig.w;
      let top = d.orig.y;
      let bottom = d.orig.y + d.orig.h;
      if (d.handle.includes('w')) left = clamp(p.x, 0, right - MIN);
      if (d.handle.includes('e')) right = clamp(p.x, left + MIN, 1);
      if (d.handle.includes('n')) top = clamp(p.y, 0, bottom - MIN);
      if (d.handle.includes('s')) bottom = clamp(p.y, top + MIN, 1);
      update(d.id, { x: left, y: top, w: right - left, h: bottom - top });
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'draw' && draft && draft.w >= MIN && draft.h >= MIN) {
      onChange([...regions, { ...draft, id: newRegionId(), label: '' }]);
    }
    setDraft(null);
  };

  return (
    <div
      ref={wrapRef}
      onPointerDown={(e) => begin(e, { mode: 'draw' })}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{ position: 'relative', display: 'inline-block', lineHeight: 0, userSelect: 'none', touchAction: 'none', cursor: disabled ? 'default' : 'crosshair', maxWidth: '100%' }}
    >
      <img src={src} alt="Parcel" draggable={false} style={{ display: 'block', maxWidth: '100%', maxHeight: '62vh', width: 'auto', height: 'auto', borderRadius: 6 }} />
      {regions.map((r, i) => {
        // Boxes of one product share a number and a colour.
        const product = r.group ?? i + 1;
        const color = REGION_COLORS[(product - 1) % REGION_COLORS.length];
        return (
          <div key={r.id}
               onPointerDown={(e) => begin(e, { mode: 'move', id: r.id, orig: { ...r } })}
               style={{
                 position: 'absolute', left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                 border: `2px solid ${color}`, background: `${color}26`, boxSizing: 'border-box', cursor: disabled ? 'default' : 'move',
               }}>
            <span style={{ position: 'absolute', left: 0, top: 0, transform: 'translateY(-100%)', background: color, color: '#111', font: '700 12px/1 system-ui', padding: '3px 6px', borderRadius: '4px 4px 0 0', display: 'flex', gap: 6, alignItems: 'center' }}>
              {product}
              {!disabled && (
                <button type="button" aria-label={`Remove box ${i + 1}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onChange(regions.filter((x) => x.id !== r.id)); }}
                        style={{ all: 'unset', cursor: 'pointer', fontWeight: 800 }}>×</button>
              )}
            </span>
            {!disabled && HANDLES.map((h) => (
              <span key={h}
                    onPointerDown={(e) => begin(e, { mode: 'resize', id: r.id, handle: h, orig: { ...r } })}
                    style={{ position: 'absolute', ...handlePos(h), width: 12, height: 12, marginLeft: -6, marginTop: -6, background: '#fff', border: `2px solid ${color}`, borderRadius: 3, boxSizing: 'border-box', cursor: CURSOR[h] }} />
            ))}
          </div>
        );
      })}
      {draft && (
        <div style={{ position: 'absolute', left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`, border: '2px dashed #fff', background: 'rgba(255,255,255,.15)', pointerEvents: 'none', boxSizing: 'border-box' }} />
      )}
    </div>
  );
}
