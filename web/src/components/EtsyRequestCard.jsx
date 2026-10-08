import React, { useState } from 'react';
import api from '../lib/api.js';
import { Spinner, useToast, useErrorToast, fmtAgo } from './ui.jsx';

/** Run one Etsy request for every shop and say how it went. Shared by the dashboard and the Etsy requests page. */
export function useRunRequest(onDone) {
  const toast = useToast();
  const showError = useErrorToast();
  const [running, setRunning] = useState('');
  const run = async (req) => {
    if (req.heavy && !window.confirm(`"${req.label}" is a big one (${req.cost} of Etsy's daily requests). Send it?`)) return;
    setRunning(req.id);
    try {
      const r = await api.post(`/etsy-requests/${req.id}/run`, {});
      const failed = r.shops.filter((s) => !s.ok);
      toast({
        kind: failed.length ? 'warn' : 'ok', duration: failed.length ? 15000 : 6000,
        title: `${req.label}: ${failed.length ? `${r.shops.length - failed.length} of ${r.shops.length} shops` : 'done'} · ${r.calls} request${r.calls === 1 ? '' : 's'} used`,
        body: r.shops.map((s) => `${s.shopName}: ${s.ok ? s.summary : s.error}`).join('\n'),
      });
      onDone?.(r);
    } catch (err) { showError(err, `${req.label} did not run`); } finally { setRunning(''); }
  };
  return { run, running };
}

const lastLine = (last) => {
  if (!last) return 'Never sent yet.';
  const when = fmtAgo(last.at);
  return `${last.ok ? '✓' : '⚠'} ${when} · ${last.calls ?? 0} request${last.calls === 1 ? '' : 's'} · ${last.source === 'schedule' ? 'by schedule' : 'by you'}`;
};

/** One request as a card: star, name, last result, and the one-click run. */
export default function EtsyRequestCard({ req, run, running, onStar, busyAll }) {
  const bad = req.last && !req.last.ok;
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }} data-testid={`req-${req.id}`}>
      <div className="flex" style={{ alignItems: 'flex-start', gap: 8 }}>
        <button className="btn xs ghost" aria-label={req.starred ? `Unstar ${req.label}` : `Star ${req.label}`} aria-pressed={req.starred}
                title={req.starred ? 'On the dashboard - click to remove' : 'Put on the dashboard'} onClick={() => onStar(req)}
                style={{ fontSize: 16, lineHeight: 1, color: req.starred ? 'var(--warn, #e8b100)' : undefined }}>{req.starred ? '★' : '☆'}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div><strong>{req.label}</strong></div>
          <div className="small muted">{req.cost} request{req.cost === '1 per shop' ? '' : 's'}, every shop{req.heavy ? ' · big' : ''}</div>
        </div>
        <button className="btn sm primary" disabled={!!running || busyAll} onClick={() => run(req)}>
          {running === req.id ? <Spinner /> : '↻'} Send
        </button>
      </div>
      <div className="small" style={{ marginTop: 6, color: bad ? 'var(--warn)' : undefined }} title={req.last?.summary}>
        {lastLine(req.last)}
      </div>
      {req.last?.summary && <div className="small muted" style={{ marginTop: 2, whiteSpace: 'pre-wrap', maxHeight: 64, overflow: 'hidden' }}>{req.last.summary}</div>}
      {req.auto?.enabled && <div className="small" style={{ marginTop: 4, color: 'var(--good)' }}>↻ repeats every {req.auto.minutes >= 60 ? `${req.auto.minutes / 60} h` : `${req.auto.minutes} min`}</div>}
    </div>
  );
}
