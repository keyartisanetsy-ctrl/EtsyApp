import React, { useMemo, useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Empty, Banner, CopyButton, useAsync, useDebounced, useErrorToast } from '../components/ui.jsx';

/** Every documented operation, callable and inspectable. */
export default function ApiExplorer() {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [tag, setTag] = useState('');
  const [picked, setPicked] = useState(null);
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const { data, loading } = useAsync(() => api.get('/etsy/operations', { search: debounced, tag }), [debounced, tag]);
  const { data: coverage } = useAsync(() => api.get('/etsy/coverage'), []);

  const ops = data?.operations ?? [];

  const select = (op) => {
    setPicked(op);
    setResult(null);
    const seed = {};
    for (const p of op.pathParams) seed[p] = '';
    for (const q of op.query.filter((x) => x.required)) seed[q.name] = '';
    setArgs(JSON.stringify(seed, null, 2));
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const parsed = JSON.parse(args || '{}');
      setResult(await api.post(`/etsy/call/${picked.operationId}`, { args: parsed }));
    } catch (err) {
      if (err instanceof SyntaxError) showError({ message: `Arguments are not valid JSON: ${err.message}` }, 'Bad input');
      else showError(err, 'Call failed');
    } finally { setBusy(false); }
  };

  return (
    <Page
      title="API explorer"
      subtitle={data ? `${data.matched} of ${data.count} operations` : ''}
      actions={coverage && <span className="badge grey">{coverage.everCalled}/{coverage.total} exercised</span>}
    >
      <Banner kind="info">
        Everything in the Etsy Open API v3 reference is here, generated from the official OpenAPI document.
        Calls go through the same authenticated, rate-limited client the rest of the app uses.
      </Banner>

      <div className="flex mb16">
        <input className="input search" placeholder="Search operationId, path or summary…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="select" style={{ width: 220 }} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {(data?.tags ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="split">
        <div className="card" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          {loading ? <Spinner /> : ops.length === 0 ? <Empty icon="⌘" title="Nothing matches" /> : (
            <table className="data">
              <thead><tr><th>Method</th><th>Operation</th><th>Auth</th></tr></thead>
              <tbody>
                {ops.map((op) => (
                  <tr key={op.operationId} onClick={() => select(op)}
                      className={picked?.operationId === op.operationId ? 'selected' : ''} style={{ cursor: 'pointer' }}>
                    <td>
                      <span className={`badge ${op.method === 'GET' ? 'blue' : op.method === 'DELETE' ? 'red' : 'amber'}`}>{op.method}</span>
                    </td>
                    <td>
                      <div className="small mono">{op.operationId}</div>
                      <div className="small muted">{op.path}</div>
                    </td>
                    <td className="small muted">{op.scopes.join(' ') || 'public'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          {!picked ? <Empty icon="⌘" title="Pick an operation">Its parameters and body schema appear here.</Empty> : (
            <>
              <div className="card-head">
                <h3 className="mono">{picked.operationId}</h3>
                <div className="spacer" />
                <span className={`badge ${picked.method === 'GET' ? 'blue' : 'amber'}`}>{picked.method}</span>
              </div>
              <div className="small muted mono mb8">{picked.path}</div>
              {picked.summary && <p className="small dim">{picked.summary}</p>}
              {picked.restricted && (
                <Banner kind="warn">Etsy gates this endpoint behind an application review — it may return 403 on a standard app.</Banner>
              )}

              {picked.pathParams.length > 0 && (
                <>
                  <div className="section-title">Path parameters</div>
                  <div className="pill-row">{picked.pathParams.map((p) => <span key={p} className="tag mono">{p}</span>)}</div>
                </>
              )}

              {picked.query.length > 0 && (
                <>
                  <div className="section-title">Query parameters</div>
                  <table className="data">
                    <tbody>
                      {picked.query.map((q) => (
                        <tr key={q.name}>
                          <td className="mono small">{q.name}{q.required && <span style={{ color: 'var(--bad)' }}>*</span>}</td>
                          <td className="small muted">{q.type}{q.enum ? ` — ${q.enum.join(' | ')}` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {picked.body && (
                <>
                  <div className="section-title">Body ({picked.body.kind})</div>
                  <table className="data">
                    <tbody>
                      {Object.entries(picked.body.props).map(([k, v]) => (
                        <tr key={k}>
                          <td className="mono small">{k}{picked.body.required?.includes(k) && <span style={{ color: 'var(--bad)' }}>*</span>}</td>
                          <td className="small muted">{v.type}{v.enum ? ` — ${v.enum.join(' | ')}` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <div className="section-title">Arguments (JSON)</div>
              <textarea className="textarea mono" rows={7} value={args} onChange={(e) => setArgs(e.target.value)} />
              <div className="hint mb8">
                shop_id is filled in automatically by the purpose-built screens, but here you supply it explicitly.
              </div>
              <button className="btn primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : '▶'} Send</button>

              {result && (
                <>
                  <div className="section-title">
                    Response <CopyButton text={JSON.stringify(result, null, 2)} label="Copy" className="btn xs" />
                  </div>
                  <div className="copy-block" style={{ maxHeight: 400 }}>{JSON.stringify(result, null, 2)}</div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
