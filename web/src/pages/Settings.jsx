import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Banner, Tabs, CopyButton, useAsync, useToast, useErrorToast, fmtAgo } from '../components/ui.jsx';

const GROUPS = [
  { id: 'etsy', label: 'Etsy shops', prefix: 'etsy.' },
  { id: 'privacy', label: 'Privacy', prefix: 'privacy.' },
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
  const { data: privacy, reload: reloadPrivacy } = useAsync(() => api.get('/settings/privacy'), []);
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
      reloadPrivacy();
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

  // What the saved token can actually do. Worth its own button: when a call is
  // refused for "insufficient scope", this says which permission is missing
  // instead of leaving you to guess whether reconnecting would help.
  const [scopes, setScopes] = useState(null);
  const [checkingScopes, setCheckingScopes] = useState(false);
  const checkScopes = async () => {
    setCheckingScopes(true);
    try { setScopes(await api.get('/etsy-extra/scopes')); }
    catch (err) { showError(err, 'Could not read the token permissions'); }
    finally { setCheckingScopes(false); }
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
            <h3>Connected shops</h3>
            <div className="spacer" />
            <span className={`badge ${auth?.accountCount ? 'green' : 'grey'}`}>
              {auth?.accountCount ? `${auth.accountCount} connected` : 'none connected'}
            </span>
          </div>

          {auth?.accounts?.length > 0 && (
            <table className="data mb16">
              <thead><tr><th /><th>Shop</th><th>Shop ID</th><th>Connected</th><th /></tr></thead>
              <tbody>
                {auth.accounts.map((a) => (
                  <tr key={a.shopId}>
                    <td>{a.isActive ? <span className="badge green">active</span> : <span className="badge grey">idle</span>}</td>
                    <td>
                      <input
                        className="input sm"
                        defaultValue={a.label || a.shopName || ''}
                        placeholder={a.shopName || 'nickname'}
                        onBlur={async (e) => {
                          if (e.target.value === (a.label || '')) return;
                          try { await api.put(`/auth/accounts/${a.shopId}`, { label: e.target.value }); reloadAuth(); }
                          catch (err) { showError(err); }
                        }}
                      />
                    </td>
                    <td className="mono small">{a.shopId}</td>
                    <td className="small muted">{fmtAgo(a.connectedAt)}</td>
                    <td>
                      <div className="flex gap4">
                        {!a.isActive && (
                          <button className="btn xs" onClick={async () => {
                            try { await api.post(`/auth/accounts/${a.shopId}/activate`, {}); reloadAuth(); toast({ kind: 'ok', title: 'Switched shop' }); }
                            catch (err) { showError(err); }
                          }}>Use this</button>
                        )}
                        <button className="btn xs danger" onClick={async () => {
                          if (!confirm(`Disconnect ${a.label || a.shopName || a.shopId}?\n\nIts locally stored listings, orders and tracking are removed too. Nothing on Etsy changes.`)) return;
                          try { await api.del(`/auth/accounts/${a.shopId}`); reloadAuth(); toast({ kind: 'ok', title: 'Shop disconnected' }); }
                          catch (err) { showError(err); }
                        }}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <Banner kind="info">
            <div>
              You can connect as many Etsy shops as you like — <strong>every</strong> screen (listings, orders,
              SKUs, tracking, bulk jobs, research) shows only the active shop's own data; nothing is ever mixed
              between shops.
              <div className="mt8">
                The keystring and shared secret below register <strong>one Etsy app</strong> — you only enter them
                once. Each shop connects to that same app through its own separate authorization. If the second
                shop has a different Etsy login than the one already signed in in your browser, log out of Etsy
                (or open a private/incognito window) before pressing <strong>Connect another shop</strong>, so Etsy
                asks you to sign in as that shop's owner instead of re-authorizing the one you're already on.
              </div>
            </div>
          </Banner>

          <div className="flex mb16">
            <button className="btn" onClick={testConnection} disabled={testing}>
              {testing ? <Spinner /> : '⚡'} Test connection
            </button>
            <button className="btn" onClick={checkScopes} disabled={checkingScopes}
                    title="Ask Etsy which permissions this token actually carries">
              {checkingScopes ? <Spinner /> : '🔑'} Check permissions
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

          {scopes && (
            <div className="card mb16" style={{ background: 'var(--bg)' }}>
              <div className="section-title">
                What this token can do
                <span className={`badge ${scopes.complete ? 'green' : 'amber'}`} style={{ marginLeft: 8 }}>
                  {scopes.granted.length} permission(s)
                </span>
              </div>
              <div className="hint mb8">{scopes.note}</div>
              <div className="pill-row">
                {scopes.granted.map((sc) => <span key={sc} className="badge green">{sc}</span>)}
                {scopes.missing.map((sc) => (
                  <span key={sc} className="badge red" title="Reconnect the shop to grant this">{sc}</span>
                ))}
              </div>
            </div>
          )}

          {!auth?.hasKeystring ? (
            <Banner kind="warn">
              Add your Etsy <strong>keystring</strong> and <strong>shared secret</strong> below, then save.
              Both come from etsy.com/developers/your-apps. Etsy requires the API key header to be
              <code className="mono"> keystring:shared_secret</code> — the keystring on its own is rejected on
              every endpoint, so the secret is not optional.
            </Banner>
          ) : auth?.accountCount ? (
            <>
              <dl className="kv mb16">
                <dt>Active shop</dt><dd>{auth.shop?.shopName ?? '—'} <span className="muted mono">({auth.shop?.shopId ?? '—'})</span></dd>
                <dt>Token expires</dt><dd>{fmtAgo(auth.expiresAt)} <span className="muted">(refreshed automatically)</span></dd>
                <dt>Scopes</dt><dd className="small">{auth.scopes.join(' ') || '—'}</dd>
              </dl>
              <button className="btn primary" onClick={connect}>+ Connect another shop</button>
              <button className="btn danger" style={{ marginLeft: 8 }} onClick={disconnect}>Disconnect all</button>
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

      {tab === 'privacy' && privacy && (
        <>
          <div className="card mb16">
            <div className="card-head">
              <h3>What leaves this computer</h3>
              <div className="spacer" />
              <span className={`badge ${privacy.proxyConfigured ? 'green' : 'amber'}`}>
                {privacy.proxyConfigured ? 'proxied' : 'direct connection'}
              </span>
            </div>

            <div className="section-title">Never sent — to Etsy or anyone else</div>
            <ul className="privacy-list good">
              {privacy.neverSent.map((x) => <li key={x}>{x}</li>)}
            </ul>

            <div className="section-title">Sent with every request</div>
            <div className="pill-row mb8">
              {privacy.headersSent.map((h) => <span key={h} className="tag mono">{h}</span>)}
            </div>
            <div className="small dim">
              The identifying header is a fixed <code className="mono">{privacy.userAgent}</code> — it carries no
              version, platform or machine detail. These are stripped before sending:{' '}
              {privacy.headersStripped.join(', ')}.
            </div>

            <div className="section-title">Your IP address</div>
            <Banner kind={privacy.ipAddress.hidden ? 'ok' : 'warn'}>
              {privacy.ipAddress.note}
            </Banner>
          </div>

          <div className="card mb16">
            <div className="card-head"><h3>Where the app can connect</h3></div>
            <div className="card-sub">
              This is the complete list. Everything marked optional is only contacted when you use that feature.
            </div>
            <table className="data">
              <thead><tr><th>Destination</th><th>Why</th><th>What it receives</th><th /></tr></thead>
              <tbody>
                {privacy.destinations.map((d) => (
                  <tr key={d.host}>
                    <td className="mono small">{d.host}</td>
                    <td className="small">{d.purpose}</td>
                    <td className="small dim">{d.sends}</td>
                    <td>
                      <span className={`badge ${d.optional ? 'grey' : 'blue'}`}>
                        {d.optional ? 'optional' : 'required'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card mb16">
            <div className="card-head"><h3>Where your data lives</h3></div>
            <div className="small dim">{privacy.storage.note}</div>
            <div className="mono small mt8">{privacy.storage.database}</div>
          </div>
        </>
      )}

      {tab === 'ai' && (
        <>
          <Banner kind="info">
            <div>
              <strong>Manus</strong> is an agent API: a request is submitted as a task and polled until it finishes,
              so replies can take minutes and it does not accept images.{' '}
              <strong>Anthropic</strong> and <strong>OpenAI</strong> answer immediately and read screenshots;
              image editing needs OpenAI. The app falls back to whichever provider can actually do the job.
            </div>
          </Banner>
          <ModelPicker draft={draft} setDraft={setDraft} />
        </>
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
            ) : s.key === 'etsy.redirect_uri' ? (
              <div className="flex gap4">
                <input
                  className="input mono"
                  readOnly
                  value={draft[s.key] ?? s.value}
                  onFocus={(e) => e.target.select()}
                />
                <CopyButton text={draft[s.key] ?? s.value} label="Copy" className="btn sm" />
              </div>
            ) : (
              <input
                className="input"
                type={s.secret ? 'password' : 'text'}
                placeholder={s.secret && s.isSet ? s.value : ''}
                value={draft[s.key] ?? (s.secret ? '' : s.value)}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
              />
            )}
            {s.key === 'etsy.redirect_uri' && (
              <div className="hint">
                Paste this <strong>exact</strong> address into your Etsy app's "Callback URL" field at{' '}
                <a href="https://www.etsy.com/developers/your-apps" target="_blank" rel="noreferrer">etsy.com/developers/your-apps</a>.
                It uses <code className="mono">localhost</code> rather than an IP address because Etsy's own
                validation rejects IP-literal hosts outright ("IP addresses are not allowed", e.g. 127.0.0.1) —
                <code className="mono">http://</code> itself is fine, Etsy does not require https here.
              </div>
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

/**
 * Which model does what.
 *
 * Two separate choices on purpose. The everyday default is what listing copy
 * and message replies use, where speed matters and a small slip is cheap. The
 * address check is its own choice, because that one decides whether a parcel
 * ships to a real house - it is worth the careful model even if it costs more.
 *
 * Left blank, a job just uses the provider's own default, so this is a
 * refinement rather than something you have to fill in.
 */
function ModelPicker({ draft, setDraft }) {
  const { data } = useAsync(() => api.get('/ai/models'), []);
  const providers = data?.providers ?? [];
  const usable = providers.filter((p) => p.configured);

  const set = (key, value) => setDraft({ ...draft, [key]: value });
  const valueOf = (key, fallback = '') => draft[key] ?? fallback;

  if (!providers.length) return null;

  return (
    <div className="card">
      <div className="card-head"><h3>Which model does what</h3></div>

      {!usable.length && (
        <Banner kind="warn">
          No provider has a key yet. Add one below and these choices become available.
        </Banner>
      )}

      <div className="field">
        <label>Everyday default</label>
        <select className="select" value={valueOf('ai.provider')} onChange={(e) => set('ai.provider', e.target.value)}>
          <option value="">Whichever is configured</option>
          {usable.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
        </select>
        <div className="hint">Used for listing copy, message replies and the mapping suggestions.</div>
      </div>

      {usable.map((p) => (
        <div className="field" key={p.provider}>
          <label>{p.provider} version</label>
          <select
            className="select"
            value={valueOf(`ai.${p.provider}.model`, p.current ?? '')}
            onChange={(e) => set(`ai.${p.provider}.model`, e.target.value)}
          >
            {p.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div className="hint">
            {p.models.find((m) => m.id === valueOf(`ai.${p.provider}.model`, p.current))?.note
              ?? 'Any model id this provider accepts can also be typed into the field below.'}
          </div>
        </div>
      ))}

      <div className="section-title">Address checking</div>
      <div className="hint mb8">
        This one is worth setting on its own. A wrong address costs the parcel, the postage and the refund,
        so the careful model earns its keep here even though it is slower.
      </div>
      <div className="split">
        <div className="field">
          <label>Provider</label>
          <select className="select" value={valueOf('ai.address.provider')}
                  onChange={(e) => set('ai.address.provider', e.target.value)}>
            <option value="">Same as the everyday default</option>
            {usable.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Version</label>
          <select className="select" value={valueOf('ai.address.model')}
                  onChange={(e) => set('ai.address.model', e.target.value)}>
            <option value="">That provider&rsquo;s default</option>
            {(providers.find((p) => p.provider === (valueOf('ai.address.provider') || usable[0]?.provider))?.models ?? [])
              .map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <div className="hint">
        You can also pick a model for one order at a time, on the order itself.
      </div>
    </div>
  );
}
