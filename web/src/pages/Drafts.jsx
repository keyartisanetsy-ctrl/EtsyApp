import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Drawer, Modal, Thumb, CopyButton, Tabs,
  useAsync, useToast, useErrorToast, fmtMoney, fmtAgo,
} from '../components/ui.jsx';

const WHEN_MADE = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007'];

/**
 * The draft desk.
 *
 * A listing you started on Etsy comes down here, you finish it across as many
 * sittings as you like, and only the Send button touches Etsy. What Etsy has
 * and what you changed are shown side by side, so you can always see which is
 * which before committing.
 */
export default function Drafts() {
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [params, setParams] = useSearchParams();

  // Product Studio is handed a link straight to the draft it just created, so
  // that link has to actually open it rather than dropping you on the list.
  useEffect(() => {
    const wanted = params.get('open');
    if (!wanted) return;
    setOpen(Number(wanted));
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const toast = useToast();
  const showError = useErrorToast();

  const { data, loading, reload } = useAsync(() => api.get('/drafts'), []);
  const drafts = data?.drafts ?? [];

  const pull = async () => {
    setBusy(true);
    try {
      const r = await api.post('/drafts/pull', {});
      toast({ kind: 'ok', title: `${r.seen} draft(s) on Etsy`, body: r.note });
      reload();
    } catch (err) { showError(err, 'Could not read your Etsy drafts'); } finally { setBusy(false); }
  };

  const startNew = async () => {
    try {
      const d = await api.post('/drafts', { title: 'New listing' });
      toast({ kind: 'ok', title: 'Draft started', body: 'Nothing goes to Etsy until you send it.' });
      reload();
      setOpen(d.listingId);
    } catch (err) { showError(err); }
  };

  return (
    <TablePage
      title="Draft desk"
      subtitle={drafts.length ? `${drafts.length} draft(s) — nothing here is on Etsy until you send it` : ''}
      actions={
        <>
          <button className="btn sm" onClick={() => setConnectOpen(true)}>🔗 Connect Product Studio</button>
          <button className="btn sm" onClick={startNew}>＋ Start one here</button>
          <button className="btn sm primary" disabled={busy} onClick={pull}>
            {busy ? <Spinner /> : '↧'} Get drafts from Etsy
          </button>
        </>
      }
    >
      <div style={{ padding: 16, paddingBottom: 0 }}>
        <Banner kind="info">
          Anything you create on Etsy lands here when you press &ldquo;Get drafts from Etsy&rdquo;. Edit it as much
          as you like — your changes stay on this machine until you send them back.
        </Banner>
      </div>

      {loading && !data ? <div className="empty"><Spinner /></div>
        : !drafts.length ? (
          <Empty icon="✎" title="No drafts yet">
            Press &ldquo;Get drafts from Etsy&rdquo; to bring down anything you started there, or start one here.
          </Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th className="col-tight" /><th>Title</th><th className="right">Price</th>
                <th>Where it is</th><th>Your edits</th><th>Updated</th><th className="col-tight" />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr key={d.listingId} className={d.stagedCount ? 'multi-item' : ''}>
                  <td><Thumb src={d.imageUrl} fallback="✎" /></td>
                  <td className="cell-title">{d.title}</td>
                  <td className="num">{d.price != null ? fmtMoney(d.price, 'USD') : '—'}</td>
                  <td className="small">
                    {d.isLocalOnly
                      ? <span className="badge grey" title="This exists only on your machine">not on Etsy yet</span>
                      : <span className="badge blue">{d.etsyState}</span>}
                    {d.pushError && <div className="small" style={{ color: 'var(--danger,#e05252)' }}>{d.pushError}</div>}
                  </td>
                  <td className="small">
                    {d.stagedCount
                      ? <span className="badge amber">{d.stagedCount} unsent change{d.stagedCount === 1 ? '' : 's'}</span>
                      : <span className="dim">none</span>}
                  </td>
                  <td className="small dim">{fmtAgo(d.updatedAt)}</td>
                  <td><button className="btn xs" onClick={() => setOpen(d.listingId)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <DraftEditor id={open} onClose={() => setOpen(null)} onChanged={reload} />
      <ConnectProductStudio open={connectOpen} onClose={() => setConnectOpen(false)} onImported={reload} />
    </TablePage>
  );
}

function DraftEditor({ id, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const { data: draft, reload } = useAsync(
    () => (id ? api.get(`/drafts/${id}`) : null), [id], { immediate: !!id });
  const { data: plan, reload: replan } = useAsync(
    () => (id ? api.get(`/drafts/${id}/preview`) : null), [id], { immediate: !!id });
  // Etsy asks for these by numeric id; nobody knows them by heart.
  const { data: choices, reload: reloadChoices } = useAsync(
    () => (id ? api.get('/drafts/choices') : null), [id], { immediate: !!id });

  if (!id) return null;

  const save = async (patch) => {
    try { await api.patch(`/drafts/${id}`, patch); reload(); replan(); onChanged(); }
    catch (err) { showError(err, 'Could not save that'); }
  };

  const send = async (activate) => {
    setBusy(true);
    try {
      const r = await api.post(`/drafts/${id}/push`, { activate });
      toast({
        kind: 'ok',
        title: r.created ? `Created on Etsy as ${r.listingId}` : `Sent ${r.pushed.length} change(s) to Etsy`,
        body: activate ? 'It is live now.' : 'It is a draft on Etsy — activate it when you are ready.',
      });
      onChanged();
      onClose();
    } catch (err) { showError(err, 'Etsy would not take it'); } finally { setBusy(false); }
  };

  const merged = draft?.merged ?? {};
  const isChanged = (f) => draft?.changed?.includes(f);

  /** A dropdown of what the shop really has, instead of a number to look up. */
  const pick = (name, label, options, hint) => (
    <div className="field">
      <label>
        {label}
        {isChanged(name) && <span className="badge amber" style={{ marginLeft: 6 }}>changed</span>}
      </label>
      <select className="select" value={merged[name] ?? ''} onChange={(e) => save({ [name]: e.target.value })}>
        <option value="">—</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {!options.length && <div className="hint">This shop has none set up yet.</div>}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );

  const field = (name, label, props = {}) => (
    <div className="field">
      <label>
        {label}
        {isChanged(name) && (
          <span className="badge amber" style={{ marginLeft: 6 }} title={`Etsy still has: ${draft.etsy[name] ?? '(empty)'}`}>
            changed
          </span>
        )}
      </label>
      {props.textarea
        ? <textarea className="textarea" rows={props.rows ?? 6} value={merged[name] ?? ''}
                    onChange={(e) => save({ [name]: e.target.value })} />
        : props.options
          ? <select className="select" value={merged[name] ?? ''} onChange={(e) => save({ [name]: e.target.value })}>
              <option value="">—</option>
              {props.options.map((o) => <option key={o} value={o}>{String(o).replace(/_/g, ' ')}</option>)}
            </select>
          : <input className="input" type={props.type ?? 'text'} step={props.step}
                   value={Array.isArray(merged[name]) ? merged[name].join(', ') : merged[name] ?? ''}
                   onChange={(e) => save({ [name]: e.target.value })} />}
      {props.hint && <div className="hint">{props.hint}</div>}
    </div>
  );

  return (
    <Drawer
      open onClose={onClose} wide
      title={draft ? (draft.isLocalOnly ? 'New draft' : `Draft ${draft.listingId}`) : 'Draft'}
      footer={draft && (
        <>
          <button className="btn" onClick={async () => { await api.post(`/drafts/${id}/revert`, {}); reload(); replan(); onChanged(); }}>
            Drop my edits
          </button>
          <div className="spacer" />
          <button className="btn" disabled={busy || !plan?.ready} onClick={() => send(false)}>
            {busy ? <Spinner /> : 'Send to Etsy as draft'}
          </button>
          <button className="btn primary" disabled={busy || !plan?.ready} onClick={() => send(true)}>
            {busy ? <Spinner /> : 'Send and publish'}
          </button>
        </>
      )}
    >
      {!draft ? <Spinner /> : (
        <>
          {plan?.problems?.length > 0 && (
            <Banner kind="warn">
              <div>Etsy will refuse this until these are sorted:</div>
              <ul style={{ margin: '6px 0 0 16px' }}>
                {plan.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </Banner>
          )}
          {plan?.ready && (
            <Banner kind="ok">
              Ready. {plan.isNew ? 'This will be created on Etsy.' : `${plan.willChange.length} field(s) will change: ${plan.willChange.join(', ')}.`}
            </Banner>
          )}

          {draft.images?.length > 0 && (
            <>
              <div className="section-title">Photos on Etsy</div>
              <div className="flex gap4 mb16" style={{ flexWrap: 'wrap' }}>
                {draft.images.map((i) => <Thumb key={i.imageId} src={i.thumb || i.url} size="lg" />)}
              </div>
            </>
          )}

          <div className="section-title">Listing</div>
          {field('title', 'Title', { hint: `${(merged.title ?? '').length} of 140 characters` })}
          {field('description', 'Description', { textarea: true, rows: 8 })}
          <div className="split">
            {field('price', 'Price', { type: 'number', step: '0.01' })}
            {field('quantity', 'Stock', { type: 'number' })}
          </div>
          {field('tags', 'Tags', { hint: 'Comma separated, up to 13, each at most 20 characters' })}
          {field('materials', 'Materials', { hint: 'Comma separated' })}

          <div className="section-title">Etsy needs these</div>
          <div className="split">
            {field('taxonomy_id', 'Category id', { type: 'number', hint: 'Find one on the Create listing screen' })}
            {field('who_made', 'Who made it', { options: ['i_did', 'someone_else', 'collective'] })}
          </div>
          <div className="split">
            {field('when_made', 'When was it made', { options: WHEN_MADE })}
            {pick('shipping_profile_id', 'Shipping delivery profile',
              (choices?.shippingProfiles ?? []).map((p) => ({
                value: p.id, label: `${p.title}${p.processing ? ` · ${p.processing}` : ''}`,
              })),
              'Where you post from and what you charge.')}
          </div>

          <div className="field">
            <label>
              Processing profile
              {isChanged('readiness_state_id') && <span className="badge amber" style={{ marginLeft: 6 }}>changed</span>}
            </label>
            {choices?.needsProcessingProfile ? (
              <>
                <Banner kind="warn">
                  {choices.note}
                </Banner>
                <MakeProcessingProfile onMade={(newId) => { save({ readiness_state_id: newId }); reloadChoices(); }} />
              </>
            ) : (
              <>
                <select className="select" value={merged.readiness_state_id ?? ''}
                        onChange={(e) => save({ readiness_state_id: e.target.value })}>
                  <option value="">—</option>
                  {(choices?.processingProfiles ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label ? `${p.label} · ` : ''}{String(p.readinessState ?? '').replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  How long before you dispatch. Etsy refuses a physical listing without one, even though its
                  own documentation calls this optional.
                </div>
              </>
            )}
          </div>

          <div className="split">
            {pick('shop_section_id', 'Shop section',
              (choices?.sections ?? []).map((x) => ({ value: x.id, label: x.title })),
              'Optional. Which part of your shop it appears in.')}
            {pick('return_policy_id', 'Return policy',
              (choices?.returnPolicies ?? []).map((x) => ({
                value: x.id, label: x.accepts ? `Accepts returns${x.days ? ` within ${x.days} days` : ''}` : 'No returns',
              })),
              'Optional.')}
          </div>

          <div className="section-title">What Etsy has right now</div>
          <dl className="kv">
            <dt>Title</dt><dd className="small dim">{draft.etsy.title || '—'}</dd>
            <dt>Price</dt><dd className="small dim">{draft.etsy.price != null ? fmtMoney(draft.etsy.price, 'USD') : '—'}</dd>
            <dt>State</dt><dd className="small dim">{draft.etsyState}</dd>
          </dl>
        </>
      )}
    </Drawer>
  );
}

/**
 * Wiring the Taobao/1688 app's "Etsy'e ekle" button to this one.
 *
 * Everything the other app needs is here to copy: the address to post to, the
 * pairing key, and a snippet in three languages. There is also a folder it can
 * write a file into, for the case where the button cannot make an HTTP request.
 *
 * The key matters. The server listens on localhost, but so does every page in
 * your browser, and a web page can post to localhost - without a key, a site
 * you happened to have open could drop products onto your desk.
 */
function ConnectProductStudio({ open, onClose, onImported }) {
  const [tab, setTab] = useState('setup');
  const [sample, setSample] = useState('');
  const [read, setRead] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const { data: contract, reload } = useAsync(
    () => (open ? api.get('/integrations/product-studio') : null), [open], { immediate: open });

  if (!open) return null;

  const newKey = async () => {
    if (!confirm('Make a new key? Product Studio will stop working until you paste the new one in.')) return;
    try { await api.post('/integrations/product-studio/key', {}); reload(); toast({ kind: 'ok', title: 'New key made' }); }
    catch (err) { showError(err); }
  };

  const scan = async () => {
    setBusy(true);
    try {
      const r = await api.post('/integrations/product-studio/scan', {});
      toast({
        kind: r.created ? 'ok' : 'warn',
        title: r.created ? `${r.created} product(s) came in` : 'Nothing in the folder',
        body: r.failed ? `${r.failed} file(s) could not be read; they were moved to "failed".` : undefined,
      });
      onImported();
    } catch (err) { showError(err, 'Could not read the folder'); } finally { setBusy(false); }
  };

  /** Try a real payload without creating anything, to check the mapping. */
  const tryIt = async () => {
    setBusy(true);
    try {
      let parsed;
      try { parsed = JSON.parse(sample); }
      catch { toast({ kind: 'warn', title: 'That is not valid JSON' }); return; }
      setRead(await api.post(`/integrations/product-studio/dry-run?key=${encodeURIComponent(contract.key)}`, parsed));
    } catch (err) { showError(err, 'Could not read that'); } finally { setBusy(false); }
  };

  const Line = ({ label, value, mono = true }) => (
    <div className="field">
      <label>{label}</label>
      <div className="flex gap4">
        <input className={`input ${mono ? 'mono' : ''}`} readOnly value={value ?? ''} onFocus={(e) => e.target.select()} />
        <CopyButton text={value ?? ''} label="⧉" className="btn xs ghost" />
      </div>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} lg title="Connect Product Studio">
      <Tabs
        active={tab} onChange={setTab}
        tabs={[
          { id: 'setup', label: 'Set it up' },
          { id: 'fields', label: 'Field names' },
          { id: 'test', label: 'Try a payload' },
          { id: 'folder', label: 'Without code' },
        ]}
      />

      {!contract ? <Spinner /> : (
        <>
          {tab === 'setup' && (
            <>
              <Banner kind="info">
                Make the &ldquo;Etsy&rsquo;e ekle&rdquo; button post the product to the address below. It arrives
                here as a draft — it never goes to Etsy on its own, you finish it and press Send.
              </Banner>
              <Line label="Post to this address" value={contract.url} />
              <Line label="Send this header" value={`X-Product-Studio-Key: ${contract.key}`} />
              <div className="flex gap4 mb16">
                <button className="btn xs ghost" onClick={newKey}>Make a new key</button>
                <span className="small dim">Only needed if the key has leaked.</span>
              </div>

              <div className="section-title">Paste this into Product Studio</div>
              {Object.entries(contract.snippets).map(([lang, code]) => (
                <div className="field" key={lang}>
                  <label>{lang}<CopyButton text={code} label="Copy" className="btn xs ghost" /></label>
                  <pre className="copy-block mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{code}</pre>
                </div>
              ))}

              <Banner kind="ok">
                Only <span className="mono">title</span> and <span className="mono">url</span> are required.
                Everything else just makes the draft more complete.
              </Banner>
            </>
          )}

          {tab === 'fields' && (
            <>
              <p className="dim small">
                Send the product in whatever shape Product Studio already uses. For each row below, the first
                name it finds with a value wins — so you probably do not have to change anything over there.
              </p>
              <table className="data">
                <thead><tr><th>This app wants</th><th>and accepts any of these names</th></tr></thead>
                <tbody>
                  {Object.entries(contract.accepts).map(([field, names]) => (
                    <tr key={field}>
                      <td className="mono small">
                        {field}
                        {contract.required.includes(field) && <span className="badge red" style={{ marginLeft: 6 }}>required</span>}
                      </td>
                      <td className="small dim cell-wrap">{names.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {tab === 'test' && (
            <>
              <p className="dim small">
                Paste one real product exactly as Product Studio would send it. This shows how each field was
                understood and creates nothing, so it is safe to try as often as you like.
              </p>
              <div className="flex gap4 mb8">
                <button className="btn xs ghost" onClick={() => setSample(JSON.stringify(contract.example, null, 2))}>
                  Fill in an example
                </button>
              </div>
              <textarea className="textarea mono" rows={10} value={sample} onChange={(e) => setSample(e.target.value)}
                        placeholder='{ "title": "…", "url": "https://item.taobao.com/item.htm?id=…" }' />
              <button className="btn primary mt8" onClick={tryIt} disabled={busy || !sample.trim()}>
                {busy ? <Spinner /> : 'Read it'}
              </button>

              {read && (
                <>
                  <Banner kind={read.missing?.length ? 'warn' : 'ok'}>
                    {read.missing?.length
                      ? `This would be refused: it still needs ${read.missing.join(', ')}.`
                      : 'This would work. Every required field was found.'}
                  </Banner>
                  <table className="data">
                    <thead><tr><th>Field</th><th>Read from</th><th>Value</th></tr></thead>
                    <tbody>
                      {Object.entries(read.product ?? {}).filter(([, v]) =>
                        v !== null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => (
                        <tr key={k}>
                          <td className="mono small">{k}</td>
                          <td className="small dim mono">{read.mapping?.[k] ?? '—'}</td>
                          <td className="small cell-wrap">
                            {Array.isArray(v) ? `${v.length} item(s)` : String(v).slice(0, 80)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {read.ignored?.length > 0 && (
                    <div className="hint">
                      Not used: <span className="mono">{read.ignored.join(', ')}</span>. If one of those is
                      something you need, tell me the name and it can be added.
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {tab === 'folder' && (
            <>
              <Banner kind="info">
                If the button cannot make an HTTP request, have it save the same JSON as a file into this
                folder instead. One product per file, or a list of them in one file.
              </Banner>
              <Line label="Drop folder" value={contract.dropFolder} />
              <button className="btn primary" onClick={scan} disabled={busy}>
                {busy ? <Spinner /> : '↧'} Read the folder now
              </button>
              <div className="hint">
                Files that are read are moved into <span className="mono">done</span>, and ones that could not be
                read into <span className="mono">failed</span>, so nothing is picked up twice or lost quietly.
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Making a processing profile without leaving for the seller dashboard.
 *
 * Etsy's rejection names the missing field but not how to get one, which is the
 * kind of error that costs half an hour. Two numbers is all it needs.
 */
function MakeProcessingProfile({ onMade }) {
  const [minDays, setMinDays] = useState(1);
  const [maxDays, setMaxDays] = useState(3);
  const [state, setState] = useState('made_to_order');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const make = async () => {
    setBusy(true);
    try {
      const r = await api.post('/drafts/choices/processing-profile', {
        minDays: Number(minDays), maxDays: Number(maxDays), readinessState: state,
      });
      toast({ kind: 'ok', title: 'Processing profile created', body: `Dispatch in ${minDays}–${maxDays} days.` });
      onMade(r.id);
    } catch (err) { showError(err, 'Etsy would not create it'); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="split3">
        <div className="field">
          <label>Dispatch in, at least</label>
          <input className="input" type="number" min="1" value={minDays} onChange={(e) => setMinDays(e.target.value)} />
        </div>
        <div className="field">
          <label>at most (days)</label>
          <input className="input" type="number" min="1" value={maxDays} onChange={(e) => setMaxDays(e.target.value)} />
        </div>
        <div className="field">
          <label>Kind</label>
          <select className="select" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="made_to_order">Made to order</option>
            <option value="ready_to_ship">Ready to ship</option>
          </select>
        </div>
      </div>
      <button className="btn primary" onClick={make} disabled={busy}>
        {busy ? <Spinner /> : 'Create it and use it'}
      </button>
      <div className="hint">This is made on Etsy and can be reused by every listing afterwards.</div>
    </div>
  );
}
