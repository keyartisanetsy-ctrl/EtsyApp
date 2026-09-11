import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Drawer, Modal, Thumb, CopyButton, Tabs,
  useAsync, useToast, useErrorToast, fmtMoney, fmtAgo,
} from '../components/ui.jsx';
import { CategoryPicker } from './NewListing.jsx';

const WHEN_MADE = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007'];

// A helpful starting list for the materials picker. Etsy's materials field is
// free text (any string of letters/numbers/spaces is valid), not a fixed
// vocabulary the API exposes, so this is a search aid, not a wall - typing
// something not in it and adding it anyway works too.
const MAX_MATERIALS = 5;
const COMMON_MATERIALS = [
  'Abacá', 'Abalone shell', 'ABS', 'Acacia', 'Acrylic', 'Alabaster', 'Alpaca', 'Aluminum',
  'Amber', 'Amethyst', 'Bamboo', 'Bone', 'Brass', 'Bronze', 'Burlap', 'Canvas', 'Cardboard',
  'Cashmere', 'Cedar', 'Ceramic', 'Chiffon', 'Clay', 'Concrete', 'Copper', 'Cork', 'Cotton',
  'Crystal', 'Denim', 'Diamond', 'Ebony', 'Enamel', 'Faux fur', 'Faux leather', 'Felt', 'Fiberglass',
  'Foam', 'Glass', 'Glitter', 'Gold', 'Gold filled', 'Gold plated', 'Granite', 'Hemp', 'Iron',
  'Jute', 'Lace', 'Latex', 'Leather', 'Linen', 'Mahogany', 'Marble', 'Mesh', 'Metal', 'Mother of pearl',
  'MDF', 'Mylar', 'Nylon', 'Oak', 'Onyx', 'Paint', 'Paper', 'Papier mâché', 'Pearl', 'Pewter',
  'Pine', 'Plastic', 'Platinum', 'Plywood', 'Polyester', 'Porcelain', 'Quartz', 'Rattan', 'Rayon',
  'Resin', 'Rhinestone', 'Rose gold', 'Rubber', 'Satin', 'Sequin', 'Silicone', 'Silk', 'Silver',
  'Slate', 'Spandex', 'Sponge', 'Stainless steel', 'Stone', 'Suede', 'Sterling silver', 'Straw',
  'Suede leather', 'Tin', 'Titanium', 'Tulle', 'Turquoise', 'Velvet', 'Vinyl', 'Walnut', 'Wax',
  'Wicker', 'Wire', 'Wood', 'Wool', 'Yarn', 'Zinc',
];

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
          <button className="btn sm" onClick={() => setConnectOpen(true)}>🔗 Connect an outside app</button>
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

      <DraftEditor key={open} id={open} onClose={() => setOpen(null)} onChanged={reload} />
      <ConnectProductStudio open={connectOpen} onClose={() => setConnectOpen(false)} onImported={reload} />
    </TablePage>
  );
}

function DraftEditor({ id, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [revertTick, setRevertTick] = useState(0);
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
    <Field
      key={name}
      name={name}
      label={label}
      value={merged[name]}
      changed={isChanged(name)}
      etsyValue={draft.etsy[name]}
      save={save}
      {...props}
    />
  );

  return (
    <Drawer
      open onClose={onClose} wide
      title={draft ? (draft.isLocalOnly ? 'New draft' : `Draft ${draft.listingId}`) : 'Draft'}
      footer={draft && (
        <>
          <button className="btn" onClick={async () => {
            await api.post(`/drafts/${id}/revert`, {});
            await reload(); await replan(); onChanged();
            // Every field below keeps its own typed-but-not-yet-saved buffer,
            // so a plain reload() would not visibly undo anything on screen.
            // Bumping this remounts them all, reseeded from what Etsy has.
            setRevertTick((t) => t + 1);
          }}>
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
        // Keyed so "Drop my edits" can force every field below to forget
        // whatever was typed and reseed from what Etsy actually has.
        <div key={revertTick}>
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

          <div className="section-title">Photos &amp; video</div>
          <MediaManager draft={draft} onChanged={() => { reload(); replan(); onChanged(); }} />

          <div className="section-title">Listing</div>
          {field('title', 'Title', { hint: `${(merged.title ?? '').length} of 140 characters` })}
          {field('description', 'Description', { textarea: true, rows: 8 })}
          <div className="split">
            {field('price', 'Price', { type: 'number', step: '0.01' })}
            {field('quantity', 'Stock', { type: 'number', min: 1, max: 999, hint: 'Etsy allows a quantity from 1 to 999.' })}
          </div>
          {field('tags', 'Tags', { hint: 'Comma separated, up to 13, each at most 20 characters' })}
          <MaterialsPicker value={merged.materials ?? []} changed={isChanged('materials')}
                           onChange={(materials) => save({ materials })} />

          <div className="section-title">
            Etsy needs these
            {isChanged('taxonomy_id') && <span className="badge amber" style={{ marginLeft: 6 }}>category changed</span>}
            {isChanged('attributes') && <span className="badge amber" style={{ marginLeft: 6 }}>attributes changed</span>}
          </div>
          <CategoryPicker
            value={merged.taxonomy_id ?? ''}
            onPick={(taxonomy_id) => save({ taxonomy_id: taxonomy_id === '' ? null : Number(taxonomy_id) })}
            attributes={merged.attributes ?? {}}
            onAttributes={(attributes) => save({ attributes })}
          />
          <div className="split">
            {field('who_made', 'Who made it', { options: ['i_did', 'someone_else', 'collective'] })}
            {field('when_made', 'When was it made', { options: WHEN_MADE })}
          </div>
          {pick('shipping_profile_id', 'Shipping delivery profile',
            (choices?.shippingProfiles ?? []).map((p) => ({
              value: p.id, label: `${p.title}${p.processing ? ` · ${p.processing}` : ''}`,
            })),
            'Where you post from and what you charge.')}

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

          <div className="section-title">Settings</div>
          <div className="field">
            <label>
              Renewal
              {isChanged('should_auto_renew') && <span className="badge amber" style={{ marginLeft: 6 }}>changed</span>}
            </label>
            <div className="flex gap12">
              <label className="flex gap4" style={{ alignItems: 'center' }}>
                <input type="radio" checked={merged.should_auto_renew !== false}
                       onChange={() => save({ should_auto_renew: true })} />
                Automatic — renews for $0.20 when it expires
              </label>
              <label className="flex gap4" style={{ alignItems: 'center' }}>
                <input type="radio" checked={merged.should_auto_renew === false}
                       onChange={() => save({ should_auto_renew: false })} />
                Manual
              </label>
            </div>
          </div>
          {!draft.isLocalOnly && field('featured_rank', 'Feature this listing', {
            type: 'number', min: 1, clearAs: null,
            hint: 'Optional. Position in your shop’s featured row — 1 is left-most.',
          })}

          <div className="section-title">What Etsy has right now</div>
          <dl className="kv">
            <dt>Title</dt><dd className="small dim">{draft.etsy.title || '—'}</dd>
            <dt>Price</dt><dd className="small dim">{draft.etsy.price != null ? fmtMoney(draft.etsy.price, 'USD') : '—'}</dd>
            <dt>State</dt><dd className="small dim">{draft.etsyState}</dd>
          </dl>
        </div>
      )}
    </Drawer>
  );
}

/**
 * One text/number/textarea field on the desk.
 *
 * Every keystroke used to save straight to the server and reload the whole
 * draft, so two overlapping round trips could land out of order and shove an
 * older value back into the box mid-type — the "can't add or remove the
 * numbers" bug. Typing now only ever touches local state; the network save
 * is debounced and fires once, well after you stop.
 */
function Field({ name, label, value, changed, etsyValue, save, textarea, rows, options, type, step, min, max, hint, clearAs }) {
  const [local, setLocal] = useState(() => (Array.isArray(value) ? value.join(', ') : value ?? ''));
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const toSave = (v) => (v === '' && clearAs !== undefined ? clearAs : v);

  const onType = (v) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save({ [name]: toSave(v) }), 500);
  };

  const onSelect = (v) => {
    setLocal(v);
    clearTimeout(timer.current);
    save({ [name]: toSave(v) });
  };

  return (
    <div className="field">
      <label>
        {label}
        {changed && (
          <span className="badge amber" style={{ marginLeft: 6 }} title={`Etsy still has: ${etsyValue ?? '(empty)'}`}>
            changed
          </span>
        )}
      </label>
      {textarea
        ? <textarea className="textarea" rows={rows ?? 6} value={local} onChange={(e) => onType(e.target.value)} />
        : options
          ? <select className="select" value={local} onChange={(e) => onSelect(e.target.value)}>
              <option value="">—</option>
              {options.map((o) => <option key={o} value={o}>{String(o).replace(/_/g, ' ')}</option>)}
            </select>
          : <input className="input" type={type ?? 'text'} step={step} min={min} max={max}
                   value={local} onChange={(e) => onType(e.target.value)} />}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/**
 * Etsy's own listing screen offers materials as a search-and-tick list capped
 * at five. The field itself is free text on Etsy's side (any letters, numbers
 * and spaces), not a fixed vocabulary the API hands back, so this ships a
 * useful starting list and still lets you add something not on it.
 */
function MaterialsPicker({ value, changed, onChange }) {
  const [q, setQ] = useState('');
  const selected = value ?? [];
  const atLimit = selected.length >= MAX_MATERIALS;

  const matches = q.trim()
    ? COMMON_MATERIALS.filter((m) => m.toLowerCase().includes(q.trim().toLowerCase()) && !selected.includes(m)).slice(0, 8)
    : [];
  const exact = COMMON_MATERIALS.some((m) => m.toLowerCase() === q.trim().toLowerCase());
  const validCustom = /^[\p{L}\p{Nd}\s]+$/u.test(q.trim());

  const add = (m) => {
    if (atLimit || selected.includes(m)) return;
    onChange([...selected, m]);
    setQ('');
  };
  const removeAt = (m) => onChange(selected.filter((x) => x !== m));

  return (
    <div className="field">
      <label>
        Materials
        {changed && <span className="badge amber" style={{ marginLeft: 6 }}>changed</span>}
      </label>
      <div className="flex gap4 mb4" style={{ flexWrap: 'wrap' }}>
        {selected.map((m) => (
          <span key={m} className="badge grey flex gap4" style={{ alignItems: 'center' }}>
            {m}
            <button type="button" className="btn xs ghost" style={{ padding: '0 3px' }}
                    onClick={() => removeAt(m)} aria-label={`Remove ${m}`}>×</button>
          </span>
        ))}
      </div>
      {atLimit ? (
        <div className="hint">Up to {MAX_MATERIALS} materials, same as Etsy&rsquo;s own listing form. Remove one to add another.</div>
      ) : (
        <>
          <input className="input" placeholder="Type to search…" value={q} onChange={(e) => setQ(e.target.value)} />
          {(matches.length > 0 || (q.trim() && !exact)) && (
            <div className="card" style={{ marginTop: 4, padding: 4, maxHeight: 180, overflowY: 'auto' }}>
              {matches.map((m) => (
                <div key={m} onClick={() => add(m)} style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 4 }}>{m}</div>
              ))}
              {q.trim() && !exact && validCustom && (
                <div className="small dim" onClick={() => add(q.trim())} style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 4 }}>
                  Add &ldquo;{q.trim()}&rdquo;
                </div>
              )}
            </div>
          )}
          <div className="hint">Select up to {MAX_MATERIALS}.</div>
        </>
      )}
    </div>
  );
}

/**
 * Photos and a video for the draft. A local-only draft has no listing_id yet
 * -- every Etsy image/video endpoint needs one -- so what is added here is
 * staged and only goes up once the draft is sent; a draft that already is a
 * real Etsy listing uploads straight away, same as anywhere else in the app.
 */
function MediaManager({ draft, onChanged }) {
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const local = draft.isLocalOnly;
  const listingId = draft.listingId;

  const images = local ? (draft.pendingMedia?.images ?? []) : draft.images.map((i) => ({ id: i.imageId, url: i.thumb || i.url }));
  const videos = local ? (draft.pendingMedia?.videos ?? []) : draft.videos.map((v) => ({ id: v.videoId, url: v.thumb || v.url }));
  const maxImages = draft.pendingMedia?.maxImages ?? 20;
  const maxVideos = draft.pendingMedia?.maxVideos ?? 2;

  const addUrl = async (kind) => {
    const url = prompt(kind === 'image' ? 'Paste the image URL' : 'Paste the video URL');
    if (!url) return;
    setBusy(true);
    try {
      await api.post(`/drafts/${listingId}/media`, { kind, url });
      onChanged();
    } catch (err) { showError(err, 'Could not add that'); } finally { setBusy(false); }
  };

  const addFile = async (kind, file) => {
    setBusy(true);
    try {
      const form = new FormData();
      if (local) {
        form.append('file', file);
        form.append('kind', kind);
        await api.upload(`/drafts/${listingId}/media/upload`, form);
      } else {
        // The general listing image/video endpoints name the field after
        // what it is, not generically "file".
        form.append(kind, file);
        await api.upload(`/listings/${listingId}/${kind === 'image' ? 'images' : 'videos'}`, form);
        await api.post(`/drafts/${listingId}/resync`, {});
      }
      onChanged();
    } catch (err) { showError(err, 'Could not upload that'); } finally { setBusy(false); }
  };

  const remove = async (kind, mediaId) => {
    setBusy(true);
    try {
      if (local) {
        await api.del(`/drafts/${listingId}/media/${mediaId}`);
      } else {
        await api.del(`/listings/${listingId}/${kind === 'image' ? 'images' : 'videos'}/${mediaId}`);
        await api.post(`/drafts/${listingId}/resync`, {});
      }
      onChanged();
    } catch (err) { showError(err, 'Could not remove that'); } finally { setBusy(false); }
  };

  const Row = ({ kind, items, max }) => (
    <div className="mb16">
      <div className="flex gap4" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="small dim">{kind === 'image' ? 'Images' : 'Video'} — {items.length} of {max}</span>
        <div className="flex gap4">
          <button className="btn xs ghost" disabled={busy || items.length >= max} onClick={() => addUrl(kind)}>+ By URL</button>
          <label className="btn xs ghost" style={{ cursor: items.length >= max ? 'not-allowed' : 'pointer', opacity: items.length >= max ? 0.5 : 1 }}>
            + Upload
            <input type="file" accept={kind === 'image' ? 'image/*' : 'video/*'} style={{ display: 'none' }}
                   disabled={busy || items.length >= max}
                   onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) addFile(kind, f); }} />
          </label>
        </div>
      </div>
      {items.length > 0 && (
        <div className="flex gap4 mt8" style={{ flexWrap: 'wrap' }}>
          {items.map((it) => (
            <div key={it.id} style={{ position: 'relative' }}>
              {kind === 'image'
                ? <Thumb src={it.url} size="lg" />
                : <video src={it.url} muted style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, background: '#000' }} />}
              <button type="button" className="btn xs" disabled={busy}
                      style={{ position: 'absolute', top: -6, right: -6, borderRadius: '50%', padding: '0 6px' }}
                      onClick={() => remove(kind, it.id)} aria-label="Remove">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="mb16">
      {local && (
        <div className="hint mb8">
          Staged here — these upload to Etsy the moment this draft is sent. A second video slot is offered, but
          Etsy&rsquo;s own listing page describes holding a single video, so it may refuse the second one.
        </div>
      )}
      <Row kind="image" items={images} max={maxImages} />
      <Row kind="video" items={videos} max={maxVideos} />
    </div>
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
    if (!confirm('Make a new key? Every app using the old one will stop working until you paste the new one in.')) return;
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
    <Modal open={open} onClose={onClose} lg title="Connect an outside app">
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
                Any app you have — Product Studio, a Shopify tool, anything else — can use this same address. Give
                its &ldquo;send to Etsy&rdquo; button this URL and key; every product it posts arrives here as a
                draft. It never goes to Etsy on its own, you finish it and press Send.
              </Banner>
              <Line label="Post to this address" value={contract.url} />
              <Line label="Send this header" value={`X-Product-Studio-Key: ${contract.key}`} />
              <div className="flex gap4 mb16">
                <button className="btn xs ghost" onClick={newKey}>Make a new key</button>
                <span className="small dim">Only needed if the key has leaked. One key works for every app.</span>
              </div>

              <div className="section-title">Paste this into the other app (or hand it to whoever is building it)</div>
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
                Send the product in whatever shape the other app already uses. For each row below, the first
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
                Paste one real product exactly as the other app would send it. This shows how each field was
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
export function MakeProcessingProfile({ onMade }) {
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
