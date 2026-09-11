import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useRates } from '../lib/rates.js';
import Pictures from '../components/Pictures.jsx';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Thumb, Pager, SortTh, Drawer, Modal, CopyButton,
  useAsync, useDebounced, useToast, useErrorToast, fmtMoney, STATE_BADGE,
} from '../components/ui.jsx';

const LIMIT = 100;

/**
 * The SKU workbench. One row per variation showing, next to the SKU:
 * title, variation, non-discount price, discounted price, supply link,
 * the listing's first image and the variation's own image.
 * Edits are staged locally and pushed to Etsy per listing.
 */
export default function Skus() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounced(search);
  const [state, setState] = useState(params.get('state') ?? '');
  const [missingSku, setMissingSku] = useState(params.get('missingSku') === 'true');
  const [missingSupply, setMissingSupply] = useState(params.get('missingSupply') === 'true');
  const [sort, setSort] = useState('title');
  const [dir, setDir] = useState('asc');
  const [offset, setOffset] = useState(0);

  const [selected, setSelected] = useState(new Set());
  const [edits, setEdits] = useState({});        // productId -> { sku, price, quantity }
  const [supplyEdits, setSupplyEdits] = useState({}); // sku -> meta
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [syncingImages, setSyncingImages] = useState(false);

  const toast = useToast();
  const showError = useErrorToast();

  const query = useMemo(() => ({
    search: debounced, state, missingSku: missingSku || undefined,
    missingSupply: missingSupply || undefined, sort, dir, limit: LIMIT, offset,
  }), [debounced, state, missingSku, missingSupply, sort, dir, offset]);

  const { data, loading, error, reload } = useAsync(() => api.get('/skus', query), [query]);
  const { data: dups, reload: reloadDups } = useAsync(() => api.get('/skus/duplicates'), []);

  const rows = data?.rows ?? [];
  const pct = data?.discountPercent ?? 30;

  const setFilter = (key, value, setter) => {
    setter(value);
    setOffset(0);
    const next = new URLSearchParams(params);
    if (value === '' || value === false) next.delete(key); else next.set(key, String(value));
    setParams(next, { replace: true });
  };

  const onSort = (field, direction) => { setSort(field); setDir(direction); setOffset(0); };

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.productId));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.productId)));

  const stage = (productId, field, value) =>
    setEdits((e) => ({ ...e, [productId]: { ...e[productId], [field]: value } }));

  const stageSupply = (sku, field, value) =>
    setSupplyEdits((e) => ({ ...e, [sku]: { ...e[sku], [field]: value } }));

  const dirtyCount = Object.keys(edits).length + Object.keys(supplyEdits).length;

  /** Etsy replaces the whole inventory array per listing, so group edits by listing. */
  const saveAll = useCallback(async () => {
    setSaving(true);
    let ok = 0;
    let failed = 0;
    try {
      const byListing = {};
      for (const [productId, change] of Object.entries(edits)) {
        const row = rows.find((r) => String(r.productId) === String(productId));
        if (!row) continue;
        (byListing[row.listingId] ||= {})[productId] = change;
      }

      for (const [listingId, changes] of Object.entries(byListing)) {
        try {
          await api.put(`/skus/inventory/${listingId}`, { changes });
          ok += Object.keys(changes).length;
        } catch (err) {
          failed += Object.keys(changes).length;
          showError(err, `Listing ${listingId} rejected`);
        }
      }

      const supplyItems = Object.entries(supplyEdits)
        .filter(([sku]) => sku)
        .map(([sku, meta]) => ({ sku, ...meta }));
      if (supplyItems.length) await api.put('/skus/meta/bulk', { items: supplyItems });

      if (ok || supplyItems.length) {
        toast({
          kind: failed ? 'warn' : 'ok',
          title: 'Saved',
          body: `${ok} variation(s) pushed to Etsy${supplyItems.length ? `, ${supplyItems.length} supply link(s) stored` : ''}${failed ? `, ${failed} failed` : ''}`,
        });
      }
      setEdits({});
      setSupplyEdits({});
      reload();
      reloadDups();
    } finally {
      setSaving(false);
    }
  }, [edits, supplyEdits, rows, reload, reloadDups, toast, showError]);

  const clearSelectedSkus = async () => {
    if (!confirm(`Clear the SKU on ${selected.size} variation(s)? The variations themselves stay.`)) return;
    const byListing = {};
    for (const row of rows.filter((r) => selected.has(r.productId))) {
      (byListing[row.listingId] ||= []).push(row.productId);
    }
    let ok = 0;
    for (const [listingId, productIds] of Object.entries(byListing)) {
      try { await api.post(`/skus/inventory/${listingId}/clear-skus`, { productIds }); ok += productIds.length; }
      catch (err) { showError(err, `Listing ${listingId}`); }
    }
    toast({ kind: 'ok', title: `Cleared ${ok} SKU(s)` });
    setSelected(new Set());
    reload();
  };

  const deleteSelectedVariations = async () => {
    if (!confirm(`Delete ${selected.size} variation(s) from their listings? This changes what buyers can order and cannot be undone.`)) return;
    const byListing = {};
    for (const row of rows.filter((r) => selected.has(r.productId))) {
      (byListing[row.listingId] ||= []).push(row.productId);
    }
    let ok = 0;
    for (const [listingId, productIds] of Object.entries(byListing)) {
      try {
        const r = await api.del(`/skus/inventory/${listingId}/variations`, { productIds });
        ok += r.removed ?? 0;
      } catch (err) { showError(err, `Listing ${listingId}`); }
    }
    toast({ kind: 'ok', title: `Removed ${ok} variation(s)` });
    setSelected(new Set());
    reload();
  };

  /** The per-listing "Ask Etsy again" button, for every listing at once. */
  const syncAllVariantImages = async () => {
    setSyncingImages(true);
    try {
      const r = await api.post('/skus/variation-images/sync-all', {});
      const failed = r.errors?.length ?? 0;
      toast({
        kind: failed ? 'warn' : 'ok',
        title: 'Variant images re-checked',
        body: `${r.checked} listing(s) checked, ${r.mapped} variant photo(s) found`
          + (failed ? ` — ${failed} listing(s) could not be checked` : ''),
      });
      reload();
    } catch (err) { showError(err, 'Could not re-check variant images'); } finally { setSyncingImages(false); }
  };

  const exportXlsx = async () => {
    try {
      const r = await api.post('/exports/skus', { search: debounced, state, missingSku, missingSupply });
      toast({ kind: 'ok', title: 'Workbook ready', body: r.filename });
      window.location.href = `/api/exports/download/${encodeURIComponent(r.filename)}`;
    } catch (err) { showError(err, 'Export failed'); }
  };

  return (
    <TablePage
      title="SKUs & variations"
      subtitle={data ? `${data.total.toLocaleString()} variations · −${pct}% sale column` : ''}
      actions={
        <>
          {dups?.length > 0 && (
            <button className="btn sm danger" onClick={() => setDupOpen(true)}>
              {dups.length} duplicate SKU{dups.length === 1 ? '' : 's'}
            </button>
          )}
          <button className="btn sm" onClick={exportXlsx}>⤓ Excel</button>
          <button className="btn sm" onClick={syncAllVariantImages} disabled={syncingImages}
                  title="Ask Etsy again for every listing's variant photos, not just one at a time">
            {syncingImages ? <Spinner /> : '🖼'} Sync variant images
          </button>
          <button className="btn sm" onClick={reload} disabled={loading}>{loading ? <Spinner /> : '↻'} Refresh</button>
          <button className="btn sm primary" disabled={!dirtyCount || saving} onClick={saveAll}>
            {saving ? <Spinner /> : '✓'} Save {dirtyCount || ''}
          </button>
        </>
      }
      toolbar={
        <>
          <input className="input search" placeholder="Search SKU, title, variation or listing id…"
                 value={search} onChange={(e) => setFilter('search', e.target.value, setSearch)} />
          <select className="select" value={state} onChange={(e) => setFilter('state', e.target.value, setState)}>
            <option value="">All states</option>
            {['active', 'inactive', 'draft', 'expired', 'sold_out'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Checkbox checked={missingSku} onChange={(v) => setFilter('missingSku', v, setMissingSku)} label="Missing SKU" />
          <Checkbox checked={missingSupply} onChange={(v) => setFilter('missingSupply', v, setMissingSupply)} label="No supply link" />
          <div className="spacer" />
          <span className="small muted">Edit inline, then Save</span>
        </>
      }
      selection={selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected</span>
          <button className="btn xs" onClick={() => setBulkOpen(true)}>Bulk actions</button>
          <button className="btn xs" onClick={() => setGenOpen(true)}>Generate SKUs</button>
          <button className="btn xs" onClick={clearSelectedSkus}>Clear SKUs</button>
          <button className="btn xs danger" onClick={deleteSelectedVariations}>Delete variations</button>
          <div className="spacer" />
          <button className="btn xs ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      pager={<Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />}
    >
      {error && <div style={{ padding: 16 }}><Banner kind="err">{error.message}</Banner></div>}

      {loading && !data ? (
        <div className="empty"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty icon="⧉" title="No variations here">
          Sync your listings from the Dashboard, or loosen the filters above.
        </Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="col-tight"><Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} /></th>
              <th className="col-tight">First</th>
              <th className="col-tight">Var.</th>
              <SortTh label="SKU" field="sku" sort={sort} dir={dir} onSort={onSort} />
              <SortTh label="Title" field="title" sort={sort} dir={dir} onSort={onSort} />
              <SortTh label="Variation" field="variation" sort={sort} dir={dir} onSort={onSort} />
              <SortTh label="Price" field="price" sort={sort} dir={dir} onSort={onSort} className="right" />
              <th className="right">−{pct}%</th>
              <SortTh label="Qty" field="quantity" sort={sort} dir={dir} onSort={onSort} className="right" />
              <th>Supply link</th>
              <SortTh label="State" field="state" sort={sort} dir={dir} onSort={onSort} />
              <th className="col-tight" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const edit = edits[r.productId] ?? {};
              const supply = supplyEdits[r.sku] ?? {};
              const sku = edit.sku ?? r.sku;
              const price = edit.price ?? r.priceFull;
              const link = supply.supplyLink ?? r.supplyLink;
              const variantLink = supply.variantSupplyLink ?? r.variantSupplyLink ?? '';
              const discounted = price != null && price !== '' ? (Number(price) * (1 - pct / 100)).toFixed(2) : null;
              const isDirty = edits[r.productId] || supplyEdits[r.sku];

              return (
                <tr key={r.productId} className={selected.has(r.productId) ? 'selected' : ''}
                    style={isDirty ? { boxShadow: 'inset 3px 0 0 var(--brand)' } : undefined}>
                  <td><Checkbox checked={selected.has(r.productId)} onChange={() => toggle(r.productId)} /></td>
                  <td><Thumb src={r.firstImageUrl} alt="listing" /></td>
                  <td title={r.savedVariantImageUrl ? 'Your own variant photo' : 'Etsy\u2019s photo for this variation'}>
                    <Thumb src={r.variantImageUrl} alt="variation" fallback="–" />
                  </td>
                  <td>
                    <input className="input sm mono" style={{ width: 132 }} value={sku}
                           placeholder="— none —"
                           onChange={(e) => stage(r.productId, 'sku', e.target.value)} />
                  </td>
                  <td className="cell-title" title={r.title}>
                    <a href={r.listingUrl} target="_blank" rel="noreferrer">{r.title}</a>
                  </td>
                  <td className="small dim" style={{ maxWidth: 190 }}>{r.variation || '—'}</td>
                  <td className="num">
                    <input className="input sm right" style={{ width: 84 }} type="number" step="0.01" value={price ?? ''}
                           onChange={(e) => stage(r.productId, 'price', e.target.value)} />
                  </td>
                  <td className="num" title={`${pct}% off the non-discount price`}>
                    <span className="badge orange">{discounted ?? '—'}</span>
                  </td>
                  <td className="num">
                    <input className="input sm right" style={{ width: 62 }} type="number" value={edit.quantity ?? r.quantity ?? ''}
                           onChange={(e) => stage(r.productId, 'quantity', e.target.value)} />
                  </td>
                  <td>
                    <div className="flex gap4">
                      <input className="input sm" style={{ width: 176 }} placeholder="main supplier URL (private)"
                             value={link} disabled={!sku}
                             title={!sku ? 'Give the variation a SKU first — supply links are stored per SKU' : link}
                             onChange={(e) => stageSupply(sku, 'supplyLink', e.target.value)} />
                      {link && <a href={link} target="_blank" rel="noreferrer" className="btn xs" title="Open the main supply page">↗</a>}
                    </div>
                    <div className="flex gap4 mt4">
                      <input className="input sm" style={{ width: 176 }} placeholder="this variant's URL"
                             value={variantLink} disabled={!sku}
                             title={!sku ? 'Give the variation a SKU first' : variantLink}
                             onChange={(e) => stageSupply(sku, 'variantSupplyLink', e.target.value)} />
                      {variantLink && <a href={variantLink} target="_blank" rel="noreferrer" className="btn xs" title="Open this variant's supply page">↗</a>}
                    </div>
                  </td>
                  <td><span className={`badge ${STATE_BADGE[r.state] ?? 'grey'}`}>{r.state}</span></td>
                  <td><button className="btn xs" onClick={() => setDetail(r)}>Open</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <SkuDetail row={detail} pct={pct} onClose={() => setDetail(null)} onSaved={reload} />
      <SkuGenerator
        open={genOpen}
        onClose={() => setGenOpen(false)}
        rows={rows.filter((r) => selected.has(r.productId))}
        onDone={() => { setGenOpen(false); setSelected(new Set()); reload(); }}
      />
      <BulkSkuModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        rows={rows.filter((r) => selected.has(r.productId))}
        onDone={() => { setBulkOpen(false); setSelected(new Set()); reload(); }}
      />
      <Modal open={dupOpen} onClose={() => setDupOpen(false)} title="Duplicate SKUs" lg>
        <p className="dim small">
          The same SKU is used by more than one variation. That breaks supply-link mapping and order matching,
          because both point at one supplier record.
        </p>
        {(dups ?? []).map((d) => (
          <div key={d.sku} className="card mb8">
            <div className="flex">
              <strong className="mono">{d.sku}</strong>
              <span className="badge red">{d.uses} uses</span>
            </div>
            {d.rows.map((r) => (
              <div key={r.productId} className="small dim" style={{ paddingTop: 4 }}>
                listing {r.listingId} · {r.title}
              </div>
            ))}
          </div>
        ))}
      </Modal>
    </TablePage>
  );
}

/** Single-variation panel: full images, pricing maths and supplier record. */
function SkuDetail({ row, pct, onClose, onSaved }) {
  const [meta, setMeta] = useState({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();
  const { convert, day: rateDay } = useRates();

  React.useEffect(() => {
    setMeta(row ? {
      supplyLink: row.supplyLink ?? '',
      variantSupplyLink: row.variantSupplyLink ?? '',
      variantImageUrl: row.savedVariantImageUrl ?? '',
      // Chinese suppliers are the usual case, so that is the default rather
      // than dollars.
      supplyCost: row.supplyCost ?? '', supplyCurrency: row.supplyCurrency ?? 'CNY',
      leadTimeDays: row.leadTimeDays ?? '', notes: row.notes ?? '',
    } : {});
  }, [row]);

  const sale = row && row.priceFull != null ? row.priceFull * (1 - pct / 100) : null;
  const cost = Number(meta.supplyCost);
  const costCurrency = (meta.supplyCurrency || 'CNY').toUpperCase();
  // The cost is usually in yuan and the price in dollars, so the two have to be
  // brought together before they are subtracted - otherwise the margin reads
  // like a loss on every product.
  const costHere = Number.isFinite(cost) && row
    ? (costCurrency === (row.currency || 'USD').toUpperCase()
        ? cost
        : convert(cost, costCurrency, row.currency || 'USD'))
    : null;
  const margin = costHere != null && sale != null ? sale - costHere : null;
  if (!row) return null;

  const save = async () => {
    if (!row.sku) { toast({ kind: 'err', title: 'This variation has no SKU', body: 'Supply data is keyed by SKU. Set one first.' }); return; }
    setBusy(true);
    try {
      await api.put(`/skus/${encodeURIComponent(row.sku)}/meta`, meta);
      toast({ kind: 'ok', title: 'Supply record saved' });
      onSaved();
      onClose();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  return (
    <Drawer open onClose={onClose} title={row.sku || 'Variation'}
            footer={<><button className="btn primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save supply record'}</button>
                      <div className="spacer" /><CopyButton text={row.sku} label="Copy SKU" /></>}>
      <div className="section-title">Product</div>
      <div className="flex gap12 mb16" style={{ alignItems: 'flex-start' }}>
        <div>
          <Thumb src={row.firstImageUrl} size="lg" />
          <div className="small dim" style={{ textAlign: 'center' }}>first</div>
        </div>
        <div>
          <Thumb src={row.variationImageUrl || row.lastImageUrl} size="lg" fallback="–" />
          <div className="small dim" style={{ textAlign: 'center' }}>{row.variationImageUrl ? 'variant' : 'last'}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{row.title}</div>
          <div className="small dim">{row.variation || 'No variation attributes'}</div>
          <div className="pill-row mt8">
            <span className={`badge ${STATE_BADGE[row.state] ?? 'grey'}`}>{row.state}</span>
            <span className="badge grey">listing {row.listingId}</span>
            <span className={`badge ${row.isEnabled ? 'green' : 'grey'}`}>{row.isEnabled ? 'enabled' : 'disabled'}</span>
          </div>
        </div>
      </div>

      <div className="section-title">Pricing</div>
      <dl className="kv mb16">
        <dt>Non-discount price</dt><dd>{fmtMoney(row.priceFull, row.currency)}</dd>
        <dt>Price at −{pct}%</dt><dd><strong>{fmtMoney(sale, row.currency)}</strong></dd>
        <dt>Stock</dt><dd>{row.quantity ?? '—'}</dd>
        {margin != null && (
          <>
            <dt>Margin after cost</dt>
            <dd className={margin < 0 ? 'badge red' : ''}>
              {fmtMoney(margin, row.currency)}
              {sale > 0 && <span className="dim"> ({Math.round((margin / sale) * 100)}%)</span>}
              {costCurrency !== (row.currency || 'USD').toUpperCase() && (
                <div className="small dim">
                  cost {fmtMoney(cost, costCurrency)} converted at today's rate{rateDay ? ` (${rateDay})` : ''}
                </div>
              )}
            </dd>
          </>
        )}
      </dl>

      <div className="section-title">Supply (private — never sent to Etsy)</div>
      <div className="field">
        <label>Main supply link</label>
        <input className="input" value={meta.supplyLink ?? ''} placeholder="https://supplier.example/product/123"
               onChange={(e) => setMeta({ ...meta, supplyLink: e.target.value })} />
        <div className="hint">The supplier's page for the product as a whole.</div>
      </div>
      <div className="field">
        <label>Variant supply link</label>
        <input className="input" value={meta.variantSupplyLink ?? ''} placeholder="https://supplier.example/product/123?colour=silver"
               onChange={(e) => setMeta({ ...meta, variantSupplyLink: e.target.value })} />
        <div className="hint">The page for this exact colour/size, when the supplier has one.</div>
      </div>

      <div className="field">
        <label>Variant image link</label>
        <input className="input" value={meta.variantImageUrl ?? ''} placeholder="https://…/silver.jpg"
               onChange={(e) => setMeta({ ...meta, variantImageUrl: e.target.value })} />
        <div className="hint">
          A picture of this exact variant. Left empty, the photo Etsy has for the variation is used instead.
        </div>
        {(meta.variantImageUrl || row.variantImageUrl) && (
          <div className="mt8">
            <Thumb src={meta.variantImageUrl || row.variantImageUrl} alt={row.sku} size="lg" />
          </div>
        )}
      </div>

      <div className="split3">
        <div className="field">
          <label>Estimated lead time (days)</label>
          <input className="input" type="number" value={meta.leadTimeDays ?? ''} onChange={(e) => setMeta({ ...meta, leadTimeDays: e.target.value })} />
          <div className="hint">An estimate. The real figure comes from you later.</div>
        </div>
        <div className="field">
          <label>Estimated unit cost</label>
          <input className="input" type="number" step="0.01" value={meta.supplyCost ?? ''} onChange={(e) => setMeta({ ...meta, supplyCost: e.target.value })} />
          <div className="hint">An estimate, used for the margin figure until you enter the real cost.</div>
        </div>
        <div className="field">
          <label>Cost currency</label>
          <select className="select" value={meta.supplyCurrency ?? 'CNY'}
                  onChange={(e) => setMeta({ ...meta, supplyCurrency: e.target.value })}>
            {['CNY', 'USD', 'TRY', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {meta.supplyCost !== '' && costCurrency !== 'USD' && convert(meta.supplyCost, costCurrency, 'USD') !== null && (
            <div className="hint">≈ {fmtMoney(convert(meta.supplyCost, costCurrency, 'USD'), 'USD')} at today's rate</div>
          )}
        </div>
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea className="textarea" value={meta.notes ?? ''} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} />
      </div>

      {row.listingId && (
        <Pictures listingId={row.listingId} productId={row.productId} />
      )}

      <div className="section-title">Attributes</div>
      {row.properties?.length
        ? row.properties.map((p) => (
            <div key={p.property_id} className="flex small" style={{ padding: '3px 0' }}>
              <span className="dim" style={{ width: 140 }}>{p.property_name}</span>
              <span>{(p.values || []).join(', ')}</span>
            </div>
          ))
        : <div className="dim small">No variation attributes on this product.</div>}
    </Drawer>
  );
}

/**
 * Making up SKUs for whole listings.
 *
 * Two ways round it: a plain rule (KC001-01, KC001-02, then KC002-01) or the
 * AI, which reads the titles and picks a prefix that means something - KC for
 * keycaps, DM for a deskmat. Either way nothing is written until the proposal
 * below has been looked at, because a code that has already gone onto a label
 * or into a supplier's sheet is expensive to change.
 */
function SkuGenerator({ open, onClose, rows, onDone }) {
  const [mode, setMode] = useState('rule');
  const [prefix, setPrefix] = useState('KC');
  const [overwrite, setOverwrite] = useState(false);
  const [startAt, setStartAt] = useState('');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const listingIds = useMemo(() => [...new Set(rows.map((r) => r.listingId))], [rows]);

  React.useEffect(() => { if (!open) { setPlan(null); setMode('rule'); } }, [open]);

  const propose = async () => {
    setBusy(true);
    try {
      const body = { listingIds, mode, overwrite };
      if (mode === 'rule') {
        body.prefix = prefix.trim().toUpperCase() || 'KC';
        if (startAt) body.startAt = Number(startAt);
      }
      setPlan(await api.post('/skus/generate/plan', body));
    } catch (err) { showError(err, 'Could not work out the codes'); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post('/skus/generate/apply', { plan });
      toast({
        kind: 'ok',
        title: `${r.updated} SKU(s) written`,
        body: 'Stored here. Use Save to push them to Etsy — one listing at a time, so Etsy never sees two writes at once.',
      });
      onDone();
    } catch (err) { showError(err, 'Could not save the codes'); }
    finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} lg
           title={`Generate SKUs for ${listingIds.length} listing${listingIds.length === 1 ? '' : 's'}`}
           footer={plan
             ? (<>
                 <button className="btn" onClick={() => setPlan(null)}>Back</button>
                 <div className="spacer" />
                 <button className="btn primary" onClick={apply} disabled={busy || !plan.total}>
                   {busy ? <Spinner /> : `Write ${plan.total} SKU${plan.total === 1 ? '' : 's'}`}
                 </button>
               </>)
             : (<>
                 <div className="spacer" />
                 <button className="btn primary" onClick={propose} disabled={busy || !listingIds.length}>
                   {busy ? <Spinner /> : 'Show me the codes'}
                 </button>
               </>)}>
      {!plan ? (
        <>
          <div className="field">
            <label>How should the codes be chosen?</label>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="rule">By rule — one prefix, numbered in order</option>
              <option value="ai">By AI — a prefix that suits each product</option>
            </select>
            <div className="hint">
              {mode === 'rule'
                ? 'Every selected listing gets the same prefix and the next free number: KC001-01, KC001-02, then KC002-01.'
                : 'The AI reads each title and picks a short prefix for it, so keycaps and deskmats do not share a series. Codes already in use are never handed out again.'}
            </div>
          </div>

          {mode === 'rule' && (
            <div className="split">
              <div className="field">
                <label>Prefix</label>
                <input className="input mono" value={prefix} maxLength={4}
                       onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
              </div>
              <div className="field">
                <label>Start numbering at</label>
                <input className="input" type="number" min="1" placeholder="next free" value={startAt}
                       onChange={(e) => setStartAt(e.target.value)} />
                <div className="hint">Left empty, it carries on from the highest number already used.</div>
              </div>
            </div>
          )}

          <Checkbox checked={overwrite} onChange={setOverwrite}
                    label="Replace SKUs that already exist" />
          <div className="hint">
            Off by default. A code already printed on a label or sitting in a supplier's sheet is left alone.
          </div>
        </>
      ) : (
        <>
          <Banner kind={plan.total ? 'info' : 'warn'}>
            {plan.total
              ? `${plan.total} new code${plan.total === 1 ? '' : 's'}${plan.kept ? `, ${plan.kept} variation(s) keep the SKU they already have` : ''}.`
              : 'Nothing to change — every selected variation already has a SKU. Tick "Replace SKUs that already exist" if you meant to redo them.'}
            {plan.mode === 'ai' && plan.model ? ` Suggested by ${plan.model}.` : ''}
          </Banner>

          {plan.dropped?.length > 0 && (
            <Banner kind="warn">
              Dropped as unusable: {plan.dropped.join('; ')}.
            </Banner>
          )}

          {(plan.listings ?? []).map((l) => (
            <div key={l.listingId} className="mb16">
              <div className="section-title">{l.title}</div>
              <table className="data">
                <thead><tr><th>Variation</th><th>Now</th><th>Becomes</th></tr></thead>
                <tbody>
                  {l.rows.map((r) => (
                    <tr key={r.productId}>
                      <td className="small dim">{r.variation || '—'}</td>
                      <td className="mono small">{r.current || '—'}</td>
                      <td className="mono">
                        {r.kept
                          ? <span className="dim" title={r.reason}>{r.sku} (kept)</span>
                          : <strong>{r.sku}</strong>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

/** Apply one change across every selected variation. */
function BulkSkuModal({ open, onClose, rows, onDone }) {
  const [mode, setMode] = useState('price-percent');
  const [value, setValue] = useState('');
  const [pattern, setPattern] = useState('{prefix}-{listing}-{n}');
  const [prefix, setPrefix] = useState('KA');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  if (!open) return null;
  const listingIds = [...new Set(rows.map((r) => r.listingId))];

  const apply = async () => {
    setBusy(true);
    try {
      if (mode === 'sku-generate') {
        const job = await api.post('/bulk/jobs', {
          type: 'sku.generate', targets: listingIds, params: { pattern, prefix, overwrite: true },
        });
        toast({ kind: 'ok', title: 'SKU generation started', body: `Job ${job.id} over ${listingIds.length} listing(s)` });
      } else if (mode === 'price-percent') {
        const job = await api.post('/bulk/jobs', {
          type: 'listing.price', targets: listingIds, params: { mode: 'percent', value: Number(value) },
        });
        toast({ kind: 'ok', title: 'Price change started', body: `Job ${job.id}` });
      } else if (mode === 'price-set') {
        const job = await api.post('/bulk/jobs', {
          type: 'listing.price', targets: listingIds, params: { mode: 'set', value: Number(value) },
        });
        toast({ kind: 'ok', title: 'Price set started', body: `Job ${job.id}` });
      } else if (mode === 'quantity') {
        const job = await api.post('/bulk/jobs', {
          type: 'listing.quantity', targets: listingIds, params: { value: Number(value) },
        });
        toast({ kind: 'ok', title: 'Stock update started', body: `Job ${job.id}` });
      } else if (mode === 'supply') {
        const skus = rows.map((r) => r.sku).filter(Boolean);
        if (!skus.length) throw new Error('None of the selected variations have a SKU.');
        await api.put('/skus/meta/bulk', { items: skus.map((sku) => ({ sku, supplyLink: value })) });
        toast({ kind: 'ok', title: `Supply link set on ${skus.length} SKU(s)` });
      }
      onDone();
    } catch (err) { showError(err, 'Bulk action failed'); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Bulk action · ${rows.length} variation(s)`}
           footer={<><button className="btn primary" onClick={apply} disabled={busy}>{busy ? <Spinner /> : 'Apply'}</button>
                     <span className="small muted">Price and stock changes apply to every variation on the {listingIds.length} affected listing(s).</span></>}>
      <div className="field">
        <label>Action</label>
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="price-percent">Change price by percentage</option>
          <option value="price-set">Set price to a fixed amount</option>
          <option value="quantity">Set stock quantity</option>
          <option value="sku-generate">Generate SKUs from a pattern</option>
          <option value="supply">Set the same supply link</option>
        </select>
      </div>

      {mode === 'sku-generate' ? (
        <>
          <div className="field">
            <label>Pattern</label>
            <input className="input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
            <div className="hint">Tokens: {'{prefix} {listing} {n} {title} {var} {var1} {var2}'}</div>
          </div>
          <div className="field">
            <label>Prefix</label>
            <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
          <Banner kind="warn">This overwrites SKUs that already exist on the selected listings.</Banner>
        </>
      ) : (
        <div className="field">
          <label>
            {mode === 'price-percent' ? 'Percentage (use a negative number to discount)'
              : mode === 'supply' ? 'Supply link' : 'Value'}
          </label>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)}
                 placeholder={mode === 'price-percent' ? '-10' : mode === 'supply' ? 'https://…' : '0'} />
        </div>
      )}
    </Modal>
  );
}
