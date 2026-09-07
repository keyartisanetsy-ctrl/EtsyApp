import React, { useEffect, useMemo, useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Drawer, Modal,
  useAsync, useToast, useErrorToast, fmtDateTime,
} from '../components/ui.jsx';

const FIXED = '__fixed__';

/** Group the source catalogue for the dropdown. */
const groupSources = (fields) => {
  const groups = new Map();
  for (const f of fields) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  return [...groups.entries()];
};

/** Airtable column types that can serve as the key for add-or-update. */
const MERGEABLE = new Set([
  'singleLineText', 'multilineText', 'number', 'currency', 'percent',
  'singleSelect', 'multipleSelects', 'date', 'dateTime', 'email', 'url', 'phoneNumber',
]);

export default function Airtable() {
  const toast = useToast();
  const showError = useErrorToast();
  const status = useAsync(() => api.get('/airtable/status'), []);
  const sources = useAsync(() => api.get('/airtable/source-fields'), []);

  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [editing, setEditing] = useState(null);

  const connected = status.data?.connected;

  const saveToken = async () => {
    try {
      await api.post('/airtable/token', { token });
      setToken('');
      toast({ kind: 'ok', title: 'Token saved' });
      status.reload();
    } catch (err) { showError(err, 'Could not save the token'); }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.get('/airtable/test');
      setTestResult(r);
      toast({ kind: 'ok', title: `Airtable answered: ${r.baseCount} base(s) visible` });
    } catch (err) { showError(err, 'Airtable refused the token'); } finally { setTesting(false); }
  };

  const remove = async (dest) => {
    if (!confirm(`Delete "${dest.label}"? The rows already in Airtable stay where they are.`)) return;
    try {
      await api.del(`/airtable/destinations/${dest.id}`);
      toast({ kind: 'ok', title: 'Destination removed' });
      status.reload();
    } catch (err) { showError(err, 'Could not delete'); }
  };

  return (
    <Page
      title="Airtable"
      subtitle="Send the orders of the shop you are in straight into your own Airtable sheets."
      actions={connected && (
        <button className="btn primary" onClick={() => setEditing({ isNew: true })}>+ New destination</button>
      )}
    >
      {/* ------------------------------------------------------- connection */}
      <section className="card">
        <h3>1. Connect Airtable</h3>
        {connected ? (
          <div className="flex wrap">
            <span className="badge ok">Connected</span>
            <code className="muted">{status.data.tokenPreview}</code>
            <button className="btn sm" onClick={test} disabled={testing}>{testing ? <Spinner /> : 'Test again'}</button>
            <button className="btn sm ghost" onClick={() => api.post('/airtable/token', { token: '' }).then(status.reload)}>
              Disconnect
            </button>
          </div>
        ) : (
          <>
            <p className="muted">
              Create a personal access token at <code>airtable.com/create/tokens</code> with the scopes
              {' '}<code>data.records:read</code>, <code>data.records:write</code> and <code>schema.bases:read</code>,
              then give it access to the bases you want to write to.
            </p>
            <div className="flex">
              <input type="password" className="input"
                placeholder="patXXXXXXXXXXXXXX...."
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="btn primary" onClick={saveToken} disabled={!token.trim()}>Save token</button>
            </div>
          </>
        )}
        {testResult && (
          <div className="mt8">
            <Banner kind="ok">
              This token can see {testResult.baseCount} base(s): {testResult.bases.map((b) => b.name).join(', ')}
            </Banner>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ destinations */}
      <section className="card">
        <h3>2. Where the orders go</h3>
        {status.loading && <Spinner />}
        {status.data && status.data.destinations.length === 0 && (
          <Empty
            icon="⇉"
            title={connected ? 'No destination yet' : 'Connect Airtable first'}
            action={connected && <button className="btn primary" onClick={() => setEditing({ isNew: true })}>+ New destination</button>}
          >
            A destination is one Airtable table plus the rules for filling it in. Make one per sheet you use -
            they belong to the shop you are in, so each shop can point somewhere different.
          </Empty>
        )}

        <div className="grid c2">
          {(status.data?.destinations ?? []).map((d) => (
            <div className="card" key={d.id}>
              <div className="flex">
                <strong>{d.label}</strong>
                <span className="flex">
                  <span className="badge muted">{d.channel === 'shopify' ? 'Shopify' : 'Etsy'}</span>
                  {d.isDefault && <span className="badge">default</span>}
                  {d.shopId === null && <span className="badge muted">all shops</span>}
                </span>
              </div>
              <div className="small muted">
                {d.baseName || d.baseId} › {d.tableName || d.tableId}
              </div>
              <div className="small muted">
                {d.fieldMap.length} column{d.fieldMap.length === 1 ? '' : 's'} mapped
                {d.mergeFields.length > 0 && <> · key: {d.mergeFields.join(', ')}</>}
                {' '}· one row per {d.rowMode === 'item' ? 'item' : 'order'}
                {d.matchMode === 'ai' && <> · matched by AI</>}
              </div>
              {d.lastPushAt && <div className="small muted">last sent {fmtDateTime(Date.parse(d.lastPushAt) / 1000)}</div>}
              <div className="flex mt8">
                <button className="btn sm" onClick={() => setEditing(d)}>Edit mapping</button>
                <button className="btn sm ghost danger" onClick={() => remove(d)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ShopNames destinations={status.data?.destinations ?? []} />

      <RatesPanel />

      <RunHistory />

      {editing && (
        <DestinationEditor
          destination={editing.isNew ? null : editing}
          sources={sources.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); status.reload(); }}
        />
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------ editor */

function DestinationEditor({ destination, sources, onClose, onSaved }) {
  const toast = useToast();
  const showError = useErrorToast();

  const [label, setLabel] = useState(destination?.label ?? '');
  const [baseId, setBaseId] = useState(destination?.baseId ?? '');
  const [tableId, setTableId] = useState(destination?.tableId ?? '');
  const [viewId, setViewId] = useState(destination?.viewId ?? '');
  const [channel, setChannel] = useState(destination?.channel ?? 'etsy');
  const [rowMode, setRowMode] = useState(destination?.rowMode ?? 'item');
  const [fieldMap, setFieldMap] = useState(destination?.fieldMap ?? []);
  const [constants, setConstants] = useState(destination?.constants ?? {});
  const [mergeFields, setMergeFields] = useState(destination?.mergeFields ?? []);
  const [matchMode, setMatchMode] = useState(destination?.matchMode ?? 'name');
  const [createOptions, setCreateOptions] = useState(destination?.createOptions ?? true);
  const [createLinks, setCreateLinks] = useState(destination?.createLinks ?? false);
  const [sendEmpty, setSendEmpty] = useState(destination?.sendEmpty ?? false);
  const [isDefault, setIsDefault] = useState(destination?.isDefault ?? false);
  const [allShops, setAllShops] = useState(destination?.shopId === null);

  const [tables, setTables] = useState([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [matching, setMatching] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState([]);

  const bases = useAsync(() => api.get('/airtable/bases'), []);
  const table = useMemo(() => tables.find((t) => t.id === tableId) ?? null, [tables, tableId]);

  useEffect(() => {
    if (!baseId) { setTables([]); return; }
    setLoadingTables(true);
    api.get(`/airtable/bases/${baseId}/tables`)
      .then((t) => setTables(t))
      .catch((err) => showError(err, 'Could not read that base'))
      .finally(() => setLoadingTables(false));
  }, [baseId]);

  const setTarget = (targetName, value) => {
    if (value === '') {
      setFieldMap((m) => m.filter((e) => e.target !== targetName));
      setConstants(({ [targetName]: _drop, ...rest }) => rest);
      return;
    }
    if (value === FIXED) {
      setFieldMap((m) => m.filter((e) => e.target !== targetName));
      setConstants((c) => ({ ...c, [targetName]: '' }));
      return;
    }
    setConstants(({ [targetName]: _drop, ...rest }) => rest);
    setFieldMap((m) => {
      const without = m.filter((e) => e.target !== targetName);
      return [...without, { target: targetName, source: value, confidence: 'manual' }];
    });
  };

  const runMatch = async (mode) => {
    if (!baseId || !tableId) { toast({ kind: 'warn', title: 'Pick a base and a table first' }); return; }
    setMatching(mode);
    try {
      const r = await api.post('/airtable/match', { baseId, tableId, mode, rowMode });
      setFieldMap(r.map ?? []);
      setConstants(r.constants ?? {});
      setMergeFields(r.mergeFields ?? []);
      setMatchMode(mode);
      setNotes([
        `${r.map?.length ?? 0} column(s) matched${mode === 'ai' ? ` by ${r.provider ?? 'AI'}` : ' by name'}.`,
        ...(r.unmatched?.length ? [`Left empty: ${r.unmatched.slice(0, 8).join(', ')}${r.unmatched.length > 8 ? '…' : ''}`] : []),
        ...(r.dropped?.length ? [`Ignored from the AI answer: ${r.dropped.join('; ')}`] : []),
      ]);
      toast({ kind: 'ok', title: `Matched ${r.map?.length ?? 0} columns`, body: 'Check them, change anything, then save.' });
    } catch (err) { showError(err, 'Matching failed'); } finally { setMatching(null); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        label, baseId, tableId, viewId: viewId || null, channel, rowMode, matchMode,
        baseName: bases.data?.find((b) => b.id === baseId)?.name ?? null,
        tableName: table?.name ?? null,
        viewName: table?.views?.find((v) => v.id === viewId)?.name ?? null,
        fieldMap, mergeFields, constants,
        createOptions, createLinks, sendEmpty, isDefault, allShops,
      };
      if (destination?.id) await api.put(`/airtable/destinations/${destination.id}`, body);
      else await api.post('/airtable/destinations', body);
      toast({ kind: 'ok', title: 'Destination saved' });
      onSaved();
    } catch (err) { showError(err, 'Could not save'); } finally { setSaving(false); }
  };

  const sourceGroups = groupSources(sources);
  const mapByTarget = new Map(fieldMap.map((e) => [e.target, e]));
  const mergeable = (table?.fields ?? []).filter((f) => f.writable && MERGEABLE.has(f.type));

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={destination ? `Edit "${destination.label}"` : 'New Airtable destination'}
      footer={(
        <div className="flex" style={{ width: '100%' }}>
          <label className="flex small muted">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Use this one by default for {channel === 'shopify' ? 'Shopify' : 'Etsy'}
          </label>
          <div className="spacer" />
          <span className="flex">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={saving || !label.trim() || !tableId}>
              {saving ? <Spinner /> : 'Save destination'}
            </button>
          </span>
        </div>
      )}
    >
      <div className="split">
        <div className="field">
          <label>Name</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. KeyArtisanUS orders sheet" />
        </div>

        <div className="field">
          <label>Base</label>
          <select className="select" value={baseId} onChange={(e) => { setBaseId(e.target.value); setTableId(''); setViewId(''); }}>
            <option value="">{bases.loading ? 'Loading…' : 'Pick a base…'}</option>
            {(bases.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Table</label>
          <select className="select" value={tableId} onChange={(e) => { setTableId(e.target.value); setViewId(''); }} disabled={!baseId || loadingTables}>
            <option value="">{loadingTables ? 'Loading…' : 'Pick a table…'}</option>
            {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label>View (optional)</label>
          <select className="select" value={viewId} onChange={(e) => setViewId(e.target.value)} disabled={!table}>
            <option value="">Whole table</option>
            {(table?.views ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <div className="hint">
            Rows always go into the table. A view only filters what you see in Airtable, so if each shop has its
            own view, fill the column that view filters on (usually the shop name) below.
          </div>
        </div>

        <div className="field">
          <label>Which sheet family</label>
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="etsy">Etsy</option>
            <option value="shopify">Shopify / website</option>
          </select>
          <div className="hint">
            Etsy and Shopify keep separate defaults, so one click can go to either sheet.
          </div>
        </div>

        <div className="field">
          <label>One Airtable row per</label>
          <select className="select" value={rowMode} onChange={(e) => setRowMode(e.target.value)}>
            <option value="item">Item — a row for each product in the order</option>
            <option value="order">Order — one row per order, items joined together</option>
          </select>
        </div>
      </div>

      {table && (
        <>
          <div className="flex wrap mt8">
            <button className="btn" onClick={() => runMatch('name')} disabled={!!matching}>
              {matching === 'name' ? <Spinner /> : '⇄ Match by name'}
            </button>
            <button className="btn" onClick={() => runMatch('ai')} disabled={!!matching}>
              {matching === 'ai' ? <Spinner /> : '✦ Match with AI'}
            </button>
            <span className="small muted">
              Name matching is instant and offline. AI matching reads your column names and picks for you.
            </span>
          </div>

          {notes.map((n, i) => <div key={i} className="mt8"><Banner kind="info">{n}</Banner></div>)}

          <h4 className="mt8">Columns</h4>
          <table className="data">
            <thead>
              <tr>
                <th>Airtable column</th>
                <th className="col-tight">Type</th>
                <th>Filled with</th>
                <th className="col-tight">Key</th>
              </tr>
            </thead>
            <tbody>
              {table.fields.map((f) => {
                const entry = mapByTarget.get(f.name);
                const constant = Object.prototype.hasOwnProperty.call(constants, f.name);
                const value = constant ? FIXED : (entry?.source ?? '');
                return (
                  <tr key={f.id} className={!f.writable ? 'muted' : ''}>
                    <td>
                      {f.name}
                      {entry?.why && <div className="small muted">{entry.why}</div>}
                    </td>
                    <td className="small muted">{f.type}</td>
                    <td>
                      {f.writable ? (
                        <>
                          <select className="select" value={value} onChange={(e) => setTarget(f.name, e.target.value)}>
                            <option value="">— leave empty —</option>
                            <option value={FIXED}>— the same fixed value every time —</option>
                            {sourceGroups.map(([group, items]) => (
                              <optgroup key={group} label={group}>
                                {items.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                              </optgroup>
                            ))}
                          </select>
                          {constant && (
                            <>
                              {/* Suggest the options the column already has, so a
                                  typo does not add yet another stray option. */}
                              <input
                                className="input mt8"
                                list={f.choices?.length ? `choices-${f.id}` : undefined}
                                placeholder={f.choices?.length ? `e.g. ${f.choices[0]}` : 'value to write every time'}
                                value={constants[f.name] ?? ''}
                                onChange={(e) => setConstants((c) => ({ ...c, [f.name]: e.target.value }))}
                              />
                              {f.choices?.length > 0 && (
                                <datalist id={`choices-${f.id}`}>
                                  {f.choices.slice(0, 60).map((c) => <option key={c} value={c} />)}
                                </datalist>
                              )}
                            </>
                          )}
                        </>
                      ) : <span className="small">Airtable calculates this column</span>}
                    </td>
                    <td>
                      {MERGEABLE.has(f.type) && f.writable && (
                        <input
                          type="checkbox"
                          checked={mergeFields.includes(f.name)}
                          disabled={!mergeFields.includes(f.name) && mergeFields.length >= 3}
                          onChange={(e) => setMergeFields((m) => (e.target.checked
                            ? [...m, f.name].slice(0, 3)
                            : m.filter((n) => n !== f.name)))}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="hint mt">
            <strong>Key</strong> is how Airtable recognises a row it already has. Tick the column that holds the order
            number and sending the same order again updates that row instead of adding a second one. Without a key,
            every send adds new rows.
          </p>

          <h4 className="mt8">Options</h4>
          <div className="flex col">
            <label className="flex">
              <input type="checkbox" checked={createOptions} onChange={(e) => setCreateOptions(e.target.checked)} />
              Create missing options in single/multi select columns (needed when Order ID is a select column)
            </label>
            <label className="flex">
              <input type="checkbox" checked={createLinks} onChange={(e) => setCreateLinks(e.target.checked)} />
              Fill linked-record columns too — Airtable will create a row in the linked table when it finds no match
            </label>
            <label className="flex">
              <input type="checkbox" checked={sendEmpty} onChange={(e) => setSendEmpty(e.target.checked)} />
              Write blanks when this app has no value (otherwise the Airtable cell is left untouched)
            </label>
            <label className="flex">
              <input type="checkbox" checked={allShops} onChange={(e) => setAllShops(e.target.checked)} />
              Make this destination available to every connected shop, not just this one
            </label>
          </div>
        </>
      )}
    </Drawer>
  );
}

/* ----------------------------------------------------------- shop names */

/**
 * What each connected shop is called over in Airtable.
 *
 * Etsy's own shop name and the option in an Airtable select column are often
 * spelled differently, and that column is what decides which per-shop view a
 * row lands in — so it is set here once per shop rather than guessed. A single
 * destination shared by every shop then files each order under the right name
 * automatically.
 */
function ShopNames({ destinations = [] }) {
  const toast = useToast();
  const showError = useErrorToast();
  const shops = useAsync(() => api.get('/airtable/shop-names'), []);
  const [draft, setDraft] = useState({});
  const [choices, setChoices] = useState([]);

  // Offer the options the shop column already has, so a typo cannot create a
  // stray new option in Airtable.
  const source = destinations.find((d) => d.channel === 'etsy') ?? destinations[0];
  useEffect(() => {
    if (!source) return;
    api.get(`/airtable/bases/${source.baseId}/tables/${source.tableId}/choices`)
      .then((cols) => {
        const shopish = cols.find((c) => /mağaza|magaza|shop|store|channel/i.test(c.name));
        setChoices(shopish?.choices ?? []);
      })
      .catch(() => setChoices([]));
  }, [source?.baseId, source?.tableId]);

  // Put the plausible shop names first: options that look like one of the
  // connected shops, then short ones, ahead of the long strings that pile up
  // in a select column over time.
  const suggestions = useMemo(() => {
    const names = (shops.data ?? []).map((s) => (s.shopName || '').toLowerCase());
    const looksLikeShop = (c) => names.some((n) => n && (c.toLowerCase().includes(n.slice(0, 6)) || n.includes(c.toLowerCase())));
    return [...choices].sort((a, b) => {
      const rank = (c) => (looksLikeShop(c) ? 0 : 1) * 100 + Math.min(c.length, 60);
      return rank(a) - rank(b);
    }).slice(0, 40);
  }, [choices, shops.data]);

  const save = async (shopId, name) => {
    try {
      await api.put(`/airtable/shop-names/${shopId}`, { name });
      toast({ kind: 'ok', title: 'Saved', body: `Rows from this shop will say "${name}".` });
      shops.reload();
    } catch (err) { showError(err, 'Could not save the name'); }
  };

  if (!shops.data?.length) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Shop names in Airtable</h3>
      </div>
      <p className="small muted">
        A shop column (MAĞAZA, Shop, Store…) is what tells your sheet which shop a row came from, and it is what
        the per-shop views filter on. Set the exact wording each shop should be filed under — it does not have to
        match Etsy's spelling. Map that column to <strong>Shop name as written in Airtable</strong> and one
        destination can serve every shop.
      </p>

      <table className="data">
        <thead>
          <tr><th>Shop on Etsy</th><th>Filed in Airtable as</th><th className="col-tight" /></tr>
        </thead>
        <tbody>
          {shops.data.map((s) => {
            const value = draft[s.shopId] ?? s.airtableName;
            const dirty = value !== s.airtableName;
            return (
              <tr key={s.shopId}>
                <td>
                  {s.shopName}
                  {s.isActive && <span className="badge" style={{ marginLeft: 6 }}>active</span>}
                </td>
                <td>
                  {/* A shop column can carry a lot of accumulated options, so
                      this suggests rather than forcing a choice from a long list. */}
                  <input
                    className="input"
                    list={`shop-choices-${s.shopId}`}
                    value={value}
                    placeholder={s.shopName}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.shopId]: e.target.value }))}
                  />
                  <datalist id={`shop-choices-${s.shopId}`}>
                    {suggestions.map((c) => <option key={c} value={c} />)}
                  </datalist>
                  {value && choices.length > 0 && !choices.includes(value) && (
                    <div className="hint">Not an option in Airtable yet — it will be created on the first send.</div>
                  )}
                </td>
                <td>
                  <button className="btn sm" disabled={!dirty} onClick={() => save(s.shopId, value)}>Save</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* ---------------------------------------------------------------- rates */

/**
 * The daily rates the app values orders at. Every order is converted at the
 * rate published for its own day, so what a sheet shows never drifts when the
 * currency moves later.
 */
function RatesPanel() {
  const showError = useErrorToast();
  const toast = useToast();
  const [quote, setQuote] = useState('CNY');
  const [busy, setBusy] = useState(false);
  const rates = useAsync(() => api.get(`/airtable/rates?quote=${quote}&limit=10`), [quote]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.post('/airtable/rates/refresh', {});
      toast({ kind: r.ok ? 'ok' : 'warn', title: r.ok ? `Rates updated to ${r.newest}` : (r.error ?? 'Could not update') });
      rates.reload();
    } catch (err) { showError(err, 'Could not refresh the rates'); } finally { setBusy(false); }
  };

  const cov = rates.data?.coverage;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Exchange rates</h3>
        <div className="spacer" />
        <select className="select sm" style={{ width: 110 }} value={quote} onChange={(e) => setQuote(e.target.value)}>
          {['CNY', 'TRY', 'EUR', 'GBP', 'CAD', 'AUD'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="btn sm" onClick={refresh} disabled={busy}>{busy ? <Spinner /> : 'Refresh'}</button>
      </div>

      <p className="small muted">
        Each order is valued at the rate of the day it arrived. Rates come from the European Central Bank,
        which publishes on working days only — an order that lands on a weekend uses the previous working day.
        {cov?.days ? ` Holding ${cov.days} days, ${cov.from} to ${cov.to}.` : ' No rates stored yet — press Refresh.'}
      </p>

      {rates.data?.rates?.length > 0 && (
        <table className="data">
          <thead>
            <tr><th>Day</th><th className="right">1 USD =</th><th className="right">1 {quote} = USD</th></tr>
          </thead>
          <tbody>
            {rates.data.rates.map((r) => (
              <tr key={r.day}>
                <td className="small mono">{r.day}</td>
                <td className="num">{r.perUsd} {quote}</td>
                <td className="num">{r.inUsd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ run history */

function RunHistory() {
  const runs = useAsync(() => api.get('/airtable/runs?limit=10'), []);
  if (!runs.data?.length) return null;
  return (
    <section className="card">
      <h3>Recent sends</h3>
      <table className="data">
        <thead>
          <tr><th>When</th><th>Destination</th><th>Mode</th><th>Added</th><th>Updated</th><th>Deleted</th><th>Skipped</th></tr>
        </thead>
        <tbody>
          {runs.data.map((r) => (
            <tr key={r.id}>
              <td className="small">{fmtDateTime(Date.parse(r.ran_at) / 1000)}</td>
              <td>{r.label ?? '—'}</td>
              <td className="small">{r.mode}</td>
              <td>{r.created}</td>
              <td>{r.updated}</td>
              <td>{r.deleted}</td>
              <td>{r.skipped}{r.failed ? ` · ${r.failed} failed` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* -------------------------------------------------- shared send-to modal */

/**
 * The one-click sender used from the Orders screen. Shows exactly what will be
 * written before anything leaves the machine.
 */
export function SendToAirtable({ receiptIds, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const status = useAsync(() => api.get('/airtable/status'), []);
  const [destinationId, setDestinationId] = useState(null);
  const [mode, setMode] = useState('upsert');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const destinations = status.data?.destinations ?? [];
  const chosen = destinationId ?? destinations.find((d) => d.isDefault)?.id ?? destinations[0]?.id ?? null;

  useEffect(() => {
    if (!chosen) return;
    setPreview(null);
    api.post('/airtable/preview', { destinationId: chosen, receiptIds, mode })
      .then(setPreview)
      .catch((err) => showError(err, 'Could not build the preview'));
  }, [chosen, mode, receiptIds.join(',')]);

  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post('/airtable/push', { destinationId: chosen, receiptIds, mode });
      toast({
        kind: 'ok',
        title: mode === 'delete' ? `Deleted ${r.deleted} row(s)` : `${r.created} added, ${r.updated} updated`,
        body: r.errors?.length ? r.errors[0] : undefined,
        duration: 8000,
      });
      onDone?.();
      onClose();
    } catch (err) { showError(err, 'Airtable rejected the send'); } finally { setBusy(false); }
  };

  const columns = preview?.rows?.[0] ? Object.keys(preview.rows[0].fields) : [];

  return (
    <Modal
      open
      lg
      onClose={onClose}
      title={`Send ${receiptIds.length} order(s) to Airtable`}
      footer={(
        <div className="flex" style={{ width: '100%' }}>
          <span className="small muted">
            {preview && mode !== 'delete' && `${preview.willCreate} new row(s), ${preview.willUpdate} existing row(s)`}
            {preview && mode === 'delete' && `${preview.willDelete ?? 0} row(s) will be removed from Airtable`}
          </span>
          <div className="spacer" />
          <span className="flex">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className={`btn ${mode === 'delete' ? 'danger' : 'primary'}`} onClick={send} disabled={busy || !chosen || !preview}>
              {busy ? <Spinner /> : (mode === 'delete' ? 'Delete from Airtable' : 'Send to Airtable')}
            </button>
          </span>
        </div>
      )}
    >
      {!destinations.length ? (
        <Empty icon="⇉" title="No Airtable destination yet">
          Open the Airtable page from the sidebar and set one up first.
        </Empty>
      ) : (
        <>
          <div className="split">
            <div className="field">
              <label>Destination</label>
              <select className="select" value={chosen ?? ''} onChange={(e) => setDestinationId(Number(e.target.value))}>
                {destinations.map((d) => (
                  <option key={d.id} value={d.id}>{d.label} — {d.tableName || d.tableId}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>What to do</label>
              <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="upsert">Add new rows, update ones already there</option>
                <option value="update">Only update rows sent before</option>
                <option value="delete">Delete the rows sent before</option>
              </select>
            </div>
          </div>

          {!preview && <div className="mt8"><Spinner /> building the preview…</div>}

          {preview?.issues?.length > 0 && (
            <div className="mt8">
              <Banner kind="warn">
                Some columns will stay empty:
                <ul className="small">
                  {preview.issues.slice(0, 4).map((i, n) => (
                    <li key={n}>Order {i.receiptId}: {i.skipped.join('; ')}</li>
                  ))}
                </ul>
              </Banner>
            </div>
          )}

          {preview?.rows?.length > 0 && mode !== 'delete' && (
            <>
              <h4 className="mt8">This is what will be written</h4>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Order</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td className="small">
                          {r.receiptId}
                          {r.existingRecordId && <div className="small muted">updates an existing row</div>}
                        </td>
                        {columns.map((c) => (
                          <td key={c} className="small">{formatCell(r.fields[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 8 && <p className="small muted">…and {preview.rows.length - 8} more row(s).</p>}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

const formatCell = (v) => {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? x.url : x)).join(', ');
  return String(v).slice(0, 60);
};
