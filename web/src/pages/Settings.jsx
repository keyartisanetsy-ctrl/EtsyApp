import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Banner, Tabs, useAsync, useToast, useErrorToast, fmtAgo } from '../components/ui.jsx';

const GROUPS = [
  { id: 'etsy', label: 'Etsy connection', prefix: 'etsy.' },
  { id: 'ai', label: 'AI providers', prefix: 'ai.' },
  { id: 'tracking', label: 'Tracking', prefix: 'tracking.' },
  { id: 'pricing', label: 'Pricing & orders', prefix: ['pricing.', 'orders.'] },
];

export default function Settings() {
  const [tab, setTab] = useState('etsy');
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const { data, loading, reload } = useAsync(() => api.get('/settings'), []);
  const { data: auth, reload: reloadAuth } = useAsync(() => api.get('/auth/status'), []);
  const toast = useToast();
  const showError = useErrorToast();

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/settings', draft);
      toast({ kind: 'ok', title: 'Settings saved' });
      setDraft({});
      reload();
      reloadAuth();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.get('/auth/test'));
    } catch (err) { showError(err, 'Test failed'); } finally { setTesting(false); }
  };

  const connect = async () => {
    try {
      const r = await api.post('/auth/connect', {});
      window.open(r.url, '_blank', 'noopener');
      toast({ kind: 'ok', title: 'Etsy opened in a new tab', body: 'Approve the app, then come back and refresh.', duration: 12000 });
    } catch (err) { showError(err, 'Could not start the connection'); }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect this Etsy shop? Local data stays, but syncing stops until you reconnect.')) return;
    await api.post('/auth/disconnect', {});
    reloadAuth();
  };

  if (loading || !data) return <Page title="Settings"><Spinner /></Page>;

  const group = GROUPS.find((g) => g.id === tab);
  const prefixes = Array.isArray(group.prefix) ? group.prefix : [group.prefix];
  const rows = data.settings.filter((s) => prefixes.some((p) => s.key.startsWith(p)));

  return (
    <Page
      title="Settings"
      subtitle={data.paths.db}
      actions={
        <button className="btn sm primary" onClick={save} disabled={busy || !Object.keys(draft).length}>
          {busy ? <Spinner /> : '✓'} Save {Object.keys(draft).length || ''}
        </button>
      }
    >
      <Tabs active={tab} onChange={setTab} tabs={GROUPS.map((g) => ({ id: g.id, label: g.label }))} />

      {tab === 'etsy' && (
        <div className="card mb16">
          <div className="card-head">
            <h3>Shop connection</h3>
            <div className="spacer" />
            <span className={`badge ${auth?.connected ? 'green' : 'grey'}`}>{auth?.connected ? 'connected' : 'not connected'}</span>
          </div>

          <div className="flex mb16">
            <button className="btn" onClick={testConnection} disabled={testing}>
              {testing ? <Spinner /> : '⚡'} Test connection
            </button>
            {testResult && (
              <span className={`badge ${testResult.ok ? 'green' : 'red'}`}>
                {testResult.ok ? 'all checks passed' : 'problems found'}
              </span>
            )}
          </div>

          {testResult && (
            <div className="card mb16" style={{ background: 'var(--bg)' }}>
              {testResult.checks.map((c) => (
                <div key={c.name} className="flex small" style={{ padding: '3px 0' }}>
                  <span style={{ color: c.ok ? 'var(--good)' : 'var(--bad)', width: 18 }}>{c.ok ? '✓' : '✕'}</span>
                  <span style={{ width: 200 }}>{c.name}</span>
                  <span className="dim">{c.detail}</span>
                </div>
              ))}
            </div>
          )}

          {!auth?.hasKeystring ? (
            <Banner kind="warn">
              Add your Etsy <strong>keystring</strong> and <strong>shared secret</strong> below, then save.
              Both come from etsy.com/developers/your-apps. Etsy requires the API key header to be
              <code className="mono"> keystring:shared_secret</code> — the keystring on its own is rejected on
              every endpoint, so the secret is not optional.
            </Banner>
          ) : auth?.connected ? (
            <>
              <dl className="kv mb16">
                <dt>Shop</dt><dd>{auth.shop?.shopName ?? '—'} <span className="muted mono">({auth.shop?.shopId ?? '—'})</span></dd>
                <dt>Connected</dt><dd>{fmtAgo(auth.connectedAt)}</dd>
                <dt>Token expires</dt><dd>{fmtAgo(auth.expiresAt)} <span className="muted">(refreshed automatically)</span></dd>
                <dt>Scopes</dt><dd className="small">{auth.scopes.join(' ') || '—'}</dd>
              </dl>
              <button className="btn danger" onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <>
              <p className="dim small">
                Your Etsy app's callback URL must be exactly:{' '}
                <code className="mono">{auth?.redirectUri}</code>
              </p>
              <button className="btn primary" onClick={connect}>Connect Etsy shop</button>
            </>
          )}
        </div>
      )}

      {tab === 'ai' && (
        <Banner kind="info">
          <div>
            <strong>Manus</strong> is an agent API: a request is submitted as a task and polled until it finishes,
            so replies can take minutes and it does not accept images.{' '}
            <strong>Anthropic</strong> and <strong>OpenAI</strong> answer immediately and read screenshots;
            image editing needs OpenAI. The app falls back to whichever provider can actually do the job.
          </div>
        </Banner>
      )}

      {tab === 'tracking' && (
        <Banner kind="info">
          <div>
            Every tracking number links to the template below — <code className="mono">{'https://www.yuntrack.com/parcelTracking?id={code}'}</code> by
            default, and <code className="mono">{'{code}'}</code> is substituted with the number. Change it here to
            use a different tracker.
            <div className="mt8">
              <strong>YunTrack (direct query)</strong> calls the same endpoint the tracking page calls for itself. Some
              networks are refused by its WAF; if that happens, switch to <strong>via a real browser</strong>, which
              loads the actual page (needs <code className="mono">npm install playwright</code>). Either way the
              no-movement alert keeps working, because it counts elapsed time rather than depending on the feed.
            </div>
          </div>
        </Banner>
      )}

      <div className="card">
        {rows.map((s) => (
          <div className="field" key={s.key}>
            <label>
              {s.label}
              <span className="muted mono small"> · {s.key}</span>
              {s.source !== 'app' && <span className="badge grey" style={{ marginLeft: 6 }}>from {s.source}</span>}
            </label>
            {s.options ? (
              <select
                className="select"
                value={draft[s.key] ?? s.value}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
              >
                {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                className="input"
                type={s.secret ? 'password' : 'text'}
                placeholder={s.secret && s.isSet ? s.value : ''}
                value={draft[s.key] ?? (s.secret ? '' : s.value)}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
              />
            )}
            {s.secret && s.isSet && <div className="hint">A value is stored ({s.value}). Type to replace it; leave blank to keep it.</div>}
          </div>
        ))}
      </div>

      <div className="section-title">Storage</div>
      <div className="card">
        <dl className="kv">
          <dt>Database</dt><dd className="mono small">{data.paths.db}</dd>
          <dt>Uploads</dt><dd className="mono small">{data.paths.uploads}</dd>
          <dt>Exports</dt><dd className="mono small">{data.paths.exports}</dd>
        </dl>
        <div className="card-sub mt16">
          Secrets are encrypted with AES-256-GCM under <code className="mono">data/master.key</code>.
          Keep that file, or you will need to re-enter your keys.
        </div>
      </div>
    </Page>
  );
}
