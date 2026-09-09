import React, { useState } from 'react';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Drawer, Thumb, useAsync, useToast, useErrorToast, fmtMoney, fmtAgo,
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
            {field('shipping_profile_id', 'Shipping profile id', { type: 'number' })}
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
