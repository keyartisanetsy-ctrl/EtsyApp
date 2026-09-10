import React, { useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import Pictures from '../components/Pictures.jsx';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Pager, SortTh, Drawer, Modal, Thumb, CopyButton,
  useAsync, useDebounced, useToast, useErrorToast, fmtMoney, fmtDate, STATE_BADGE,
} from '../components/ui.jsx';

const LIMIT = 50;
const STATES = ['active', 'inactive', 'draft', 'expired', 'sold_out'];

export default function Listings() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [state, setState] = useState(params.get('state') ?? '');
  const [sort, setSort] = useState('updated');
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [detailId, setDetailId] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const nav = useNavigate();
  const toast = useToast();
  const showError = useErrorToast();

  const query = useMemo(() => ({ search: debounced, state, sort, dir, limit: LIMIT, offset }),
    [debounced, state, sort, dir, offset]);
  const { data, loading, error, reload } = useAsync(() => api.get('/listings', query), [query]);

  const rows = data?.rows ?? [];
  const counts = data?.countsByState ?? {};

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.listingId));

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
          <div className="spacer" />
          <span className="small muted">−{data?.discountPercent ?? 30}% column shows the sale price</span>
        </>
      }
      selection={selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected</span>
          <button className="btn xs" onClick={() => quickAction('listing.activate')}>Activate</button>
          <button className="btn xs" onClick={() => quickAction('listing.deactivate')}>Deactivate</button>
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

function ListingDetail({ id, onClose, onChanged }) {
  const { data, loading, reload } = useAsync(() => (id ? api.get(`/listings/${id}`) : null), [id], { immediate: !!id });
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => { setEdit({}); }, [id]);
  if (!id) return null;

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...edit };
      if (body.tags) body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (body.materials) body.materials = body.materials.split(',').map((t) => t.trim()).filter(Boolean);
      await api.patch(`/listings/${id}`, body);
      toast({ kind: 'ok', title: 'Listing updated on Etsy' });
      setEdit({});
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
                <button className="btn primary" disabled={busy || !Object.keys(edit).length} onClick={save}>
                  {busy ? <Spinner /> : 'Save to Etsy'}
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
          <div className="flex wrap mb16">
            {data.images.map((img) => <Thumb key={img.id} src={img.url} size="lg" />)}
          </div>

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
