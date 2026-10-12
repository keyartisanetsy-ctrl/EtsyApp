import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Spinner, useAsync, useToast, useErrorToast, fmtAgo, fmtDateTime } from './ui.jsx';

const MODES = [
  ['off', 'Off', 'Only when you press a button.'],
  ['preview', 'Preview', 'Looks every few minutes and shows what it would write. Writes nothing.'],
  ['on', 'On', 'Writes tracking numbers and finished statuses into Airtable by itself.'],
];
const EVERY = [10, 15, 30, 60, 120, 240];

const ago = (iso) => (iso ? fmtAgo(iso) : 'never');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The cells of one order, in plain words. */
function Lines({ run }) {
  const d = run?.detail ?? {};
  const rows = [
    ...(d.fills ?? []).map((f) => ({ key: `f-${f.table}-${f.key}`, order: f.key, text: `tracking ${f.tracking} into "${f.field}"${f.old ? ` (was "${f.old}")` : ''}`, done: f.done })),
    ...(d.moves ?? []).map((m) => ({ key: `m-${m.table}-${m.key}`, order: m.key, text: `status ${m.from || '(empty)'} → ${m.to}`, why: m.why, done: m.done })),
  ];
  if (!rows.length) return null;
  return (
    <div className="small" data-testid="autopilot-lines">
      <strong>{run.mode === 'on' ? 'Written into Airtable' : 'Would be written into Airtable'}</strong>
      <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
        {rows.slice(0, 40).map((r) => (
          <li key={r.key}>
            <code>{r.order}</code> {r.text}{r.why ? <span className="muted"> - {r.why}</span> : null}
            {run.mode === 'on' && !r.done && <span className="badge amber" style={{ marginLeft: 6 }}>waits for the next look</span>}
          </li>
        ))}
      </ul>
      {rows.length > 40 && <div className="muted">… and {rows.length - 40} more</div>}
    </div>
  );
}

/**
 * Keeps Airtable in step with the shops by itself: shows the mode, what the last look found, what is waiting to be written,
 * the orders Airtable has no row for, and every run with a one-click undo. Preview (the default) never writes.
 */
export default function AirtableAutopilot({ onChanged }) {
  const toast = useToast();
  const showError = useErrorToast();
  const { data, reload } = useAsync(() => api.get('/airtable/auto'), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [cap, setCap] = useState(null);

  // the schedule runs without this page: look again every minute so the card never goes stale
  useEffect(() => {
    const t = setInterval(() => { reload(); }, 60_000);
    return () => clearInterval(t);
  }, [reload]);
  useEffect(() => { if (data && cap == null) setCap(data.cap); }, [data, cap]);

  if (!data) return null;
  const last = data.last;
  const d = last?.detail ?? {};
  const pending = last && last.mode === 'preview' ? last.planned : 0;
  const missing = (d.missing ?? []).filter((m) => !m.added);
  const missingNew = missing.filter((m) => !m.old);

  const call = async (label, fn, done) => {
    setBusy(label);
    try { const r = await fn(); await reload(); done?.(r); } catch (err) { showError(err, 'Airtable autopilot'); } finally { setBusy(''); }
  };
  const change = (patch) => call('config', () => api.put('/airtable/auto', patch));
  const look = (write) => call(write ? 'write' : 'look', () => api.post('/airtable/auto/run', { write }), (r) => {
    const run = r?.run;
    if (run?.busy) { toast({ kind: 'info', title: 'A look is already running' }); return; }
    if (!run?.ok && run?.error) { toast({ kind: 'err', title: 'Could not look at Airtable', body: run.error }); return; }
    if (write) {
      toast({ kind: run.wrote ? 'ok' : 'info', title: run.wrote ? `${plural(run.wrote, 'cell')} written into Airtable` : 'Airtable already agrees', body: run.capped ? 'The per-run limit stopped some - they follow on the next look.' : undefined });
      if (run.wrote) onChanged?.();
    } else {
      toast({ kind: 'info', title: run.planned ? `${plural(run.planned, 'cell')} would be written` : 'Airtable already agrees', body: run.missing ? `${plural(run.missing, 'order')} ha${run.missing === 1 ? 's' : 've'} no row in Airtable.` : undefined });
    }
  });
  const undo = (run) => {
    if (!window.confirm(`Put back the ${plural(run.wrote, 'cell')} this run wrote in Airtable? Cells somebody changed since are left alone.`)) return;
    call(`undo-${run.id}`, () => api.post(`/airtable/auto/undo/${run.id}`), (r) => {
      toast({ kind: 'ok', title: `${plural(r.reverted ?? 0, 'cell')} put back`, body: r.changedSince ? `${plural(r.changedSince, 'cell')} changed in Airtable since and were left alone.` : undefined });
      onChanged?.();
    });
  };
  const addMissing = () => call('add', () => api.post('/airtable/auto/add-missing', {}), (r) => {
    toast({ kind: r.added ? 'ok' : 'info', title: r.added ? `${plural(r.added, 'order')} added to Airtable` : 'Nothing to add',
      body: r.skippedOld ? `${plural(r.skippedOld, 'order')} older than 3 weeks were not added.` : undefined });
    if (r.added) onChanged?.();
  });

  const headline = data.mode === 'off' ? 'Off'
    : !last ? (data.mode === 'on' ? 'On - first look soon' : 'Preview - first look soon')
      : !last.ok && last.error ? `Problem: ${last.error}`
        : last.mode === 'on' ? `Looked ${ago(last.at)} - wrote ${last.wrote}${last.capped ? ' (limit reached)' : ''}`
          : `Looked ${ago(last.at)} - ${last.planned ? `${plural(last.planned, 'cell')} to write` : 'Airtable agrees'}`;
  const attention = (!last?.ok && last?.error) || (data.mode !== 'on' && pending > 0) || missingNew.length > 0;

  return (
    <div className="card mb12" data-testid="airtable-autopilot">
      <div className="card-head" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <h3>Airtable autopilot {open ? '▴' : '▾'}</h3>
        <span className={`badge ${data.mode === 'on' ? 'green' : data.mode === 'preview' ? 'blue' : 'grey'}`} data-testid="autopilot-mode">{data.mode === 'on' ? 'On' : data.mode === 'preview' ? 'Preview' : 'Off'}</span>
        <div className="spacer" />
        <span className="small" style={{ color: attention ? 'var(--warn, #b45309)' : undefined }} data-testid="autopilot-headline">
          {headline}{missingNew.length ? ` · ${plural(missingNew.length, 'order')} not in Airtable` : ''}
        </span>
      </div>

      {!open && data.mode === 'preview' && pending > 0 && (
        <div className="small muted" style={{ marginTop: 4 }}>
          It is only previewing. Open this card and switch it On to let it write these into Airtable.
        </div>
      )}

      {open && (
        <div className="flex col" style={{ gap: 12 }}>
          <div className="small muted">
            Keeps Airtable in step with the shops: a tracking number the app or the shop already has is written into the order's empty tracking cell,
            and a finished order's status moves to its OK twin so it leaves the "not sent" list. It reads Airtable only - nothing is asked of Etsy
            and nothing is ever sent to a buyer.
          </div>

          <div className="flex gap8" style={{ flexWrap: 'wrap' }} role="group" aria-label="Autopilot mode">
            {MODES.map(([id, label, text]) => (
              <button key={id} className={`btn ${data.mode === id ? 'primary' : ''}`} disabled={!!busy} title={text} data-testid={`autopilot-mode-${id}`}
                      onClick={() => (id === 'on' && data.mode !== 'on'
                        ? (window.confirm('Let the autopilot write into Airtable by itself? It only fills empty tracking cells and moves finished orders to their OK status, writes at most ' + data.cap + ' cells per look, and every run can be undone.') && change({ mode: id }))
                        : change({ mode: id }))}>
                {label}
              </button>
            ))}
          </div>
          <div className="small muted">{MODES.find(([id]) => id === data.mode)?.[2]}</div>

          <div className="flex gap12" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="flex col small">Look every
              <select className="select" value={data.minutes} disabled={!!busy || data.mode === 'off'} onChange={(e) => change({ minutes: Number(e.target.value) })}>
                {[...new Set([...EVERY, data.minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
              </select>
            </label>
            <label className="flex col small">Most cells per look
              <input className="input" type="number" min="1" max="500" style={{ width: 90 }} value={cap ?? data.cap} disabled={!!busy}
                     onChange={(e) => setCap(e.target.value)} onBlur={() => { if (Number(cap) !== data.cap && Number(cap) > 0) change({ cap: Number(cap) }); }} />
            </label>
            <label className="flex gap4 small" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={data.addMissing} disabled={!!busy} onChange={(e) => change({ addMissing: e.target.checked })} />
              Also add orders Airtable has no row for (when On)
            </label>
            <div style={{ flex: 1 }} />
            <button className="btn" disabled={!!busy} onClick={() => look(false)} data-testid="autopilot-look">{busy === 'look' ? <Spinner /> : '👁'} Look now</button>
            <button className="btn" disabled={!!busy} data-testid="autopilot-write"
                    onClick={() => { if (window.confirm('Write what is missing into Airtable now?')) look(true); }}>
              {busy === 'write' ? <Spinner /> : '✎'} Look and write now
            </button>
          </div>
          <div className="small muted">
            {data.mode === 'off' ? 'Not looking by itself.' : `Next look ${data.nextAt ? fmtDateTime(data.nextAt) : 'soon'}.`}
            {' '}Last look {ago(last?.at)}{last ? ` · read ${last.checked} Airtable rows` : ''}.
          </div>

          {last && !last.ok && last.error && <div className="small" style={{ color: 'var(--bad, #b91c1c)' }}>{last.error}</div>}
          {d.errors?.length > 0 && <div className="small" style={{ color: 'var(--warn, #b45309)' }}>{d.errors.join(' · ')}</div>}

          <Lines run={last} />

          {(d.blocked?.length ?? 0) > 0 && (
            <div className="small" data-testid="autopilot-blocked">
              <strong>Left alone ({d.blocked.length})</strong> <span className="muted">- somebody typed in the cell, so it needs a human</span>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{d.blocked.slice(0, 10).map((b) => <li key={`${b.table}-${b.key}`}><code>{b.key}</code> {b.text}</li>)}</ul>
            </div>
          )}

          {missing.length > 0 && (
            <div className="small" data-testid="autopilot-missing">
              <div className="flex gap8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{plural(missing.length, 'order')} the app has but Airtable has no row for</strong>
                <button className="btn xs" disabled={!!busy || !missingNew.length} onClick={addMissing}
                        title="Adds them through each shop's Airtable setup. Orders older than 3 weeks are never added.">
                  {busy === 'add' ? <Spinner /> : '＋'} Add {missingNew.length || ''} to Airtable
                </button>
              </div>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {missing.slice(0, 10).map((m) => <li key={`${m.channel}-${m.orderId}`}><code>{m.ref}</code> {m.buyer}{m.old ? <span className="muted"> - older than 3 weeks, not added by itself</span> : null}</li>)}
              </ul>
            </div>
          )}

          {data.runs?.length > 0 && (
            <div className="small">
              <strong>Recent looks</strong>
              <table className="table" style={{ marginTop: 4 }}>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id} data-testid="autopilot-run">
                      <td className="dim">{fmtAgo(r.at)}</td>
                      <td>{r.trigger === 'schedule' ? 'automatic' : 'by hand'} · {r.mode === 'on' ? 'wrote' : 'preview'}</td>
                      <td>{r.ok ? `${r.wrote} written · ${r.planned} found${r.added ? ` · ${r.added} added` : ''}${r.capped ? ' · limit reached' : ''}` : <span style={{ color: 'var(--bad, #b91c1c)' }}>{r.error || 'failed'}</span>}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.wrote > 0 && r.undoable && <button className="btn xs" disabled={!!busy} onClick={() => undo(r)}>{busy === `undo-${r.id}` ? <Spinner /> : '↶'} Undo</button>}
                        {r.wrote > 0 && r.undone && <span className="muted">undone</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
