import React, { useEffect, useRef, useState } from 'react';
import api, { withBase } from '../lib/api.js';
import { Spinner, Modal, Banner, Checkbox, useToast, useErrorToast } from './ui.jsx';

/** A small right-click menu at the pointer. Closes on any click elsewhere, Escape or scroll. */
export function PictureMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('scroll', onClose, true); };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, window.innerHeight - (items.length * 34 + 16));
  return (
    <div ref={ref} role="menu" style={{
      position: 'fixed', left, top, zIndex: 3000, minWidth: 240, padding: 6, borderRadius: 10,
      background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 12px 32px rgba(0,0,0,.45)',
    }}>
      {items.map((it, i) => (it.sep
        ? <div key={`sep${i}`} style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
        : (
          <button key={it.label} role="menuitem" className="btn xs ghost" disabled={it.disabled}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', color: it.danger ? 'var(--bad)' : undefined }}
                  onClick={() => { onClose(); it.run(); }}>{it.label}</button>
        )))}
    </div>
  );
}

const seconds = (n) => (n >= 60 ? `${Math.floor(n / 60)} min ${n % 60} s` : `${n} s`);

/**
 * Edit one picture of a draft with AI - by default "translate the words on it into English, keep the product and the
 * background". Pick Manus or ChatGPT and a model, adjust the instruction if wanted, look at the result beside the
 * original, and then replace the picture, add the result next to it, or throw it away.
 */
export function ImageAiModal({ listingId, image, autoRun = false, onClose, onApplied }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [opts, setOpts] = useState(null);
  const [provider, setProvider] = useState('manus');
  const [model, setModel] = useState('lite');
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    let live = true;
    api.get('/drafts/image-edit/options').then((o) => {
      if (!live) return;
      setOpts(o);
      setProvider(o.defaults.provider);
      setModel(o.defaults.provider === 'manus' ? o.defaults.manusModel : o.defaults.openaiModel);
      setPrompt(o.defaults.prompt);
    }).catch((err) => showError(err, 'Could not load the AI choices'));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const models = opts?.providers.find((p) => p.id === provider)?.models ?? [];
  const configured = opts?.providers.find((p) => p.id === provider)?.configured;
  const pickProvider = (id) => {
    setProvider(id);
    setModel(id === 'manus' ? opts.defaults.manusModel : opts.defaults.openaiModel);
  };

  const start = async (override = {}) => {
    setBusy(true);
    try {
      const j = await api.post(`/drafts/${listingId}/media/${image.id}/ai-edit`, { provider, model, prompt, ...override });
      setJob(j);
    } catch (err) { showError(err, 'Could not start the edit'); } finally { setBusy(false); }
  };

  // "Translate" from the menu starts straight away with what was used last time.
  useEffect(() => {
    if (autoRun && opts && !started.current) { started.current = true; start({ provider: opts.defaults.provider, model: opts.defaults.provider === 'manus' ? opts.defaults.manusModel : opts.defaults.openaiModel, prompt: opts.defaults.prompt }); }
  }, [opts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!job || job.status !== 'running') return undefined;
    const t = setInterval(async () => {
      try { setJob(await api.get(`/drafts/image-edit/jobs/${job.jobId}`)); } catch (err) { setJob({ ...job, status: 'error', error: err.message }); }
    }, 2000);
    return () => clearInterval(t);
  }, [job?.jobId, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (mode) => {
    setBusy(true);
    try {
      await api.post(`/drafts/image-edit/jobs/${job.jobId}/apply`, { mode });
      toast({ kind: 'ok', title: mode === 'replace' ? 'Picture replaced' : 'Edited picture added' });
      onApplied();
      onClose();
    } catch (err) { showError(err, 'Could not use that picture'); } finally { setBusy(false); }
  };
  const discard = async () => {
    if (job) api.del(`/drafts/image-edit/jobs/${job.jobId}`).catch(() => {});
    onClose();
  };

  const running = job?.status === 'running';
  const done = job?.status === 'done';
  return (
    <Modal open lg onClose={() => !busy && !running && discard()} title="Edit picture with AI"
           footer={done ? (
             <>
               <button className="btn" disabled={busy} onClick={discard}>Discard</button>
               <button className="btn" disabled={busy} onClick={() => setJob(null)}>Change the instruction & try again</button>
               <div className="spacer" />
               <button className="btn" disabled={busy} onClick={() => apply('add')}>Add next to the original</button>
               <button className="btn primary" disabled={busy} onClick={() => apply('replace')}>{busy ? <Spinner /> : 'Replace the picture'}</button>
             </>
           ) : (
             <>
               <button className="btn" disabled={running} onClick={discard}>Cancel</button>
               <button className="btn primary" disabled={!opts || busy || running || !configured} onClick={() => start()}>
                 {busy || running ? <Spinner /> : '✦'} Edit the picture
               </button>
             </>
           )}>
      {!opts ? <Spinner /> : (
        <div className="flex" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <div className="small muted mb4">{done ? 'Original' : 'This picture'}</div>
            <img src={image.url.startsWith('/api/') ? withBase(image.url) : image.url} alt="Original" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', background: '#000' }} />
          </div>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            {done ? (
              <>
                <div className="small muted mb4">Edited · {job.provider === 'manus' ? 'Manus' : 'ChatGPT'} {job.model} · {seconds(job.seconds)}</div>
                <img src={withBase(job.previewUrl)} alt="Edited" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', background: '#000' }} />
                <div className="small muted mt4">Look it over - nothing changes until you choose one of the buttons below.</div>
              </>
            ) : running ? (
              <div className="card" style={{ padding: 16 }}>
                <div className="flex gap8" style={{ alignItems: 'center' }}><Spinner /> <strong>{job.provider === 'manus' ? 'Manus is working on it…' : 'ChatGPT is working on it…'}</strong></div>
                <div className="small muted mt8">
                  {job.provider === 'manus' ? 'Manus is an agent - this usually takes one to three minutes. ' : 'Usually under a minute. '}
                  You can keep this window open.{job.taskUrl ? <> <a href={job.taskUrl} target="_blank" rel="noreferrer">Watch it on Manus ↗</a></> : null}
                </div>
              </div>
            ) : (
              <>
                {job?.status === 'error' && <Banner kind="err">{job.error}</Banner>}
                <div className="small muted mb4">Which AI</div>
                <div className="flex gap4 mb8" role="tablist">
                  {opts.providers.map((p) => (
                    <button key={p.id} role="tab" aria-selected={provider === p.id} className={`btn sm ${provider === p.id ? 'primary' : ''}`}
                            onClick={() => pickProvider(p.id)}>{p.label}{p.configured ? '' : ' (no key)'}</button>
                  ))}
                </div>
                <label className="flex col small mb8">Model
                  <select className="input" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                    {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.note ? ` - ${m.note}` : ''}</option>)}
                  </select>
                </label>
                {!configured && <Banner kind="warn">This one has no API key yet - add it in Settings &gt; AI, or pick the other.</Banner>}
                <label className="flex col small">What to do with the picture
                  <textarea className="input" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Instruction" />
                </label>
                <div className="flex gap8 mt4" style={{ alignItems: 'center' }}>
                  <button className="btn xs ghost" onClick={() => setPrompt(opts.defaultPrompt)}>Use the standard instruction</button>
                  <span className="small muted">Standard: translate the words (not the product) to English, same style.</span>
                </div>
                <div className="small muted mt8">Your choices are remembered for the next picture.</div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Delete one or several drafts. A draft that is also an Etsy draft can be taken off the desk only, or deleted on Etsy too. */
export function DeleteDraftsModal({ drafts, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const [alsoOnEtsy, setAlsoOnEtsy] = useState(false);
  const real = drafts.filter((d) => !d.isLocalOnly);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post('/drafts/delete', { ids: drafts.map((d) => d.listingId), alsoOnEtsy });
      const bad = r.results.filter((x) => !x.ok);
      toast({ kind: bad.length ? 'warn' : 'ok', title: `${r.removed} draft${r.removed === 1 ? '' : 's'} deleted`, duration: bad.length ? 12000 : 5000,
        body: bad.length ? bad.map((b) => `${b.listingId}: ${b.error}`).join(' · ') : undefined });
      onDone();
    } catch (err) { showError(err, 'Could not delete'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title={`Delete ${drafts.length} draft${drafts.length === 1 ? '' : 's'}?`}
           footer={(
             <>
               <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
               <button className="btn danger" disabled={busy} onClick={go}>{busy ? <Spinner /> : 'Delete'}</button>
             </>
           )}>
      <ul style={{ margin: '0 0 12px 16px', maxHeight: 180, overflow: 'auto' }}>
        {drafts.map((d) => <li key={d.listingId}>{d.title || '(untitled)'} <span className="muted small">{d.isLocalOnly ? '· only on this machine' : `· ${d.etsyState || 'on Etsy'}`}</span></li>)}
      </ul>
      {real.length > 0 ? (
        <>
          <div className="small muted mb8">{real.length === 1 ? 'This one is' : `${real.length} of these are`} also a draft on Etsy.</div>
          <Checkbox checked={alsoOnEtsy} onChange={setAlsoOnEtsy} label="Delete it on Etsy too" />
          <div className="small muted mt4">
            {alsoOnEtsy
              ? 'It is removed from Etsy for good. Only listings Etsy still has as drafts are deleted there; anything else is left alone.'
              : 'Only taken off this desk. Etsy keeps it, and "Get drafts from Etsy" would bring it back.'}
          </div>
        </>
      ) : <div className="small muted">These exist only on this machine - their photos go with them. Nothing on Etsy is touched.</div>}
    </Modal>
  );
}

/** "+ By URL": one link per line, each downloaded and kept here. */
export function AddByUrlModal({ kind, listingId, room, onClose, onDone }) {
  const showError = useErrorToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const urls = text.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const go = async () => {
    setBusy(true);
    const out = [];
    for (const url of urls.slice(0, room)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.post(`/drafts/${listingId}/media`, { kind, url });
        out.push({ url, ok: true });
      } catch (err) { out.push({ url, ok: false, error: err.message }); }
      setResults([...out]);
    }
    setBusy(false);
    await onDone();
    if (out.every((r) => r.ok)) onClose();
    else showError(new Error(out.filter((r) => !r.ok).map((r) => r.error).join(' · ')), 'Some links did not work');
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title={kind === 'image' ? 'Add pictures by link' : 'Add a video by link'}
           footer={(
             <>
               <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={busy || !urls.length} onClick={go}>{busy ? <Spinner /> : '＋'} Add {urls.length > 1 ? `${Math.min(urls.length, room)} pictures` : kind}</button>
             </>
           )}>
      <textarea className="input mono" rows={5} autoFocus value={text} placeholder={kind === 'image' ? 'https://… (one link per line)' : 'https://…'}
                aria-label={kind === 'image' ? 'Picture links' : 'Video link'} onChange={(e) => setText(e.target.value)} />
      <div className="small muted mt8">
        {kind === 'image'
          ? 'Each picture is copied to this app and kept under this site\'s own address - it carries on from here whatever happens to the original link, and it is this copy that goes to Etsy. JPG, PNG or GIF.'
          : 'A video stays a link until the draft is sent.'}
      </div>
      {results.map((r) => <div key={r.url} className="small" style={{ color: r.ok ? 'var(--good)' : 'var(--bad)' }}>{r.ok ? '✓' : '✕'} {r.url.slice(0, 70)}{r.error ? ` - ${r.error}` : ''}</div>)}
    </Modal>
  );
}
