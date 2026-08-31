import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Pager, Drawer, CopyButton, Stat,
  useAsync, useDebounced, useToast, useErrorToast, fmtDateTime, fmtAgo, TRACK_BADGE,
} from '../components/ui.jsx';

const LIMIT = 100;

/**
 * The tracking board. Every parcel deep-links to YunTrack, and anything that
 * has not moved within the configured window is raised as an alert.
 */
export default function Tracking() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [status, setStatus] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(params.get('alertsOnly') === 'true');
  const [offset, setOffset] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState(new Set());

  const toast = useToast();
  const showError = useErrorToast();

  const query = useMemo(() => ({ search: debounced, status, alertsOnly: alertsOnly || undefined, limit: LIMIT, offset }),
    [debounced, status, alertsOnly, offset]);

  const { data, loading, error, reload } = useAsync(() => api.get('/tracking', query), [query]);
  const { data: summary, reload: reloadSummary } = useAsync(() => api.get('/tracking/summary'), []);
  const { data: statuses } = useAsync(() => api.get('/tracking/statuses'), []);

  const rows = data?.rows ?? [];
  const refreshAll = () => { reload(); reloadSummary(); };

  const sync = async (codes) => {
    setSyncing(true);
    try {
      const r = await api.post('/tracking/sync', codes ? { codes } : {});
      if (r.errors?.length) {
        toast({
          kind: 'warn',
          title: `Checked ${r.checked}, ${r.errors.length} unreachable`,
          body: r.errors[0]?.error?.slice(0, 180),
          duration: 10000,
        });
      } else {
        toast({ kind: 'ok', title: `Checked ${r.checked} parcel(s)` });
      }
      refreshAll();
    } catch (err) { showError(err, 'Tracking sync failed'); } finally { setSyncing(false); }
  };

  const ack = async (code) => {
    try { await api.post(`/tracking/${encodeURIComponent(code)}/acknowledge`, { ack: true }); refreshAll(); }
    catch (err) { showError(err); }
  };

  const exportXlsx = async () => {
    try {
      const r = await api.post('/exports/tracking', {});
      window.location.href = `/api/exports/download/${encodeURIComponent(r.filename)}`;
    } catch (err) { showError(err, 'Export failed'); }
  };

  const toggle = (code) => setSelected((s) => {
    const next = new Set(s);
    next.has(code) ? next.delete(code) : next.add(code);
    return next;
  });

  return (
    <TablePage
      title="Tracking"
      subtitle={summary ? `${summary.total} parcels · alert after ${summary.staleDays} days without movement` : ''}
      actions={
        <>
          <button className="btn sm" onClick={exportXlsx}>⤓ Excel</button>
          <button className="btn sm" onClick={() => api.post('/tracking/refresh-alerts', {}).then(refreshAll)}>Recheck alerts</button>
          <button className="btn sm primary" disabled={syncing} onClick={() => sync(null)}>
            {syncing ? <Spinner /> : '➤'} Sync carriers
          </button>
        </>
      }
      toolbar={
        <>
          <input className="input search" placeholder="Search tracking number, order or buyer…"
                 value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
          <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">All statuses</option>
            {Object.entries(statuses?.labels ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Checkbox checked={alertsOnly} onChange={(v) => { setAlertsOnly(v); setOffset(0); }} label="Alerts only" />
          <div className="spacer" />
          {selected.size > 0 && (
            <button className="btn sm" onClick={() => sync([...selected])}>Sync {selected.size} selected</button>
          )}
        </>
      }
      pager={<Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />}
    >
      <div style={{ padding: 16, paddingBottom: 0 }}>
        {error && <Banner kind="err">{error.message}</Banner>}
        {summary && (
          <div className="grid c5 mb16">
            <Stat label="Tracked" value={summary.total} />
            <Stat label="Alerts" value={summary.alerts} kind={summary.alerts ? 'alert' : 'good'}
                  note={`${summary.staleDays}+ days idle, or an exception`} />
            <Stat label="On its way" value={summary.byStatus.in_transit ?? 0} />
            <Stat label="Delivered" value={summary.byStatus.delivered ?? 0} kind="good" />
            <Stat label="Pre-shipped" value={summary.byStatus.pre_shipped ?? 0} note="No carrier scan yet" />
          </div>
        )}
      </div>

      {loading && !data ? <div className="empty"><Spinner /></div>
        : rows.length === 0 ? (
          <Empty icon="➤" title="No parcels here">
            Add tracking numbers from the Orders screen. Every number here links straight to YunTrack.
          </Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th className="col-tight" />
                <th>Tracking</th>
                <th>Order</th>
                <th>Buyer</th>
                <th>Status</th>
                <th>Last scan</th>
                <th className="right">Idle</th>
                <th>Alert</th>
                <th className="col-tight" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.trackingCode} className={t.alert ? 'alert-row' : ''}>
                  <td><Checkbox checked={selected.has(t.trackingCode)} onChange={() => toggle(t.trackingCode)} /></td>
                  <td>
                    <div className="flex gap4">
                      <a className="mono small" href={t.trackingUrl} target="_blank" rel="noreferrer" title="Open on YunTrack">
                        {t.trackingCode}
                      </a>
                      <CopyButton text={t.trackingCode} label="⧉" className="btn xs ghost" />
                    </div>
                    {t.carrier && <div className="small muted">{t.carrier}</div>}
                  </td>
                  <td className="mono small">{t.receiptId ? `#${t.receiptId}` : '—'}</td>
                  <td className="small">
                    {t.buyerName || '—'}
                    {t.country && <span className="muted"> · {t.country}</span>}
                  </td>
                  <td><span className={`badge ${TRACK_BADGE[t.status] ?? 'grey'}`}>{t.statusLabel}</span></td>
                  <td className="small cell-wrap" style={{ maxWidth: 280 }}>
                    {t.lastEventText || <span className="muted">no scan recorded</span>}
                    {t.lastEventAt && <div className="small muted">{fmtDateTime(t.lastEventAt)}</div>}
                  </td>
                  <td className="num">
                    <span className={t.isStale ? 'badge red' : 'small dim'}>{t.daysSinceMove ?? '—'}d</span>
                  </td>
                  <td className="small">
                    {t.alert
                      ? <span style={{ color: 'var(--bad)' }}>{t.alertReason}</span>
                      : t.alertAck ? <span className="muted">acknowledged</span> : <span className="muted">—</span>}
                  </td>
                  <td>
                    <div className="flex gap4">
                      {t.alert && <button className="btn xs" onClick={() => ack(t.trackingCode)}>Ack</button>}
                      <button className="btn xs" onClick={() => setDetail(t.trackingCode)}>Open</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <ParcelDetail code={detail} onClose={() => setDetail(null)} onChanged={refreshAll} statuses={statuses} />
    </TablePage>
  );
}

function ParcelDetail({ code, onClose, onChanged, statuses }) {
  const { data, loading, reload } = useAsync(() => (code ? api.get(`/tracking/${encodeURIComponent(code)}`) : null), [code], { immediate: !!code });
  const [manual, setManual] = useState('');
  const [note, setNote] = useState('');
  const toast = useToast();
  const showError = useErrorToast();

  if (!code) return null;

  const setStatus = async () => {
    try {
      await api.post(`/tracking/${encodeURIComponent(code)}/status`, { status: manual, note });
      toast({ kind: 'ok', title: 'Status set manually' });
      reload();
      onChanged();
    } catch (err) { showError(err); }
  };

  const syncOne = async () => {
    try {
      const r = await api.post('/tracking/sync', { codes: [code] });
      if (r.errors?.length) toast({ kind: 'warn', title: 'Carrier unreachable', body: r.errors[0].error, duration: 9000 });
      else toast({ kind: 'ok', title: 'Refreshed' });
      reload();
      onChanged();
    } catch (err) { showError(err); }
  };

  return (
    <Drawer open onClose={onClose} title={code}
            footer={<><button className="btn" onClick={syncOne}>↻ Check carrier</button>
                      <div className="spacer" />
                      {data && <a className="btn primary" href={data.trackingUrl} target="_blank" rel="noreferrer">Open on YunTrack ↗</a>}</>}>
      {loading || !data ? <Spinner /> : (
        <>
          <div className="flex mb16">
            <span className={`badge ${TRACK_BADGE[data.status] ?? 'grey'}`}>{data.statusLabel}</span>
            {data.isStale && <span className="badge red">{data.alertReason}</span>}
            <div className="spacer" />
            <CopyButton text={data.trackingUrl} label="Copy link" className="btn xs" />
          </div>

          {data.checkError && (
            <Banner kind="warn">
              Last carrier check failed: {data.checkError}
              <div className="small mt8">
                The parcel keeps its last known state. You can still open the link above, or set the status by hand below.
              </div>
            </Banner>
          )}

          <dl className="kv mb16">
            <dt>Order</dt><dd>{data.receiptId ? `#${data.receiptId}` : '—'}</dd>
            <dt>Buyer</dt><dd>{data.buyerName || '—'}</dd>
            <dt>Carrier</dt><dd>{data.carrier || '—'}</dd>
            <dt>Provider</dt><dd>{data.provider}</dd>
            <dt>Days idle</dt><dd>{data.daysSinceMove ?? '—'}</dd>
            <dt>Last checked</dt><dd>{fmtAgo(data.lastCheckedAt)}</dd>
            <dt>Scans recorded</dt><dd>{data.eventCount}</dd>
          </dl>

          <div className="section-title">Set status manually</div>
          <div className="flex mb16">
            <select className="select" value={manual} onChange={(e) => setManual(e.target.value)}>
              <option value="">Choose a status…</option>
              {Object.entries(statuses?.labels ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="input" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" disabled={!manual} onClick={setStatus}>Set</button>
          </div>

          <div className="section-title">Scan history</div>
          {data.events?.length ? (
            <div className="timeline">
              {data.events.map((e, i) => (
                <div key={i} className={`timeline-item ${i === 0 ? 'first' : ''}`}>
                  <div className="when">{fmtDateTime(e.event_at)}</div>
                  <div className="what">{e.description}</div>
                  {e.location && <div className="where">{e.location}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="dim small">
              No scans recorded yet. Either the carrier has not picked it up, or the carrier feed could not be reached.
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
