import React, { useState } from 'react';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Modal, Drawer, Stat, useAsync, useDebounced,
  useToast, useErrorToast, fmtMoney,
} from '../components/ui.jsx';

/**
 * The supply book — the Taobao side of the business, in the same app.
 *
 * Keyed by SKU, so what you sell and what you buy are one row rather than two
 * spreadsheets that have to be reconciled by eye. Prices are in the supplier's
 * currency with today's dollar figure beside them, and the margin is worked out
 * against what the SKU actually sells for on Etsy.
 */
export default function Supply() {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [supplier, setSupplier] = useState('');
  const [missingLink, setMissingLink] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [edit, setEdit] = useState(null);

  const { data, loading, reload } = useAsync(
    () => api.get('/supply', { search: debounced, supplier, missingLink: missingLink || undefined }),
    [debounced, supplier, missingLink],
  );

  const items = data?.items ?? [];
  const cov = data?.coverage;

  return (
    <TablePage
      title="Supply book"
      subtitle={cov ? `${cov.covered} of ${cov.skus || '—'} SKUs have a supplier` : ''}
      actions={
        <>
          <button className="btn sm" onClick={() => setImportOpen(true)}>↧ Bring a sheet across</button>
          <button className="btn sm primary" onClick={() => setEdit({ sku: '' })}>＋ Add</button>
        </>
      }
      toolbar={
        <>
          <input className="input search" placeholder="Search SKU, title or item number…"
                 value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">Every supplier</option>
            {(data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={missingLink} onChange={(e) => setMissingLink(e.target.checked)} />
            No link yet
          </label>
        </>
      }
    >
      {cov && (
        <div style={{ padding: 16, paddingBottom: 0 }}>
          <div className="grid c4">
            <Stat label="SKUs with a supplier" value={cov.covered} note={`${cov.percent}% of the catalogue`} />
            <Stat label="With a price" value={cov.priced} />
            <Stat label="Still to link" value={cov.missing} kind={cov.missing ? 'warn' : ''} />
            <Stat label="Suppliers" value={new Set(items.map((i) => i.supplier)).size} />
          </div>
        </div>
      )}

      {loading && !data ? <div className="empty"><Spinner /></div>
        : !items.length ? (
          <Empty icon="🛒" title="Nothing in the supply book yet">
            Add one, or paste your old Taobao sheet with &ldquo;Bring a sheet across&rdquo;.
          </Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>SKU</th><th>Supplier</th><th>Item</th>
                <th className="right">Cost</th><th className="right">In USD</th>
                <th className="right">Sells for</th><th className="right">Margin</th>
                <th>Links</th><th className="col-tight" />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.sku}>
                  <td className="mono small">{i.sku}</td>
                  <td className="small">{i.supplierLabel}</td>
                  <td className="small cell-title" title={i.title}>{i.title || <span className="muted">—</span>}</td>
                  <td className="num">{i.price != null ? `${i.price} ${i.currency}` : '—'}</td>
                  <td className="num">
                    {i.landedCostUsd != null ? fmtMoney(i.landedCostUsd, 'USD') : '—'}
                    {i.shippingCost ? <div className="small dim">incl. shipping</div> : null}
                  </td>
                  <td className="num money-subtotal">{i.saleUsd != null ? fmtMoney(i.saleUsd, 'USD') : '—'}</td>
                  <td className="num">
                    {i.marginUsd != null
                      ? <span className={i.marginUsd < 0 ? 'badge red' : 'badge green'}>
                          {fmtMoney(i.marginUsd, 'USD')}{i.marginPercent != null ? ` · ${i.marginPercent}%` : ''}
                        </span>
                      : '—'}
                  </td>
                  <td>
                    <div className="flex gap4">
                      {i.variantUrl && <a className="btn xs primary" href={i.variantUrl} target="_blank" rel="noreferrer">Variant ↗</a>}
                      {i.url && <a className="btn xs" href={i.url} target="_blank" rel="noreferrer">Main ↗</a>}
                      {!i.url && !i.variantUrl && <span className="muted small">—</span>}
                    </div>
                  </td>
                  <td><button className="btn xs" onClick={() => setEdit(i)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <SupplyEditor item={edit} suppliers={data?.suppliers ?? []} onClose={() => setEdit(null)} onSaved={reload} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />
    </TablePage>
  );
}

function SupplyEditor({ item, onClose, onSaved }) {
  const [form, setForm] = useState({});
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => {
    setForm(item ? {
      sku: item.sku ?? '', url: item.url ?? '', variantUrl: item.variantUrl ?? '',
      variantLabel: item.variantLabel ?? '', title: item.title ?? '',
      price: item.price ?? '', currency: item.currency ?? 'CNY',
      moq: item.moq ?? '', shippingCost: item.shippingCost ?? '', notes: item.notes ?? '',
    } : {});
    setParsed(null);
  }, [item]);

  if (!item) return null;

  // Reading the link tells us the supplier and the item number with no request.
  const readLink = async (url) => {
    if (!url) { setParsed(null); return; }
    try { setParsed(await api.get('/supply/parse', { url })); } catch { setParsed(null); }
  };

  const save = async () => {
    if (!form.sku) { toast({ kind: 'warn', title: 'A SKU is needed', body: 'The supply record hangs off it.' }); return; }
    setBusy(true);
    try {
      await api.put(`/supply/${encodeURIComponent(form.sku)}`, form);
      toast({ kind: 'ok', title: 'Saved', body: 'The links now show on the SKU page and on every order for this product.' });
      onSaved(); onClose();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  return (
    <Drawer open onClose={onClose} title={item.sku || 'New supply record'}
            footer={<><button className="btn primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button></>}>
      <div className="field">
        <label>SKU</label>
        <input className="input mono" value={form.sku ?? ''} disabled={!!item.sku}
               onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        <div className="hint">This is what joins the supplier to the product you sell.</div>
      </div>

      <div className="field">
        <label>Main product link</label>
        <input className="input" value={form.url ?? ''} placeholder="https://item.taobao.com/item.htm?id=…"
               onChange={(e) => { setForm({ ...form, url: e.target.value }); readLink(e.target.value); }} />
        {parsed?.ok && (
          <div className="hint">
            Read as <strong>{parsed.supplierLabel}</strong>
            {parsed.itemId ? <> item <span className="mono">{parsed.itemId}</span></> : null}. Saved without the tracking parameters.
          </div>
        )}
        {parsed && !parsed.ok && <div className="hint" style={{ color: 'var(--warn,#e0a33e)' }}>{parsed.reason}</div>}
      </div>

      <div className="field">
        <label>Variant link</label>
        <input className="input" value={form.variantUrl ?? ''} placeholder="the page for this exact colour or size"
               onChange={(e) => setForm({ ...form, variantUrl: e.target.value })} />
      </div>
      <div className="field">
        <label>Variant name</label>
        <input className="input" value={form.variantLabel ?? ''} placeholder="e.g. MOA Profile / Silver"
               onChange={(e) => setForm({ ...form, variantLabel: e.target.value })} />
      </div>
      <div className="field">
        <label>Supplier&rsquo;s title</label>
        <input className="input" value={form.title ?? ''}
               onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <div className="hint">Paste it from the page. Taobao blocks automated reading, so this is typed once.</div>
      </div>

      <div className="split3">
        <div className="field">
          <label>Unit price</label>
          <input className="input" type="number" step="0.01" value={form.price ?? ''}
                 onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </div>
        <div className="field">
          <label>Currency</label>
          <select className="select" value={form.currency ?? 'CNY'}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {['CNY', 'USD', 'TRY', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Shipping per unit</label>
          <input className="input" type="number" step="0.01" value={form.shippingCost ?? ''}
                 onChange={(e) => setForm({ ...form, shippingCost: e.target.value })} />
          <div className="hint">To your forwarder.</div>
        </div>
      </div>

      <div className="field">
        <label>Minimum order</label>
        <input className="input" type="number" value={form.moq ?? ''}
               onChange={(e) => setForm({ ...form, moq: e.target.value })} />
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea className="textarea" value={form.notes ?? ''}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>

      {item.landedCostUsd != null && (
        <Banner kind="info">
          Landed cost {item.landedCost} {item.currency} — {fmtMoney(item.landedCostUsd, 'USD')} at the rate of {item.rateDay}.
        </Banner>
      )}
    </Drawer>
  );
}

function ImportModal({ open, onClose, onDone }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const run = async () => {
    setBusy(true);
    try { setResult(await api.post('/supply/import', { text })); onDone(); }
    catch (err) { showError(err, 'Could not read that'); } finally { setBusy(false); }
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} lg title="Bring your Taobao sheet across"
           footer={<><div className="spacer" /><button className="btn primary" onClick={run} disabled={busy || !text.trim()}>
             {busy ? <Spinner /> : 'Import'}</button></>}>
      <p className="dim small">
        One row per SKU: <span className="mono">SKU, main link, variant link, price, currency</span>.
        Only the first two are required. Commas, semicolons or tabs all work, so a paste straight out of
        Excel is fine. A header row is skipped.
      </p>
      <textarea className="textarea mono" rows={10} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={'KC001-01, https://item.taobao.com/item.htm?id=1012415746554, , 18.50, CNY'} />
      {result && (
        <>
          <Banner kind={result.failed ? 'warn' : 'ok'}>
            {result.saved} row(s) saved{result.failed ? `, ${result.failed} refused` : ''}. {result.note ?? ''}
          </Banner>
          {result.errors?.length > 0 && (
            <table className="data">
              <thead><tr><th>Line</th><th>Why it was refused</th></tr></thead>
              <tbody>
                {result.errors.map((e) => (
                  <tr key={e.line}><td className="num small">{e.line}</td><td className="small">{e.reason}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}
