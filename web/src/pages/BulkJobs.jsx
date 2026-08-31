import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Empty, Drawer, useAsync, useToast, useErrorToast, fmtAgo } from '../components/ui.jsx';

const BADGE = { completed: 'green', running: 'blue', queued: 'grey', failed: 'red', canceled: 'amber' };

export default function BulkJobs() {
  const [openId, setOpenId] = useState(null);
  const { data, loading, reload } = useAsync(() => api.get('/bulk/jobs', { limit: 50 }), []);
  const { data: actions } = useAsync(() => api.get('/bulk/actions'), []);

  // Poll while anything is still moving.
  React.useEffect(() => {
    if (!data?.some((j) => j.status === 'running' || j.status === 'queued')) return undefined;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [data, reload]);

  return (
    <Page title="Bulk jobs" subtitle={`${actions?.length ?? 0} action types available`}
          actions={<button className="btn sm" onClick={reload}>{loading ? <Spinner /> : '↻'} Refresh</button>}>
      {loading && !data ? <Spinner /> : !data?.length ? (
        <Empty icon="⚙" title="No bulk jobs yet">
          Select rows on the Listings, SKUs or Orders screens and choose a bulk action. Every run is recorded here
          with a per-item result you can retry.
        </Empty>
      ) : (
        <div className="card">
          <table className="data">
            <thead><tr><th>Job</th><th>Status</th><th>Progress</th><th className="right">OK</th><th className="right">Failed</th><th>Started</th><th /></tr></thead>
            <tbody>
              {data.map((j) => (
                <tr key={j.id}>
                  <td>
                    <div>{j.label}</div>
                    <div className="small muted mono">{j.type}{j.dryRun ? ' · dry run' : ''}</div>
                  </td>
                  <td><span className={`badge ${BADGE[j.status] ?? 'grey'}`}>{j.status}</span></td>
                  <td style={{ minWidth: 130 }}>
                    <div className={`progress ${j.failed ? 'bad' : j.status === 'completed' ? 'good' : ''}`}>
                      <span style={{ width: `${Math.round(((j.succeeded + j.failed) / Math.max(1, j.total)) * 100)}%` }} />
                    </div>
                    <div className="small muted">{j.succeeded + j.failed} / {j.total}</div>
                  </td>
                  <td className="num">{j.succeeded}</td>
                  <td className="num">{j.failed > 0 ? <span className="badge red">{j.failed}</span> : 0}</td>
                  <td className="small muted">{fmtAgo(j.created_at)}</td>
                  <td><button className="btn xs" onClick={() => setOpenId(j.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <JobDetail id={openId} onClose={() => setOpenId(null)} onChanged={reload} />
    </Page>
  );
}

function JobDetail({ id, onClose, onChanged }) {
  const { data, loading, reload } = useAsync(() => (id ? api.get(`/bulk/jobs/${id}`) : null), [id], { immediate: !!id });
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => {
    if (!data || (data.status !== 'running' && data.status !== 'queued')) return undefined;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [data, reload]);

  if (!id) return null;

  const retry = async () => {
    try {
      const job = await api.post(`/bulk/jobs/${id}/retry`, {});
      toast({ kind: 'ok', title: 'Retry started', body: `${job.total} item(s)` });
      onChanged();
      onClose();
    } catch (err) { showError(err, 'Could not retry'); }
  };

  const cancel = async () => {
    try { await api.post(`/bulk/jobs/${id}/cancel`, {}); reload(); onChanged(); }
    catch (err) { showError(err); }
  };

  return (
    <Drawer open onClose={onClose} wide title={data?.label ?? 'Job'}
            footer={data && (
              <>
                {data.failed > 0 && <button className="btn primary" onClick={retry}>Retry {data.failed} failed</button>}
                {(data.status === 'running' || data.status === 'queued') && <button className="btn danger" onClick={cancel}>Cancel</button>}
                <div className="spacer" />
                <span className="small muted mono">{data.id}</span>
              </>
            )}>
      {loading || !data ? <Spinner /> : (
        <>
          <dl className="kv mb16">
            <dt>Type</dt><dd className="mono">{data.type}</dd>
            <dt>Status</dt><dd><span className={`badge ${BADGE[data.status] ?? 'grey'}`}>{data.status}</span></dd>
            <dt>Targets</dt><dd>{data.total}</dd>
            <dt>Succeeded</dt><dd>{data.succeeded}</dd>
            <dt>Failed</dt><dd>{data.failed}</dd>
            <dt>Started</dt><dd>{fmtAgo(data.startedAt ?? data.createdAt)}</dd>
          </dl>

          {Object.keys(data.params ?? {}).length > 0 && (
            <>
              <div className="section-title">Parameters</div>
              <div className="copy-block mb16">{JSON.stringify(data.params, null, 2)}</div>
            </>
          )}

          <div className="section-title">Items</div>
          <table className="data">
            <thead><tr><th>#</th><th>Target</th><th>What</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.seq}>
                  <td className="small muted">{i.seq + 1}</td>
                  <td className="mono small">{i.target}</td>
                  <td className="small cell-wrap">{i.label}</td>
                  <td>
                    <span className={`badge ${i.status === 'ok' ? 'green' : i.status === 'error' ? 'red' : i.status === 'skipped' ? 'amber' : 'grey'}`}>
                      {i.status}
                    </span>
                  </td>
                  <td className="small cell-wrap">
                    {i.error
                      ? <span style={{ color: 'var(--bad)' }}>{i.error}</span>
                      : i.response ? <span className="muted">{JSON.stringify(i.response).slice(0, 90)}</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Drawer>
  );
}
