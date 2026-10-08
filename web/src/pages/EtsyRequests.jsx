import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Banner, Spinner, Checkbox, useToast, useErrorToast } from '../components/ui.jsx';
import EtsyRequestCard, { useRunRequest } from '../components/EtsyRequestCard.jsx';

const EVERY = [5, 10, 15, 30, 60, 120, 360, 720, 1440];
const everyLabel = (m) => (m >= 60 ? `${m / 60} h` : `${m} min`);

/**
 * Everything this app can ask Etsy for, in one place. Nothing is sent unless you press it (or switched it to repeat
 * here). Star the ones you want on the dashboard.
 */
export default function EtsyRequests() {
  const toast = useToast();
  const showError = useErrorToast();
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    try { const d = await api.get('/etsy-requests'); setData(d); } catch (err) { showError(err, 'Could not load the Etsy requests'); }
  }, [showError]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const { run, running } = useRunRequest(load);

  const star = async (req) => {
    try { await api.put(`/etsy-requests/${req.id}/star`, { on: !req.starred }); load(); } catch (err) { showError(err, 'Could not change the star'); }
  };
  const setAuto = async (req, patch) => {
    try { await api.put(`/etsy-requests/${req.id}/auto`, { enabled: req.auto.enabled, minutes: req.auto.minutes, ...patch }); load(); } catch (err) { showError(err, 'Could not change the schedule'); }
  };
  const applyRecommended = async () => {
    if (!window.confirm('Star the recommended requests and switch the recommended ones to repeat by themselves (with the suggested interval)? Everything else stays as it is.')) return;
    try { await api.post('/etsy-requests/recommended', { stars: true, auto: true }); toast({ kind: 'ok', title: 'Recommended setup applied' }); load(); } catch (err) { showError(err, 'Could not apply the recommendation'); }
  };

  if (!data) return <Page title="Etsy requests"><div className="flex"><Spinner /> <span className="dim">Loading…</span></div></Page>;
  const { usage, requests } = data;
  const pct = usage.known && usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const groups = [...new Set(requests.map((r) => r.group))];
  const autoOn = requests.filter((r) => r.auto.enabled).length;

  return (
    <Page title="Etsy requests" subtitle="Nothing is sent to Etsy unless you press it here (or switch it to repeat)">
      {usage.cooldownUntil && (
        <Banner kind="warn">Etsy is not taking requests from this app right now. It opens again around {new Date(usage.cooldownUntil).toISOString().slice(11, 16)} UTC.</Banner>
      )}
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="flex" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px' }}>
            {usage.known ? (
              <>
                <div><strong>{usage.remaining.toLocaleString()}</strong> of <strong>{usage.limit.toLocaleString()}</strong> requests left today <span className="muted small">- as Etsy reports it{usage.asOf ? `, ${new Date(usage.asOf).toISOString().slice(11, 16)} UTC` : ''}</span></div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', marginTop: 6, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: pct > 85 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--good)' }} />
                </div>
              </>
            ) : (
              <div>Etsy has not told this app its allowance yet{usage.limit ? ` (${usage.limit.toLocaleString()} a day)` : ''}. The first request of any kind shows it here - or press <em>Check the connection and my allowance</em> below (one request).</div>
            )}
            <div className="small muted" style={{ marginTop: 4 }}>This app has sent {usage.today.toLocaleString()} request{usage.today === 1 ? '' : 's'} to Etsy today (UTC).</div>
          </div>
          <button className="btn" onClick={applyRecommended}>★ Use the recommended setup</button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          The daily allowance is Etsy&rsquo;s own number, read from Etsy&rsquo;s answers - nothing here is typed in. Repeating requests stop by themselves when only about a tenth of it is left,
          so your own clicks always have room.
          {' '}{autoOn ? `${autoOn} request${autoOn === 1 ? ' is' : 's are'} set to repeat by themselves.` : 'Nothing repeats by itself.'}
        </div>
      </div>

      {groups.map((g) => (
        <div key={g}>
          <div className="section-title">{g}</div>
          <div className="flex col" style={{ gap: 10 }}>
            {requests.filter((r) => r.group === g).map((r) => (
              <div key={r.id} className="flex" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
                <div style={{ flex: '2 1 380px', minWidth: 0 }}>
                  <EtsyRequestCard req={r} run={run} running={running} onStar={star} />
                  <div className="small muted" style={{ marginTop: 4 }}>{r.note}</div>
                  {r.recommend && (r.recommend.star || r.recommend.auto) && (
                    <div className="small" style={{ marginTop: 4, color: 'var(--good)' }} data-testid={`rec-${r.id}`}>
                      {r.recommend.star ? '★ Recommended for the dashboard' : ''}{r.recommend.star && r.recommend.auto ? ' · ' : ''}
                      {r.recommend.auto ? `↻ Recommended to keep on (every ${everyLabel(r.recommend.minutes ?? r.auto.minutes)})` : ''}
                      <span className="muted"> - {r.recommend.why}</span>
                    </div>
                  )}
                  {r.recommend && !r.recommend.star && !r.recommend.auto && <div className="small muted" style={{ marginTop: 4 }}>Not recommended to repeat: {r.recommend.why}</div>}
                </div>
                <div className="card" style={{ flex: '1 1 230px', padding: 12 }}>
                  <Checkbox checked={r.auto.enabled} onChange={(v) => setAuto(r, { enabled: v })} label="Keep sending it by itself" />
                  <label className="flex col small" style={{ marginTop: 6 }}>How often
                    <select className="input" value={r.auto.minutes} aria-label={`How often: ${r.label}`} onChange={(e) => setAuto(r, { minutes: Number(e.target.value) })}>
                      {EVERY.filter((m) => m >= r.minMinutes || m === r.auto.minutes).map((m) => <option key={m} value={m}>every {everyLabel(m)}</option>)}
                    </select>
                  </label>
                  <div className="small muted" style={{ marginTop: 6 }}>
                    {r.auto.enabled ? `About ${Math.max(1, Math.round((1440 / r.auto.minutes)))} run${Math.round(1440 / r.auto.minutes) === 1 ? '' : 's'} a day.` : 'Off - only when you press Send.'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Page>
  );
}
