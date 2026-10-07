import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Thumb, Pager, SortTh, Modal, useAsync, useDebounced, useToast, useErrorToast,
} from '../components/ui.jsx';
import CatalogStock from '../components/CatalogStock.jsx';
import MatchesTab, { LinkModal, ShopBadge } from '../components/LinkProducts.jsx';
import AutoSkuModal from '../components/AutoSku.jsx';

const LIMIT = 100;
const PREF = 'allproducts.shops';

const loadShopPref = () => { try { return JSON.parse(localStorage.getItem(PREF) || 'null'); } catch { return null; } };

/**
 * Every variant of every shop - Etsy shops and Shopify stores together. The
 * only things that can be changed here are a variant's SKU (written to the
 * shop it belongs to) and its supplier; stock is checked against the
 * supplier. Everything else about a product stays where it is edited today:
 * Store products, or the shop itself.
 */
export default function AllProducts() {
  const toast = useToast();
  const showError = useErrorToast();
  const [tab, setTab] = useState('variants');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [flags, setFlags] = useState({ missingSku: false, missingSupply: false, ungrouped: false, duplicates: false });
  const [stockFilter, setStockFilter] = useState('');
  const [sort, setSort] = useState('title');
  const [dir, setDir] = useState('asc');
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState(() => loadShopPref());   // null = every shop
  const [selected, setSelected] = useState(new Set());
  const [edits, setEdits] = useState({});                        // variant key -> { sku?, supplyLink?, variantSupplyLink?, supplierName? }
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(null);
  const [auto, setAuto] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [checks, setChecks] = useState({});

  const shops = useAsync(() => api.get('/catalog/shops'), []);
  const shopList = shops.data?.shops ?? [];
  const activeShops = picked ?? shopList.map((s) => s.key);

  useEffect(() => { try { localStorage.setItem(PREF, JSON.stringify(picked)); } catch { /* private window */ } }, [picked]);

  const query = useMemo(() => ({
    shops: picked && picked.length ? picked.join(',') : undefined,
    search: debounced, missingSku: flags.missingSku || undefined, missingSupply: flags.missingSupply || undefined,
    ungrouped: flags.ungrouped || undefined, duplicates: flags.duplicates || undefined, stock: stockFilter || undefined,
    sort, dir, limit: LIMIT, offset,
  }), [picked, debounced, flags, stockFilter, sort, dir, offset]);
  const { data, loading, error, reload } = useAsync(() => api.get('/catalog/variants', query), [query]);
  const rows = data?.rows ?? [];
  const counts = data?.counts;

  // The last stock / picture check of the variants on screen (free).
  const keysOnScreen = rows.map((r) => r.key).join('|');
  useEffect(() => {
    if (!rows.length) return undefined;
    let alive = true;
    api.post('/catalog/stock-cache', { keys: rows.map((r) => r.key) }).then((r) => { if (alive) setChecks((c) => ({ ...c, ...r.checks })); }).catch(() => {});
    return () => { alive = false; };
  }, [keysOnScreen]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFlag = (k, v) => { setFlags((f) => ({ ...f, [k]: v })); setOffset(0); };
  const toggleShop = (key) => {
    const current = new Set(activeShops);
    if (current.has(key)) current.delete(key); else current.add(key);
    setPicked(current.size === shopList.length || current.size === 0 ? null : [...current]);
    setOffset(0);
  };
  const onSort = (field) => { if (sort === field) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(field); setDir('asc'); } };

  // ---- staging edits: only what differs from what is stored
  const stage = (row, field, value, base = row[field]) => setEdits((all) => {
    const next = { ...all };
    const edit = { ...(next[row.key] ?? {}) };
    if (String(value).trim() === String(base ?? '').trim()) delete edit[field]; else edit[field] = value;
    if (Object.keys(edit).length) next[row.key] = edit; else delete next[row.key];
    return next;
  });
  const dirty = Object.keys(edits).length;

  const rowOf = useMemo(() => Object.fromEntries(rows.map((r) => [r.key, r])), [rows]);

  const review = async () => {
    setSaving(true);
    try {
      const list = Object.entries(edits).map(([key, e]) => ({ key, ...e }));
      const r = await api.post('/catalog/changes', { edits: list, dryRun: true });
      setPreview({ list, ...r });
    } catch (err) { showError(err, 'Could not check those changes'); } finally { setSaving(false); }
  };
  const write = async () => {
    setSaving(true);
    try {
      const good = preview.results.filter((r) => r.ok && !r.unchanged).map((r) => r.key);
      const r = await api.post('/catalog/changes', { edits: preview.list.filter((e) => good.includes(e.key)) });
      const done = r.results.filter((x) => x.ok).map((x) => x.key);
      setEdits((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !done.includes(k))));
      setPreview(null);
      if (r.failed) toast({ kind: 'err', title: `${r.changed} saved, ${r.failed} failed`, body: r.results.filter((x) => !x.ok).slice(0, 2).map((x) => x.error).join(' · '), duration: 10000 });
      else toast({ kind: 'ok', title: `${r.changed} change${r.changed === 1 ? '' : 's'} saved` });
      reload();
    } catch (err) { showError(err, 'Could not save'); } finally { setSaving(false); }
  };

  // ---- selection -> linking
  const toggle = (key) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const selectedProducts = useMemo(() => [...new Set(rows.filter((r) => selected.has(r.key)).map((r) => r.productKey))], [rows, selected]);
  /** One number for the shop quantity of every selected variant. */
  const setShopShows = () => {
    const raw = window.prompt(`What should the shop show for the ${selected.size} selected variant${selected.size === 1 ? '' : 's'}?\n(a whole number - Etsy shows 0 to 999)`, '999');
    if (raw == null) return;
    const q = Number(raw.trim());
    if (!Number.isInteger(q) || q < 0) { toast({ kind: 'err', title: 'That is not a quantity', body: 'Use a whole number, 0 or more.' }); return; }
    for (const r of rows.filter((x) => selected.has(x.key))) stage(r, 'quantity', String(q), r.shopQty);
  };
  const onResult = useCallback((key, r) => setChecks((c) => ({ ...c, [key]: r })), []);

  /** Every variant that matches the filters (not just this page) as a CSV file. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = [];
      for (let offset2 = 0; offset2 < 100000; offset2 += 1000) {
        const r = await api.get('/catalog/variants', { ...query, limit: 1000, offset: offset2 }); // eslint-disable-line no-await-in-loop
        all.push(...r.rows);
        if (r.rows.length < 1000) break;
      }
      const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const head = ['Shop', 'Product', 'Variation', 'SKU', 'Shop shows', 'Real stock', 'Supplier link', 'Variant supplier link', 'Supplier', 'Linked group', 'Product URL'];
      const lines = [head.join(',')].concat(all.map((r) => [r.shopName, r.productTitle, r.variation, r.sku, r.shopQty, r.realStock, r.supplyLink, r.variantSupplyLink, r.supplierName, r.groupId != null ? `#${r.groupId}` : '', r.productUrl].map(cell).join(',')));
      const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `variants-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast({ kind: 'ok', title: `${all.length.toLocaleString()} variants exported` });
    } catch (err) { showError(err, 'Could not export'); } finally { setExporting(false); }
  };

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));

  return (
    <TablePage
      title="All products"
      subtitle={counts ? `${counts.total.toLocaleString()} variants · ${shopList.length} shops` : ''}
      actions={(
        <>
          <button className="btn sm" onClick={() => { reload(); shops.reload(); }} disabled={loading}>{loading ? <Spinner /> : '↻'} Refresh</button>
          <button className="btn sm" onClick={exportCsv} disabled={exporting} title="Download the variants that match the filters as a spreadsheet (CSV)">{exporting ? <Spinner /> : '⭳'} Export</button>
          <button className="btn sm" onClick={() => setAuto(true)} title="Give a SKU to every variant that has none - the same product in several shops gets the same SKUs">✨ Auto SKUs…</button>
          <button className="btn sm primary" disabled={!dirty || saving} onClick={review}>{saving ? <Spinner /> : '✓'} Review {dirty || ''} change{dirty === 1 ? '' : 's'}</button>
        </>
      )}
      toolbar={(
        <>
          <button className={`btn xs ${tab === 'variants' ? 'primary' : 'ghost'}`} onClick={() => setTab('variants')}>Variants</button>
          <button className={`btn xs ${tab === 'matches' ? 'primary' : 'ghost'}`} onClick={() => setTab('matches')}>Same product in other shops</button>
          {tab === 'variants' && (
            <>
              <span className="small muted" style={{ marginLeft: 8 }}>Shops</span>
              {shopList.map((s) => (
                <button key={s.key} className={`btn xs ${activeShops.includes(s.key) ? '' : 'ghost'}`} onClick={() => toggleShop(s.key)}
                        title={`${s.variants} variants`} style={activeShops.includes(s.key) ? { boxShadow: `inset 0 -2px 0 ${s.channel === 'etsy' ? 'var(--brand)' : 'var(--ok, #34d399)'}` } : undefined}>
                  {s.channel === 'etsy' ? '🟠' : '🟢'} {s.name}
                </button>
              ))}
              <input className="input search" placeholder="Search SKU, title or variation…" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
              <Checkbox checked={flags.missingSku} onChange={(v) => setFlag('missingSku', v)} label={`Missing SKU${counts ? ` (${counts.missingSku})` : ''}`} />
              <Checkbox checked={flags.missingSupply} onChange={(v) => setFlag('missingSupply', v)} label={`No supplier${counts ? ` (${counts.missingSupply})` : ''}`} />
              <Checkbox checked={flags.ungrouped} onChange={(v) => setFlag('ungrouped', v)} label="Not linked" />
              <Checkbox checked={flags.duplicates} onChange={(v) => setFlag('duplicates', v)} label={`Duplicate SKU${counts?.duplicates ? ` (${counts.duplicates})` : ''}`} />
              <select className="select sm" value={stockFilter} aria-label="Stock filter" onChange={(e) => { setStockFilter(e.target.value); setOffset(0); }}
                      title="Real stock is what is on the shelf; the shop quantity is what the shop shows">
                <option value="">Any stock</option>
                <option value="oversell">Shop sells, shelf empty{counts?.oversell ? ` (${counts.oversell})` : ''}</option>
                <option value="zero">Real stock 0{counts?.realZero ? ` (${counts.realZero})` : ''}</option>
                <option value="tracked">Real stock counted{counts?.realTracked ? ` (${counts.realTracked})` : ''}</option>
                <option value="untracked">Real stock not counted</option>
              </select>
              <div className="spacer" />
              <span className="small muted">Only SKU, supplier and stock can be changed here</span>
            </>
          )}
        </>
      )}
      selection={tab === 'variants' && selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected · {selectedProducts.length} product{selectedProducts.length === 1 ? '' : 's'}</span>
          <button className="btn xs primary" disabled={selectedProducts.length < 2} onClick={() => setLinking(selectedProducts)}
                  title="They are the same product: line up their variants and give matching variants one SKU">Same product - line up SKUs…</button>
          <button className="btn xs" onClick={setShopShows}
                  title="The quantity the shop shows for every selected variant (Etsy 0-999) - staged here, written when you review">Shop shows…</button>
          <div className="spacer" />
          <button className="btn xs ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      pager={tab === 'variants' ? <Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} /> : null}
    >
      {tab === 'matches' && <MatchesTab onChanged={() => reload()} />}

      {tab === 'variants' && (
        <>
          {error && <div style={{ padding: 16 }}><Banner kind="err">{error.message}</Banner></div>}
          {counts?.oversell > 0 && stockFilter !== 'oversell' && (
            <div style={{ padding: '8px 16px 0' }}>
              <Banner kind="warn">
                <strong>{counts.oversell} variant{counts.oversell === 1 ? '' : 's'}</strong> show pieces in the shop while the shelf is empty - the shop can sell what you do not have.{' '}
                <button className="btn xs" onClick={() => { setStockFilter('oversell'); setOffset(0); }}>Show them</button>
              </Banner>
            </div>
          )}
          {loading && !data ? <div className="empty"><Spinner /></div> : rows.length === 0 ? (
            <Empty icon="⧉" title="No variants here">Sync the shops, or loosen the filters above.</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th className="col-tight"><Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))} /></th>
                  <SortTh label="Shop" field="shop" sort={sort} dir={dir} onSort={onSort} />
                  <th className="col-tight">Photos</th>
                  <SortTh label="Product / variation" field="title" sort={sort} dir={dir} onSort={onSort} />
                  <SortTh label="SKU" field="sku" sort={sort} dir={dir} onSort={onSort} />
                  <th>Supplier</th>
                  <SortTh label="Stock: shop / real" field="stock" sort={sort} dir={dir} onSort={onSort} />
                  <th>Stock at the supplier</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const e = edits[r.key] ?? {};
                  const sku = e.sku ?? r.sku;
                  const link = e.supplyLink ?? r.supplyLink;
                  const variantLink = e.variantSupplyLink ?? r.variantSupplyLink;
                  const name = e.supplierName ?? r.supplierName;
                  return (
                    <tr key={r.key} className={selected.has(r.key) ? 'selected' : ''} style={edits[r.key] ? { boxShadow: 'inset 3px 0 0 var(--brand)' } : undefined}>
                      <td><Checkbox checked={selected.has(r.key)} onChange={() => toggle(r.key)} /></td>
                      <td><ShopBadge channel={r.channel} name={r.shopName} /></td>
                      <td>
                        <div className="flex gap4">
                          <Thumb src={r.coverUrl} alt="product" />
                          <Thumb src={r.variantImageUrl} alt="variant" fallback="–" />
                        </div>
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <div className="cell-title" title={r.productTitle}><a href={r.productUrl} target="_blank" rel="noreferrer">{r.productTitle}</a></div>
                        <div className="small dim">{r.variation || '—'}{r.state && r.state !== 'active' ? <span className="badge grey" style={{ marginLeft: 6 }}>{r.state}</span> : null}
                          {r.groupId != null && <span className="badge blue" style={{ marginLeft: 6 }} title="Linked to the same product in another shop">🔗 #{r.groupId}</span>}</div>
                      </td>
                      <td>
                        <input className="input sm mono" style={{ width: 150, ...(r.duplicateSku ? { borderColor: 'var(--bad)' } : {}) }} value={sku} placeholder="— none —"
                               aria-label={`SKU of ${r.productTitle} ${r.variation}`} onChange={(ev) => stage(r, 'sku', ev.target.value)} />
                        {r.duplicateSku && <div className="small" style={{ color: 'var(--bad)' }}>used twice in {r.shopName}</div>}
                      </td>
                      <td style={{ minWidth: 250 }}>
                        <input className="input sm" style={{ width: '100%' }} value={link} placeholder="supplier link"
                               aria-label={`Supplier link of ${r.productTitle} ${r.variation}`} onChange={(ev) => stage(r, 'supplyLink', ev.target.value)} />
                        {r.channel === 'etsy' && (
                          <input className="input sm" style={{ width: '100%', marginTop: 3 }} value={variantLink} placeholder="this variant's link (optional)"
                                 onChange={(ev) => stage(r, 'variantSupplyLink', ev.target.value)} />
                        )}
                        <input className="input sm" style={{ width: '100%', marginTop: 3 }} value={name} placeholder="supplier name"
                               onChange={(ev) => stage(r, 'supplierName', ev.target.value)} />
                      </td>
                      <td style={{ minWidth: 150 }}>
                        <label className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="The quantity the shop shows (written to the shop)">
                          <span style={{ width: 34 }}>Shop</span>
                          <input className="input sm mono" type="number" min="0" style={{ width: 78 }} value={e.quantity ?? r.shopQty ?? ''} placeholder="–"
                                 aria-label={`Quantity shown by the shop for ${r.productTitle} ${r.variation}`} onChange={(ev) => stage(r, 'quantity', ev.target.value, r.shopQty)} />
                        </label>
                        <label className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}
                               title={sku ? 'What is really on the shelf - one count for this SKU in every shop. Orders take pieces off it, never below 0.' : 'Give this variant a SKU first - the real stock is kept per SKU'}>
                          <span style={{ width: 34 }}>Real</span>
                          <input className="input sm mono" type="number" min="0" style={{ width: 78 }} value={e.realStock ?? r.realStock ?? ''} placeholder="not counted" disabled={!sku}
                                 aria-label={`Real stock of ${r.productTitle} ${r.variation}`} onChange={(ev) => stage(r, 'realStock', ev.target.value, r.realStock)} />
                        </label>
                        {r.oversellRisk && <span className="badge red" style={{ marginTop: 3 }} title="The shop shows pieces, but the shelf is empty - it can sell what you do not have">shop sells, shelf empty</span>}
                      </td>
                      <td>
                        <CatalogStock row={{ ...r, supplyLink: link, variantSupplyLink: variantLink }} info={checks[r.key]} onResult={onResult} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      {preview && (
        <Modal open lg onClose={() => setPreview(null)} title="Review before anything is written"
               footer={(
                 <>
                   <button className="btn" onClick={() => setPreview(null)}>Back</button>
                   <button className="btn primary" disabled={saving || !preview.results.some((r) => r.ok && !r.unchanged)} onClick={write}>
                     {saving ? <Spinner /> : `Write ${preview.results.filter((r) => r.ok && !r.unchanged).length} change${preview.results.filter((r) => r.ok && !r.unchanged).length === 1 ? '' : 's'}`}
                   </button>
                 </>
               )}>
          <div className="small muted mb8">
            Each SKU and each shop quantity is written to the shop named on its row - nothing else about those products changes. Supplier details and the real stock stay in this app.
            {preview.failed > 0 && ' Rows marked in red are skipped; the others can still be written.'}
          </div>
          <table className="data">
            <thead><tr><th>Shop</th><th>Product / variation</th><th>SKU</th><th>Stock</th><th>Supplier</th></tr></thead>
            <tbody>
              {preview.results.map((x) => {
                const row = rowOf[x.key];
                return (
                  <tr key={x.key} style={!x.ok ? { background: 'rgba(248,113,113,.08)' } : undefined}>
                    <td>{row ? <ShopBadge channel={row.channel} name={row.shopName} /> : '—'}</td>
                    <td className="small">{row?.productTitle}<div className="muted">{row?.variation}</div></td>
                    <td className="mono small">{!x.ok ? <span style={{ color: 'var(--bad)' }}>{x.error}</span> : x.unchanged ? <span className="muted">no change</span>
                      : x.from !== x.sku ? <><span className="muted">{x.from || '(none)'}</span> → <strong>{x.sku}</strong></> : <span className="muted">{x.sku}</span>}</td>
                    <td className="small">
                      {x.quantity ? <div>shop shows {x.quantity.from ?? '–'} → <strong>{x.quantity.to}</strong></div> : null}
                      {x.real ? <div>real {x.real.from ?? 'not counted'} → <strong>{x.real.to ?? 'stop counting'}</strong></div> : null}
                      {!x.quantity && !x.real ? <span className="muted">—</span> : null}
                    </td>
                    <td className="small">{x.supplier ? Object.entries(x.supplier).map(([k, v]) => <div key={k}>{k === 'supplierName' ? 'name' : k === 'variantSupplyLink' ? 'variant link' : 'link'}: {v || '(cleared)'}</div>) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Modal>
      )}

      {auto && <AutoSkuModal shops={picked} selectedProducts={selectedProducts} onClose={() => setAuto(false)} onDone={() => { reload(); shops.reload(); }} />}

      {linking && <LinkModal productKeys={linking} onClose={() => setLinking(null)} onDone={() => { setLinking(null); setSelected(new Set()); reload(); }} />}
    </TablePage>
  );
}
