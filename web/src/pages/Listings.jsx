import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import Pictures from '../components/Pictures.jsx';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Pager, SortTh, Drawer, Modal, Thumb, CopyButton,
  useAsync, useDebounced, useToast, useErrorToast, fmtMoney, fmtDate, STATE_BADGE, DecimalInput,
} from '../components/ui.jsx';
import { CategoryPicker } from './NewListing.jsx';

const LIMIT = 50;
const STATES = ['active', 'inactive', 'draft', 'expired', 'sold_out'];
const WHO_MADE = ['i_did', 'someone_else', 'collective'];
const WHEN_MADE = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007',
  '2000_2006', '1990s', '1980s', '1970s', '1960s', '1950s', '1940s', '1930s', '1920s', '1910s',
  '1900s', '1800s', '1700s', 'before_1700'];
const LISTING_TYPES = ['physical', 'download', 'both'];
const WEIGHT_UNITS = ['oz', 'lb', 'g', 'kg'];
const DIMENSION_UNITS = ['in', 'ft', 'mm', 'cm', 'm', 'yd', 'inches'];

export default function Listings() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [state, setState] = useState(params.get('state') ?? '');
  const [missingImages, setMissingImages] = useState(false);
  const [sort, setSort] = useState('updated');
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [detailId, setDetailId] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  const nav = useNavigate();
  const toast = useToast();
  const showError = useErrorToast();

  // Create listing hands over a link straight to the listing it just made,
  // so it can be opened here to add more photos without hunting for it.
  useEffect(() => {
    const wanted = params.get('open');
    if (!wanted) return;
    setDetailId(Number(wanted));
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const query = useMemo(() => ({ search: debounced, state, missingImages: missingImages || undefined, sort, dir, limit: LIMIT, offset }),
    [debounced, state, missingImages, sort, dir, offset]);
  const { data, loading, error, reload } = useAsync(() => api.get('/listings', query), [query]);

  const rows = data?.rows ?? [];
  const counts = data?.countsByState ?? {};

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.listingId));
  const allMatchingSelected = data?.total > 0 && selected.size === data.total;

  /** Every listing matching the current filters, not just this page -- for
   *  "select all 158", not just the 50 on screen. */
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const all = await api.get('/listings', { ...query, limit: 5000, offset: 0 });
      setSelected(new Set((all.rows ?? []).map((r) => r.listingId)));
    } catch (err) { showError(err, 'Could not select every matching listing'); } finally { setSelectingAll(false); }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncListings({ withInventory: true });
      const failed = r.errors?.length ?? 0;
      toast({
        kind: failed ? 'warn' : 'ok',
        title: 'Listings synced',
        body: failed
          ? `${r.listings} listings, ${r.products} variations — ${failed} listing(s) could not be read, so their photos/variants may be missing: ${r.errors.slice(0, 3).map((e) => `#${e.listingId} (${e.message})`).join('; ')}${failed > 3 ? '…' : ''}`
          : `${r.listings} listings, ${r.products} variations`,
      });
      reload();
    } catch (err) { showError(err, 'Sync failed'); } finally { setSyncing(false); }
  };

  const quickAction = async (type) => {
    const targets = [...selected];
    if (type === 'listing.delete' && !confirm(`Permanently delete ${targets.length} listing(s) on Etsy? This cannot be undone.`)) return;
    try {
      const job = await api.post('/bulk/jobs', { type, targets });
      toast({ kind: 'ok', title: 'Bulk job started', body: `${job.total} listing(s) — track it under Bulk jobs` });
      setSelected(new Set());
      setTimeout(reload, 2500);
    } catch (err) { showError(err, 'Bulk action failed'); }
  };

  const exportXlsx = async () => {
    const r = await api.post('/exports/listings', { state });
    window.location.href = `/api/exports/download/${encodeURIComponent(r.filename)}`;
  };

  return (
    <TablePage
      title="Listings"
      subtitle={STATES.map((s) => `${counts[s] ?? 0} ${s}`).join(' · ')}
      actions={
        <>
          <button className="btn sm" onClick={exportXlsx}>⤓ Excel</button>
          <button className="btn sm" onClick={sync} disabled={syncing}>{syncing ? <Spinner /> : '↻'} Sync</button>
          <button className="btn sm primary" onClick={() => nav('/listings/new')}>＋ New listing</button>
        </>
      }
      toolbar={
        <>
          <input className="input search" placeholder="Search title, tags, description or id…"
                 value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
          <select className="select" value={state} onChange={(e) => { setState(e.target.value); setOffset(0); }}>
            <option value="">All states ({data?.total ?? 0})</option>
            {STATES.map((s) => <option key={s} value={s}>{s} ({counts[s] ?? 0})</option>)}
          </select>
          <Checkbox checked={missingImages} onChange={(v) => { setMissingImages(v); setOffset(0); }} label="Missing photos" />
          <div className="spacer" />
          <span className="small muted">−{data?.discountPercent ?? 30}% column shows the sale price</span>
        </>
      }
      selection={selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected</span>
          {allSelected && !allMatchingSelected && data?.total > rows.length && (
            <button className="btn xs ghost" onClick={selectAllMatching} disabled={selectingAll}>
              {selectingAll ? <Spinner /> : `Select all ${data.total} matching`}
            </button>
          )}
          <button className="btn xs" onClick={() => quickAction('listing.activate')}>Activate</button>
          <button className="btn xs" onClick={() => quickAction('listing.deactivate')}>Deactivate</button>
          <button className="btn xs" title="Ask Etsy again for each selected listing's photos -- fixes a blank thumbnail here"
                  onClick={() => quickAction('listing.refresh_images')}>Fetch photos</button>
          <button className="btn xs" onClick={() => setBulkOpen(true)}>More actions…</button>
          <button className="btn xs danger" onClick={() => quickAction('listing.delete')}>Delete</button>
          <div className="spacer" />
          <button className="btn xs ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      pager={<Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />}
    >
      {error && <div style={{ padding: 16 }}><Banner kind="err">{error.message}</Banner></div>}

      {loading && !data ? <div className="empty"><Spinner /></div>
        : rows.length === 0 ? (
          <Empty icon="▤" title="No listings">Press Sync to pull your catalogue from Etsy.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th className="col-tight"><Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected}
                                                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.listingId)))} /></th>
                <th className="col-tight" />
                <SortTh label="Title" field="title" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} />
                <th>State</th>
                <SortTh label="Price" field="price" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} className="right" />
                <th className="right">−{data?.discountPercent ?? 30}%</th>
                <SortTh label="Stock" field="quantity" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} className="right" />
                <th className="right">Vars</th>
                <SortTh label="Views" field="views" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} className="right" />
                <SortTh label="Favs" field="favorers" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} className="right" />
                <th>Tags</th>
                <SortTh label="Updated" field="updated" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} />
                <th className="col-tight" />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.listingId} className={selected.has(l.listingId) ? 'selected' : ''}>
                  <td><Checkbox checked={selected.has(l.listingId)} onChange={() => toggle(l.listingId)} /></td>
                  <td><Thumb src={l.firstImageUrl} /></td>
                  <td className="cell-title" title={l.title}>
                    <a href={l.url} target="_blank" rel="noreferrer">{l.title}</a>
                    <div className="small muted mono">{l.listingId}</div>
                  </td>
                  <td><span className={`badge ${STATE_BADGE[l.state] ?? 'grey'}`}>{l.state}</span></td>
                  <td className="num">{fmtMoney(l.price, l.currency)}</td>
                  <td className="num"><span className="badge orange">{l.priceDiscounted?.toFixed(2) ?? '—'}</span></td>
                  <td className="num">{l.quantity ?? '—'}</td>
                  <td className="num">
                    {l.variationCount}
                    {l.missingSkuCount > 0 && <span className="badge red" style={{ marginLeft: 4 }} title="variations without a SKU">{l.missingSkuCount}</span>}
                  </td>
                  <td className="num">{l.views ?? '—'}</td>
                  <td className="num">{l.favorers ?? '—'}</td>
                  <td className="small">
                    <span className={l.tags.length < 13 ? 'badge amber' : 'badge grey'}>{l.tags.length}/13</span>
                  </td>
                  <td className="small muted">{fmtDate(l.updatedTs)}</td>
                  <td><button className="btn xs" onClick={() => setDetailId(l.listingId)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <ListingDetail id={detailId} onClose={() => setDetailId(null)} onChanged={reload} />
      <BulkListingModal open={bulkOpen} onClose={() => setBulkOpen(false)} targets={[...selected]}
                        onDone={() => { setBulkOpen(false); setSelected(new Set()); setTimeout(reload, 2000); }} />
    </TablePage>
  );
}

/**
 * Add/remove photos and video directly on an already-published listing.
 *
 * Etsy's own admin only shows drafts and inactive listings on the desk
 * (drafts.js's pull only ever asks for those states), so an active listing's
 * photos had nowhere to be added from at all before this -- Pictures.jsx is
 * read-only by design. Shows a picked file immediately, the same way the
 * draft desk's media manager does, instead of leaving the screen blank until
 * the upload round-trips.
 */
function ListingMedia({ listingId, images, videos, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState([]); // { id, kind, previewUrl }
  const showError = useErrorToast();
  const toast = useToast();

  const addFile = async (kind, file) => {
    setBusy(true);
    const previewUrl = URL.createObjectURL(file);
    const tempId = `pending-${Date.now()}-${Math.random()}`;
    setPending((p) => [...p, { id: tempId, kind, previewUrl }]);
    try {
      const form = new FormData();
      form.append(kind, file);
      await api.upload(`/listings/${listingId}/${kind === 'image' ? 'images' : 'videos'}`, form);
      await onChanged();
    } catch (err) { showError(err, 'Could not upload that'); } finally {
      setBusy(false);
      setPending((p) => p.filter((x) => x.id !== tempId));
      URL.revokeObjectURL(previewUrl);
    }
  };

  const addFiles = async (kind, files, max) => {
    const have = (kind === 'image' ? images.length : videos.length) + pending.filter((p) => p.kind === kind).length;
    const room = Math.max(0, max - have);
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      toast({
        kind: 'warn',
        title: `Etsy allows ${max} ${kind === 'image' ? 'images' : 'video(s)'} per listing`,
        body: accepted.length
          ? `Added the first ${accepted.length} of ${files.length} picked; the rest were left out.`
          : `Already at ${max} of ${max} -- none of the ${files.length} picked were added.`,
      });
    }
    for (const file of accepted) await addFile(kind, file);
  };

  const remove = async (kind, mediaId) => {
    setBusy(true);
    try {
      await api.del(`/listings/${listingId}/${kind === 'image' ? 'images' : 'videos'}/${mediaId}`);
      onChanged();
    } catch (err) { showError(err, 'Could not remove that'); } finally { setBusy(false); }
  };

  const Row = ({ kind, items, max }) => {
    const kindPending = pending.filter((p) => p.kind === kind);
    const count = items.length + kindPending.length;
    return (
      <div className="mb16">
        <div className="flex gap4" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="small dim">{kind === 'image' ? 'Images' : 'Video'} — {count} of {max}</span>
          <label className="btn xs ghost" style={{ cursor: count >= max ? 'not-allowed' : 'pointer', opacity: count >= max ? 0.5 : 1 }}>
            + Upload
            <input type="file" accept={kind === 'image' ? 'image/*' : 'video/*'} multiple style={{ display: 'none' }}
                   disabled={busy || count >= max}
                   onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) addFiles(kind, files, max); }} />
          </label>
        </div>
        {count > 0 && (
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
            {kindPending.map((p) => (
              <div key={p.id} style={{ position: 'relative' }}>
                {kind === 'image'
                  ? <Thumb src={p.previewUrl} size="lg" />
                  : <video src={p.previewUrl} muted style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6, background: '#000' }} />}
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,0.35)', borderRadius: 6,
                }}>
                  <Spinner />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mb16">
      <Row kind="image" items={images} max={20} />
      <Row kind="video" items={videos} max={2} />
    </div>
  );
}

function ListingDetail({ id, onClose, onChanged }) {
  const { data, loading, reload } = useAsync(() => (id ? api.get(`/listings/${id}`) : null), [id], { immediate: !!id });
  // Etsy asks for these by numeric id; nobody knows them by heart -- same
  // shop-wide picker list the draft desk uses.
  const { data: choices } = useAsync(() => (id ? api.get('/drafts/choices') : null), [id], { immediate: !!id });
  const { data: properties } = useAsync(
    () => (id ? api.get(`/listings/${id}/properties`).catch(() => ({ results: [] })) : null), [id], { immediate: !!id });
  const { data: personalizationData } = useAsync(
    () => (id ? api.get(`/listings/${id}/personalization`).catch(() => ({ personalization_questions: [] })) : null),
    [id], { immediate: !!id });

  const [edit, setEdit] = useState({});
  // Category attributes, personalization and the processing profile are not
  // real ShopListing fields (see server/src/services/listings.js) -- each
  // has its own endpoint, applied only if actually touched here, alongside
  // whatever plain fields changed.
  const [attrPicked, setAttrPicked] = useState({});
  const [attrTouched, setAttrTouched] = useState(false);
  const [personalization, setPersonalization] = useState(null); // null = untouched
  const [readinessStateId, setReadinessStateId] = useState(null); // null = untouched
  const [confirm, setConfirm] = useState(null); // { body, extra } | null
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => {
    setEdit({}); setAttrTouched(false); setPersonalization(null); setReadinessStateId(null); setConfirm(null);
  }, [id]);

  // Prefill the category attribute picker from what Etsy actually has, the
  // moment it loads -- not touching it just shows the real values.
  React.useEffect(() => {
    if (!properties?.results) return;
    const map = {};
    for (const p of properties.results) {
      map[p.property_id] = (p.value_ids ?? []).map((valueId, i) => ({ valueId, name: p.values?.[i] ?? '' }));
    }
    setAttrPicked(map);
  }, [properties]);

  if (!id) return null;

  const existingQuestion = personalizationData?.personalization_questions?.[0];
  const pers = personalization ?? {
    isPersonalizable: data?.isPersonalizable ?? false,
    isRequired: existingQuestion?.required ?? false,
    charCountMax: existingQuestion?.max_allowed_characters ?? 256,
    instructions: existingQuestion?.instructions ?? '',
    questionText: existingQuestion?.question_text ?? 'Personalization',
  };

  const nothingToSend = !Object.keys(edit).length && !attrTouched && !personalization && readinessStateId == null;

  /** Etsy sees nothing yet -- this only asks the server to validate what
   *  plain fields would be sent, so the confirm step shows the real thing. */
  const reviewChanges = async () => {
    setBusy(true);
    try {
      let body = {};
      if (Object.keys(edit).length) {
        const raw = { ...edit };
        if (raw.tags) raw.tags = String(raw.tags).split(',').map((t) => t.trim()).filter(Boolean);
        if (raw.materials) raw.materials = String(raw.materials).split(',').map((t) => t.trim()).filter(Boolean);
        const res = await api.patch(`/listings/${id}?dryRun=true`, raw);
        body = res.body ?? {};
      }
      const extra = [];
      if (attrTouched) {
        const n = Object.values(attrPicked).filter((v) => v?.length).length;
        if (n) extra.push(`${n} category attribute(s)`);
      }
      if (personalization) {
        extra.push(personalization.isPersonalizable === false ? 'turn personalization off' : 'personalization question');
      }
      if (readinessStateId != null) extra.push('processing profile (applied to every variation)');
      if (!Object.keys(body).length && !extra.length) { toast({ kind: 'warn', title: 'Nothing has changed' }); return; }
      setConfirm({ body, extra });
    } catch (err) { showError(err, 'Etsy rejected the update'); } finally { setBusy(false); }
  };

  const applyConfirmed = async () => {
    setBusy(true);
    try {
      if (Object.keys(confirm.body).length) await api.patch(`/listings/${id}`, confirm.body);
      if (attrTouched) {
        for (const [propertyId, picked] of Object.entries(attrPicked)) {
          if (!picked?.length) continue;
          await api.put(`/listings/${id}/properties/${propertyId}`, {
            value_ids: picked.map((v) => v.valueId), values: picked.map((v) => v.name),
          });
        }
      }
      if (personalization) await api.post(`/listings/${id}/personalization`, personalization);
      if (readinessStateId != null) await api.post(`/listings/${id}/readiness-state`, { readinessStateId });
      toast({ kind: 'ok', title: 'Listing updated on Etsy' });
      setEdit({}); setAttrTouched(false); setPersonalization(null); setReadinessStateId(null); setConfirm(null);
      reload();
      onChanged();
    } catch (err) { showError(err, 'Etsy rejected the update'); } finally { setBusy(false); }
  };

  const setState = async (state) => {
    try {
      await api.post(`/listings/${id}/state`, { state });
      toast({ kind: 'ok', title: `Listing set to ${state}` });
      reload();
      onChanged();
    } catch (err) { showError(err, 'Could not change state'); }
  };

  return (
    <Drawer open onClose={onClose} wide title={data?.title ?? 'Listing'}
            footer={data && (
              <>
                <button className="btn primary" disabled={busy || nothingToSend} onClick={reviewChanges}>
                  {busy ? <Spinner /> : 'Review changes'}
                </button>
                {data.state === 'active'
                  ? <button className="btn" onClick={() => setState('inactive')}>Deactivate</button>
                  : <button className="btn" onClick={() => setState('active')}>Activate</button>}
                <div className="spacer" />
                <a className="btn sm" href={data.url} target="_blank" rel="noreferrer">View on Etsy ↗</a>
              </>
            )}>
      {loading || !data ? <Spinner /> : (
        <>
          <ListingMedia listingId={id} images={data.images} videos={data.videos} onChanged={async () => { await reload(); onChanged(); }} />

          <Pictures listingId={data.listingId ?? data.listing_id} />

          <div className="field">
            <label>Title <span className="muted">({(edit.title ?? data.title ?? '').length}/140)</span></label>
            <input className="input" value={edit.title ?? data.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          </div>

          <div className="field">
            <label>Description</label>
            <textarea className="textarea" rows={8} value={edit.description ?? data.description ?? ''}
                      onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          </div>

          <div className="field">
            <label>Tags <span className="muted">(max 13, each ≤20 chars)</span></label>
            <input className="input" value={edit.tags ?? data.tags.join(', ')} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
          </div>

          <div className="field">
            <label>Materials</label>
            <input className="input" value={edit.materials ?? data.materials.join(', ')} onChange={(e) => setEdit({ ...edit, materials: e.target.value })} />
          </div>

          <div className="section-title">Category</div>
          <CategoryPicker
            value={edit.taxonomy_id ?? data.taxonomyId ?? ''}
            onPick={(taxonomy_id) => setEdit({ ...edit, taxonomy_id: taxonomy_id === '' ? '' : Number(taxonomy_id) })}
            attributes={attrPicked}
            onAttributes={(a) => { setAttrPicked(a); setAttrTouched(true); }}
          />

          <div className="section-title">Made by</div>
          <div className="split">
            <div className="field">
              <label>Who made it</label>
              <select className="select" value={edit.who_made ?? data.whoMade ?? ''} onChange={(e) => setEdit({ ...edit, who_made: e.target.value })}>
                <option value="">—</option>
                {WHO_MADE.map((w) => <option key={w} value={w}>{w.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="field">
              <label>When was it made</label>
              <select className="select" value={edit.when_made ?? data.whenMade ?? ''} onChange={(e) => setEdit({ ...edit, when_made: e.target.value })}>
                <option value="">—</option>
                {WHEN_MADE.map((w) => <option key={w} value={w}>{w.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>
          <div className="split">
            <div className="field">
              <label>Listing type</label>
              <select className="select" value={edit.type ?? data.type ?? ''} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                <option value="">—</option>
                {LISTING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Supply or finished product</label>
              <div className="flex gap12">
                <label className="flex gap4" style={{ alignItems: 'center' }}>
                  <input type="radio" checked={(edit.is_supply ?? data.isSupply) === true} onChange={() => setEdit({ ...edit, is_supply: true })} /> Supply
                </label>
                <label className="flex gap4" style={{ alignItems: 'center' }}>
                  <input type="radio" checked={(edit.is_supply ?? data.isSupply) === false} onChange={() => setEdit({ ...edit, is_supply: false })} /> Finished product
                </label>
              </div>
            </div>
          </div>

          <div className="section-title">Shipping &amp; policies</div>
          <div className="split">
            <div className="field">
              <label>Shipping profile</label>
              <select className="select" value={edit.shipping_profile_id ?? data.shippingProfileId ?? ''}
                      onChange={(e) => setEdit({ ...edit, shipping_profile_id: e.target.value })}>
                <option value="">—</option>
                {(choices?.shippingProfiles ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.title}{p.processing ? ` · ${p.processing}` : ''}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Shop section</label>
              <select className="select" value={edit.shop_section_id ?? data.sectionId ?? ''}
                      onChange={(e) => setEdit({ ...edit, shop_section_id: e.target.value })}>
                <option value="">—</option>
                {(choices?.sections ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>
          </div>
          <div className="split">
            <div className="field">
              <label>Return policy</label>
              <select className="select" value={edit.return_policy_id ?? data.returnPolicyId ?? ''}
                      onChange={(e) => setEdit({ ...edit, return_policy_id: e.target.value })}>
                <option value="">—</option>
                {(choices?.returnPolicies ?? []).map((x) => (
                  <option key={x.id} value={x.id}>{x.accepts ? `Accepts returns${x.days ? ` within ${x.days} days` : ''}` : 'No returns'}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Processing profile</label>
              <select className="select" value={readinessStateId ?? data.readinessStateId ?? ''}
                      onChange={(e) => setReadinessStateId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {(choices?.processingProfiles ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.label ? `${p.label} · ` : ''}{String(p.readinessState ?? '').replace(/_/g, ' ')}</option>
                ))}
              </select>
              <div className="hint">Applied separately — Etsy has no field for this on an update; it lives on the listing's inventory instead.</div>
            </div>
          </div>

          <div className="section-title">Weight &amp; dimensions</div>
          <div className="split">
            <div className="field">
              <label>Weight</label>
              <div className="flex gap4">
                <DecimalInput value={edit.item_weight ?? data.itemWeight} onChange={(v) => setEdit({ ...edit, item_weight: v })} />
                <select className="select" value={edit.item_weight_unit ?? data.itemWeightUnit ?? ''}
                        onChange={(e) => setEdit({ ...edit, item_weight_unit: e.target.value })}>
                  <option value="">unit</option>
                  {WEIGHT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Dimensions unit</label>
              <select className="select" value={edit.item_dimensions_unit ?? data.itemDimensionsUnit ?? ''}
                      onChange={(e) => setEdit({ ...edit, item_dimensions_unit: e.target.value })}>
                <option value="">—</option>
                {DIMENSION_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap12">
            <div className="field"><label>Length</label>
              <DecimalInput value={edit.item_length ?? data.itemLength} onChange={(v) => setEdit({ ...edit, item_length: v })} />
            </div>
            <div className="field"><label>Width</label>
              <DecimalInput value={edit.item_width ?? data.itemWidth} onChange={(v) => setEdit({ ...edit, item_width: v })} />
            </div>
            <div className="field"><label>Height</label>
              <DecimalInput value={edit.item_height ?? data.itemHeight} onChange={(v) => setEdit({ ...edit, item_height: v })} />
            </div>
          </div>

          <div className="section-title">Settings</div>
          <Checkbox checked={edit.is_taxable ?? data.isTaxable ?? false}
                    onChange={(v) => setEdit({ ...edit, is_taxable: v })} label="Charge shop tax rates on this listing" />
          <Checkbox checked={edit.should_auto_renew ?? data.shouldAutoRenew ?? false}
                    onChange={(v) => setEdit({ ...edit, should_auto_renew: v })} label="Auto-renew for $0.20 when it expires" />
          <div className="field">
            <label>Feature this listing</label>
            <input className="input" type="number" min={1} value={edit.featured_rank ?? data.featuredRank ?? ''}
                   onChange={(e) => setEdit({ ...edit, featured_rank: e.target.value })} />
            <div className="hint">Optional. Position in your shop's featured row — 1 is left-most.</div>
          </div>
          {(data.styles?.length > 0 || data.isCustomizable != null) && (
            <div className="small dim mb16">
              Styles{data.styles?.length ? `: ${data.styles.join(', ')}` : ''}
              {data.isCustomizable != null ? ` · customizable: ${data.isCustomizable ? 'yes' : 'no'}` : ''}.
              Etsy only accepts either one when a listing is first created — there is no way to change them afterwards.
            </div>
          )}

          <div className="section-title">Personalization</div>
          <Checkbox checked={pers.isPersonalizable} onChange={(v) => setPersonalization({ ...pers, isPersonalizable: v })}
                    label="Buyers can personalize this listing" />
          {pers.isPersonalizable && (
            <>
              <div className="field">
                <label>Question shown to the buyer</label>
                <input className="input" value={pers.questionText} onChange={(e) => setPersonalization({ ...pers, questionText: e.target.value })} />
              </div>
              <div className="field">
                <label>Instructions</label>
                <input className="input" value={pers.instructions} onChange={(e) => setPersonalization({ ...pers, instructions: e.target.value })} />
              </div>
              <div className="split">
                <Checkbox checked={pers.isRequired} onChange={(v) => setPersonalization({ ...pers, isRequired: v })} label="Required" />
                <div className="field">
                  <label>Max characters</label>
                  <input className="input" type="number" value={pers.charCountMax}
                         onChange={(e) => setPersonalization({ ...pers, charCountMax: Number(e.target.value) })} />
                </div>
              </div>
            </>
          )}

          <div className="section-title">Variations ({data.variations.length})</div>
          <table className="data">
            <thead><tr><th /><th>SKU</th><th>Variation</th><th className="right">Price</th><th className="right">Qty</th></tr></thead>
            <tbody>
              {data.variations.map((v) => (
                <tr key={v.productId}>
                  <td><Thumb src={v.variationImageUrl} fallback="–" /></td>
                  <td className="mono small">{v.sku || <span className="muted">none</span>}</td>
                  <td className="small">{v.variation || '—'}</td>
                  <td className="num">{fmtMoney(v.price, data.currency)}</td>
                  <td className="num">{v.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="small muted mt8">Edit SKUs and prices on the SKUs screen, where changes batch per listing.</div>
        </>
      )}

      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title="Review before sending to Etsy"
               footer={(
                 <button className="btn primary" disabled={busy} onClick={applyConfirmed}>
                   {busy ? <Spinner /> : 'Send to Etsy'}
                 </button>
               )}>
          {Object.keys(confirm.body).length > 0 ? (
            <>
              <div className="section-title">Fields</div>
              <dl className="kv">
                {Object.entries(confirm.body).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt><dd className="small">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </>
          ) : <div className="small dim">No plain fields changed.</div>}
          {confirm.extra.length > 0 && (
            <>
              <div className="section-title">Also applied separately</div>
              <ul style={{ margin: '6px 0 0 18px' }}>{confirm.extra.map((e) => <li key={e}>{e}</li>)}</ul>
            </>
          )}
        </Modal>
      )}
    </Drawer>
  );
}

function BulkListingModal({ open, onClose, targets, onDone }) {
  const [type, setType] = useState('listing.tags');
  const [params, setParams] = useState({ mode: 'add', tags: '', value: '', find: '', replace: '', field: 'title' });
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState(null);
  const toast = useToast();
  const showError = useErrorToast();

  if (!open) return null;

  const submit = async () => {
    try {
      const p = { ...params };
      if (type === 'listing.tags') p.tags = String(params.tags).split(',').map((t) => t.trim()).filter(Boolean);
      if (type === 'listing.price') p.value = Number(params.value);
      const job = await api.post('/bulk/jobs', { type, targets, params: p, dryRun });
      setResult(job);
      if (!dryRun) { toast({ kind: 'ok', title: 'Job started', body: `Track it under Bulk jobs` }); onDone(); }
    } catch (err) { showError(err, 'Could not start'); }
  };

  return (
    <Modal open onClose={onClose} lg title={`Bulk action · ${targets.length} listing(s)`}
           footer={<><button className="btn primary" onClick={submit}>{dryRun ? 'Preview' : 'Run'}</button>
                     <Checkbox checked={dryRun} onChange={setDryRun} label="Dry run (show what would change)" /></>}>
      <div className="field">
        <label>Action</label>
        <select className="select" value={type} onChange={(e) => { setType(e.target.value); setResult(null); }}>
          <option value="listing.tags">Add / remove / replace tags</option>
          <option value="listing.price">Change prices</option>
          <option value="listing.quantity">Set stock</option>
          <option value="listing.find_replace">Find and replace text</option>
          <option value="listing.section">Move to section</option>
          <option value="listing.autorenew">Set auto-renew</option>
          <option value="sku.generate">Generate SKUs</option>
          <option value="ai.title">Rewrite titles with AI</option>
          <option value="ai.tags">Regenerate tags with AI</option>
          <option value="ai.description">Rewrite descriptions with AI</option>
        </select>
      </div>

      {type === 'listing.tags' && (
        <>
          <div className="field">
            <label>Mode</label>
            <select className="select" value={params.mode} onChange={(e) => setParams({ ...params, mode: e.target.value })}>
              <option value="add">Add</option><option value="remove">Remove</option><option value="replace">Replace all</option>
            </select>
          </div>
          <div className="field">
            <label>Tags (comma separated)</label>
            <input className="input" value={params.tags} onChange={(e) => setParams({ ...params, tags: e.target.value })} />
          </div>
        </>
      )}

      {type === 'listing.price' && (
        <>
          <div className="field">
            <label>Mode</label>
            <select className="select" value={params.mode} onChange={(e) => setParams({ ...params, mode: e.target.value })}>
              <option value="percent">By percentage</option><option value="set">Set to</option><option value="delta">Add / subtract</option>
            </select>
          </div>
          <div className="field">
            <label>Value</label>
            <input className="input" value={params.value} onChange={(e) => setParams({ ...params, value: e.target.value })} placeholder="-10" />
          </div>
        </>
      )}

      {(type === 'listing.quantity' || type === 'listing.section' || type === 'listing.autorenew') && (
        <div className="field">
          <label>{type === 'listing.section' ? 'Section id' : type === 'listing.autorenew' ? 'On (true) / off (false)' : 'Quantity'}</label>
          <input className="input" value={params.value} onChange={(e) => setParams({ ...params, value: e.target.value, sectionId: e.target.value })} />
        </div>
      )}

      {type === 'listing.find_replace' && (
        <>
          <div className="field">
            <label>Field</label>
            <select className="select" value={params.field} onChange={(e) => setParams({ ...params, field: e.target.value })}>
              <option value="title">Title</option><option value="description">Description</option>
            </select>
          </div>
          <div className="split">
            <div className="field"><label>Find</label><input className="input" value={params.find} onChange={(e) => setParams({ ...params, find: e.target.value })} /></div>
            <div className="field"><label>Replace with</label><input className="input" value={params.replace} onChange={(e) => setParams({ ...params, replace: e.target.value })} /></div>
          </div>
        </>
      )}

      {type.startsWith('ai.') && (
        <Banner kind="info">
          This calls the AI provider once per listing and writes the result straight to Etsy.
          Run a dry run first to see the target list.
        </Banner>
      )}

      {result && (
        <>
          <div className="section-title">{result.dryRun ? 'Would do' : 'Started'}</div>
          {result.items.slice(0, 25).map((i) => <div key={i.seq} className="small dim">{i.label}</div>)}
          {result.items.length > 25 && <div className="small muted">…and {result.items.length - 25} more</div>}
        </>
      )}
    </Modal>
  );
}
