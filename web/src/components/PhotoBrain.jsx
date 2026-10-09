import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Spinner, useAsync, useToast, useErrorToast } from './ui.jsx';

const NAMES = { openai: 'OpenAI', anthropic: 'Anthropic (Claude)', gemini: 'Gemini', openrouter: 'OpenRouter' };

/**
 * How the photo reader is set up: which AI engine looks at warehouse photos (any of them can stand
 * in for another - if one fails or runs out of credit the next one that has a key takes over), the
 * sentences the seller wants every look to know, and what it has learned from corrections.
 */
export default function PhotoBrain({ defaultOpen = false }) {
  const toast = useToast();
  const showError = useErrorToast();
  const { data, loading, reload } = useAsync(() => api.get('/packing/brain'), []);
  const [open, setOpen] = useState(defaultOpen);
  const [engine, setEngine] = useState('');
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEngine(data.engine);
    setModel(data.model);
    setText(data.instructions);
  }, [data]);

  const dirty = data && (engine !== data.engine || model !== data.model || text.trim() !== data.instructions);
  const ready = (data?.engines ?? []).filter((e) => e.configured);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/packing/brain', { engine, model, instructions: text });
      toast({ kind: 'ok', title: 'Saved - every photo look from now on uses this' });
      reload();
    } catch (err) { showError(err, 'Could not save that'); } finally { setBusy(false); }
  };

  const forget = async () => {
    if (!window.confirm('Forget everything the photo reader learned from your corrections? Your own instructions stay.')) return;
    try { await api.del('/packing/brain/lessons'); reload(); } catch (err) { showError(err, 'Could not forget that'); }
  };

  return (
    <div className="card mb16" data-testid="photo-brain">
      <div className="card-head" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <h3>Photo reader {open ? '▴' : '▾'}</h3>
        <div className="spacer" />
        {data && (
          <span className="small muted">
            {ready.length ? `${ready.length} engine${ready.length === 1 ? '' : 's'} ready` : 'no AI engine has a key yet'}
            {data.instructions ? ' · your instructions on' : ''}
            {data.lessons.length ? ` · ${data.lessons.length} learned` : ''}
          </span>
        )}
      </div>
      {open && (loading && !data ? <Spinner /> : data && (
        <div className="flex col" style={{ gap: 10 }}>
          <div className="small muted">
            This is what looks at the warehouse photos - to find the products in them, group the parts of one product, and match them to orders.
            Free matching never uses it. Give it more than one engine and it falls back to the next when one fails.
          </div>
          <div className="flex gap8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="flex col small" style={{ minWidth: 220 }}>Engine to try first
              <select className="select" value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="">Automatic (first one with a key)</option>
                {data.engines.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.configured}>{NAMES[e.id]}{e.configured ? '' : ' (no key)'}</option>
                ))}
              </select>
            </label>
            <label className="flex col small" style={{ minWidth: 220 }}>Model (blank = the engine's own)
              <input className="input" value={model} placeholder={data.engines.find((e) => e.id === engine)?.model || ''} onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>
          {!ready.length && (
            <div className="small" style={{ color: 'var(--warn, #b45309)' }}>
              Add a key for OpenAI, Anthropic, Gemini or OpenRouter in Settings → AI providers. Gemini's Flash models are the cheapest; OpenRouter gives all of them with one key.
            </div>
          )}
          <label className="flex col small">What I want the system to know
            <textarea className="textarea" rows={4} value={text} maxLength={2000}
                      placeholder={'For example: Our warehouse often splits ONE product into several trays - a keyboard kit in one and its accessory set in another. Treat those as one product. A label or a receipt in the photo is never a product.'}
                      onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="flex gap8">
            <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? <Spinner /> : 'Save'}</button>
          </div>
          <div className="small">
            <div className="flex gap8" style={{ alignItems: 'center' }}>
              <strong>Learned from what you did by hand</strong>
              <span className="muted">· {data.looks} remembered look{data.looks === 1 ? '' : 's'} of products (used by the free match)</span>
              <div style={{ flex: 1 }} />
              {data.lessons.length > 0 && <button className="btn xs ghost" onClick={forget}>Forget</button>}
            </div>
            {data.lessons.length ? (
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {data.lessons.slice(0, 8).map((l) => <li key={l.id} className="muted">{l.text}</li>)}
              </ul>
            ) : <div className="muted">Nothing yet. Group or split a photo by hand and it is remembered here.</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
