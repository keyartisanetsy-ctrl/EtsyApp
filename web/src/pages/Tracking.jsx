import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Pager, Drawer, Modal, CopyButton, Stat,
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
  const [blocked, setBlocked] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);

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
      setBlocked(r.blocked ?? null);
      if (r.blocked) {
        toast({ kind: 'warn', title: 'Carrier lookup blocked', body: 'See the note above the board.', duration: 8000 });
      } else if (r.errors?.length) {
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

  /** Set the same status on every selected parcel, by hand. */
  const markSelected = async (newStatus) => {
    const codes = [...selected];
    if (!codes.length) return;
    const label = statuses?.labels?.[newStatus] ?? newStatus;
    if (!confirm(`Mark ${codes.length} parcel(s) as "${label}"?`)) return;
    try {
      const r = await api.post('/tracking/status', { codes, status: newStatus, note: `Set by hand to ${label}` });
      toast({ kind: 'ok', title: `${r.updated} parcel(s) marked ${label}` });
      setSelected(new Set());
      refreshAll();
    } catch (err) { showError(err, 'Could not set the status'); }
  };

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
          <span className="small muted">Tick the parcels you want to act on</span>
        </>
      }
      selection={selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected</span>
          <button className="btn xs" disabled={syncing} onClick={() => sync([...selected])}>
            {syncing ? <Spinner /> : 'Check these with the carrier'}
          </button>
          <button className="btn xs" onClick={() => markSelected('delivered')}>Mark delivered</button>
          <select className="select sm" value="" onChange={(e) => e.target.value && markSelected(e.target.value)}>
            <option value="">Set another status…</option>
            {Object.entries(statuses?.labels ?? {})
              .filter(([k]) => k !== 'delivered')
              .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn xs" onClick={() => setAiOpen(true)}>Ask AI where they are</button>
          <div className="spacer" />
          <button className="btn xs ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      pager={<Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />}
    >
      <div style={{ padding: 16, paddingBottom: 0 }}>
        {error && <Banner kind="err">{error.message}</Banner>}
        {blocked && (
          <Banner kind="warn" onClose={() => setBlocked(null)}>
            <div>
              {blocked}
              <div className="mt8 small">
                Parcels keep their last known status, every number still opens on YunTrack, and the
                no-movement alert keeps counting — it measures elapsed time, not carrier replies.
              </div>
            </div>
          </Banner>
        )}
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
                <th className="col-tight">
                  <Checkbox
                    checked={rows.length > 0 && rows.every((t) => selected.has(t.trackingCode))}
                    indeterminate={selected.size > 0 && !rows.every((t) => selected.has(t.trackingCode))}
                    onChange={() => setSelected(rows.every((t) => selected.has(t.trackingCode))
                      ? new Set()
                      : new Set(rows.map((t) => t.trackingCode)))} />
                </th>
                <th>Tracking</th>
                <th>Order</th>
                <th>Buyer</th>
                <th>Status</th>
                <th>Last scan</th>
                <th className="right">Shipping cost</th>
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
                  <td className="right">
                    <ShippingCostCell row={t} onSaved={reload} />
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

      <AiStatusModal
        open={aiOpen}
        codes={[...selected]}
        statuses={statuses}
        onClose={() => setAiOpen(false)}
        onApplied={() => { setAiOpen(false); setSelected(new Set()); refreshAll(); }}
      />
      <ParcelDetail code={detail} onClose={() => setDetail(null)} onChanged={refreshAll} statuses={statuses} />
    </TablePage>
  );
}

/**
 * The shipping cost of one parcel, typed straight into the row. It sits next
 * to the tracking number because that is where the courier's charge belongs,
 * and it is what the Airtable shipping-cost column is fed from.
 */
function ShippingCostCell({ row, onSaved }) {
  const showError = useErrorToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.shippingCost ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/tracking/${encodeURIComponent(row.trackingCode)}/cost`, {
        cost: value === '' ? null : Number(value),
        currency: row.shippingCostCurrency || undefined,
      });
      setEditing(false);
      onSaved?.();
    } catch (err) { showError(err, 'Could not save the shipping cost'); } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <button
        className="btn xs ghost"
        title="Click to set what this parcel cost you to send"
        onClick={() => { setValue(row.shippingCost ?? ''); setEditing(true); }}
      >
        {row.shippingCost === null || row.shippingCost === undefined
          ? <span className="muted">add</span>
          : <>{row.shippingCost} <span className="muted">{row.shippingCostCurrency || ''}</span></>}
      </button>
    );
  }

  return (
    <span className="flex gap4">
      <input
        className="input sm"
        style={{ width: 78 }}
        autoFocus
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button className="btn xs primary" onClick={save} disabled={busy}>✓</button>
      <button className="btn xs ghost" onClick={() => setEditing(false)}>✕</button>
    </span>
  );
}

/**
 * Let the AI read the tracking histories and say where the parcels really are.
 *
 * It reports first and writes nothing. You see what it thinks, how sure it is
 * and why, and then decide - because a parcel wrongly marked delivered stops
 * being chased, and that is the mistake here that costs money.
 */
function AiStatusModal({ open, codes, statuses, onClose, onApplied }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => { if (!open) setResult(null); }, [open]);

  const readThem = async (apply) => {
    setBusy(true);
    try {
      const r = await api.post('/tracking/ai-read', { codes, apply });
      setResult(r);
      if (apply) {
        toast({
          kind: 'ok',
          title: `${r.applied} parcel(s) updated`,
          body: r.applied < (r.parcels ?? []).filter((p) => p.changed).length
            ? 'The rest were left alone because the AI was not sure enough.'
            : undefined,
        });
        if (r.applied) onApplied();
      }
    } catch (err) { showError(err, 'Could not read the parcels'); }
    finally { setBusy(false); }
  };

  if (!open) return null;
  const changed = (result?.parcels ?? []).filter((p) => p.changed);

  return (
    <Modal open={open} onClose={onClose} lg
           title={`Read ${codes.length} parcel${codes.length === 1 ? '' : 's'} with AI`}
           footer={<>
             <div className="spacer" />
             {!result
               ? <button className="btn primary" onClick={() => readThem(false)} disabled={busy || !codes.length}>
                   {busy ? <Spinner /> : 'Read them'}
                 </button>
               : <button className="btn primary" onClick={() => readThem(true)} disabled={busy || !changed.length}>
                   {busy ? <Spinner /> : `Apply ${changed.length} change${changed.length === 1 ? '' : 's'}`}
                 </button>}
           </>}>
      {!result ? (
        <p className="dim">
          The AI reads each parcel&rsquo;s recent events — in whatever language the courier wrote them —
          and says which have arrived, which are stuck at customs and which are simply still moving.
          It reports first; nothing is written until you say so.
        </p>
      ) : (
        <>
          <Banner kind={changed.length ? 'info' : 'ok'}>
            {changed.length
              ? `${changed.length} parcel(s) look different from what the board says.`
              : 'The board already matches what the histories say. Nothing to change.'}
            {result.model ? ` Read by ${result.model}.` : ''}
          </Banner>
          <table className="data">
            <thead><tr><th>Tracking</th><th>Board says</th><th>AI says</th><th>Sure</th><th>Why</th></tr></thead>
            <tbody>
              {(result.parcels ?? []).map((p) => (
                <tr key={p.code}>
                  <td className="mono small">{p.code}</td>
                  <td className="small dim">{statuses?.labels?.[p.was] ?? p.was}</td>
                  <td className="small">
                    {p.changed
                      ? <strong>{statuses?.labels?.[p.status] ?? p.status}</strong>
                      : <span className="dim">no change</span>}
                  </td>
                  <td className="num small">
                    <span className={`badge ${p.confidence >= 0.7 ? 'green' : 'amber'}`}>
                      {Math.round((p.confidence ?? 0) * 100)}%
                    </span>
                  </td>
                  <td className="small cell-wrap" style={{ maxWidth: 320 }}>
                    {p.note}
                    {p.heldBack && <div className="small dim">Left alone: {p.heldBack}.</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small dim mt8">
            Anything under {Math.round((result.minConfidence ?? 0.7) * 100)}% confidence is reported but not written.
          </p>
        </>
      )}
    </Modal>
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
