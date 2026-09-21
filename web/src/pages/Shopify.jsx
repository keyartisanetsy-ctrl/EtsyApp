import React, { useState } from 'react';
import api, { withBase } from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Drawer, Thumb, Tabs, Help,
  useAsync, useToast, useErrorToast, fmtMoney, fmtDateTime, DecimalInput,
} from '../components/ui.jsx';
import { SendToAirtable } from './Airtable.jsx';
import StockCheckCell from '../components/StockCheck.jsx';
import WarehousePhotoCell from '../components/WarehousePhoto.jsx';

/**
 * Shopify: connect a store, mirror its products/variants and orders, edit
 * them here, and push tracking back as a real fulfillment - the same
 * local-mirror-then-push shape this app already uses for Etsy.
 */
export default function Shopify() {
  const [tab, setTab] = useState('connection');
  const status = useAsync(() => api.get('/shopify/status'), []);

  return (
    <Page
      title="Shopify"
      subtitle={status.data?.shop ? `Active: ${status.data.shop.shopName || status.data.shop.shopDomain}` : 'Not connected'}
    >
      <div className="mb16">
        <Tabs
          tabs={[
            { id: 'connection', label: 'Connection' },
            { id: 'products', label: 'Products & SKUs' },
            { id: 'orders', label: 'Orders' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'connection' && <ConnectionPanel status={status} />}
      {tab === 'products' && (status.data?.connected
        ? <ProductsPanel />
        : <Empty icon="🛍" title="Connect Shopify first">Add your shop domain and a token under Connection.</Empty>)}
      {tab === 'orders' && (status.data?.connected
        ? <OrdersPanel />
        : <Empty icon="🛍" title="Connect Shopify first">Add your shop domain and a token under Connection.</Empty>)}
    </Page>
  );
}

/* -------------------------------------------------------------- connection */

function ConnectionPanel({ status }) {
  const toast = useToast();
  const showError = useErrorToast();
  const s = status.data;
  const [domain, setDomain] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [customToken, setCustomToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  if (!s) return <Spinner />;

  const accounts = s.accounts ?? [];
  const redirectUri = `${window.location.origin}${withBase('/api/shopify/oauth/callback')}`;

  const saveOAuthApp = async () => {
    await api.put('/shopify/oauth-app', { clientId: clientId || undefined, clientSecret: clientSecret || undefined });
    setClientSecret('');
  };

  const connect = async () => {
    if (!domain.trim()) return showError(new Error('Enter a shop domain first.'));
    setBusy(true);
    try {
      if (clientId || clientSecret) await saveOAuthApp();
      const r = await api.post('/shopify/oauth/connect', { shopDomain: domain.trim() });
      window.location.href = r.url;
    } catch (err) { showError(err, 'Could not start the connection'); setBusy(false); }
  };

  const saveToken = async () => {
    if (!domain.trim()) return showError(new Error('Enter a shop domain first.'));
    setBusy(true);
    try {
      await api.post('/shopify/token', { shopDomain: domain.trim(), token: customToken });
      setCustomToken(''); setDomain('');
      toast({ kind: 'ok', title: 'Store connected' });
      status.reload();
    } catch (err) { showError(err, 'Could not save the token'); } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true);
    setTestResult(null);
    try { const r = await api.get('/shopify/test'); setTestResult(r); toast({ kind: 'ok', title: `Shopify answered: ${r.name}` }); }
    catch (err) { showError(err, 'Shopify refused the token'); } finally { setBusy(false); }
  };

  const useStore = async (id) => {
    try { await api.post(`/shopify/accounts/${id}/activate`, {}); status.reload(); toast({ kind: 'ok', title: 'Switched store' }); }
    catch (err) { showError(err); }
  };

  const removeStore = async (id, label) => {
    if (!confirm(`Disconnect ${label}?\n\nIts locally stored products and orders are removed too. Nothing on Shopify changes.`)) return;
    try { await api.del(`/shopify/accounts/${id}`, {}); status.reload(); toast({ kind: 'ok', title: 'Store disconnected' }); }
    catch (err) { showError(err); }
  };

  return (
    <section className="card">
      <div className="flex wrap">
        <h3>🛍 Shopify (optional)</h3>
        <span className={`badge ${accounts.length ? 'ok' : 'muted'}`}>
          {accounts.length ? `${accounts.length} connected` : 'none connected'}
        </span>
      </div>

      {accounts.length > 0 && (
        <table className="data mb16">
          <thead><tr><th /><th>Store</th><th>Via</th><th>Airtable name</th><th /></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.isActive ? <span className="badge green">active</span> : <span className="badge grey">idle</span>}</td>
                <td className="mono small">{a.shopName || a.shopDomain}</td>
                <td className="small dim">{a.connectedVia === 'oauth' ? 'OAuth app' : 'custom token'}</td>
                <td><AirtableNameCell account={a} onSaved={status.reload} /></td>
                <td>
                  <div className="flex gap4">
                    {!a.isActive && <button className="btn xs" onClick={() => useStore(a.id)}>Use this</button>}
                    <button className="btn xs danger" onClick={() => removeStore(a.id, a.shopName || a.shopDomain)}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Banner kind="info">
        <div>
          Every screen (products, orders) shows only the active store's own data; nothing is ever mixed between
          stores. One Shopify app can connect any number of stores - enter its Client ID/Secret once below, then
          repeat the domain field for each additional store.
        </div>
      </Banner>

      <div className="field mt8">
        <label>Shop domain to connect (….myshopify.com)</label>
        <input className="input" placeholder="yourshop.myshopify.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
      </div>

      <hr />

      <div className="section-title">A) Connect via OAuth (Dev Dashboard app)</div>
      <div className="field">
        <label>Client ID</label>
        <input className="input" placeholder={s.clientIdPreview || 'from your Shopify app'}
               value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="field">
        <label>Client Secret</label>
        <input type="password" className="input" placeholder={s.hasClientSecret ? '••••••••' : 'from your Shopify app'}
               value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </div>
      <p className="small muted">
        Under App settings → Redirect / Allowed redirection URL(s), add exactly this address, with
        {' '}<code>read_products</code>, <code>write_products</code>, <code>read_orders</code>,
        {' '}<code>write_orders</code> and <code>write_fulfillments</code> among the scopes, then press the button below:
        <br /><code className="mono">{redirectUri}</code>
      </p>
      <button className="btn primary lg" style={{ width: '100%' }} disabled={busy || !domain.trim()} onClick={connect}>
        {busy ? <Spinner /> : accounts.length ? '+ Connect another store' : 'Connect to Shopify'}
      </button>

      <hr />

      <div className="section-title">B) Or paste a custom app token</div>
      <div className="field">
        <label>Admin API access token</label>
        <input className="input mono" placeholder="shpat_..." value={customToken} onChange={(e) => setCustomToken(e.target.value)} />
      </div>
      <p className="small muted">
        Classic path: in that store's admin, Settings → Apps → Develop apps → create a custom app → give it
        {' '}<code>read_products</code>/<code>write_products</code>/<code>read_orders</code>/<code>write_orders</code>/
        <code>write_fulfillments</code> → Install → copy the "Admin API access token" (starts <code>shpat_</code>, not
        the Client ID/Secret). Enter that store's domain above first.
      </p>
      <button className="btn" disabled={busy || !domain.trim() || !customToken.trim()} onClick={saveToken}>Save token</button>

      <div className="flex mt16">
        <button className="btn sm" disabled={busy || !s.connected} onClick={test}>{busy ? <Spinner /> : "Validate active store's API"}</button>
      </div>

      {testResult && (
        <div className="mt8">
          <Banner kind="ok">{testResult.name} · {testResult.myshopifyDomain} · {testResult.plan?.displayName}</Banner>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- products */

function ProductsPanel() {
  const toast = useToast();
  const showError = useErrorToast();
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [edits, setEdits] = useState({}); // variantId -> {sku, price, compareAtPrice, cost}
  const [supplyEdits, setSupplyEdits] = useState({}); // sku -> meta
  const [saving, setSaving] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  const { data, loading, reload } = useAsync(() => api.get('/shopify/products', { search }), [search]);
  const rows = data?.rows ?? [];

  const sync = async () => {
    setSyncing(true);
    try { const r = await api.post('/shopify/sync/products', {}); toast({ kind: 'ok', title: `Synced ${r.products} product(s), ${r.variants} variant(s)` }); reload(); }
    catch (err) { showError(err, 'Sync failed'); } finally { setSyncing(false); }
  };

  const stage = (variantId, field, value) => setEdits((e) => ({ ...e, [variantId]: { ...e[variantId], [field]: value } }));
  const stageSupply = (sku, field, value) => setSupplyEdits((e) => ({ ...e, [sku]: { ...e[sku], [field]: value } }));
  const dirtyCount = Object.keys(edits).length + Object.keys(supplyEdits).length;

  const saveAll = async () => {
    setSaving(true);
    let ok = 0;
    let failed = 0;
    try {
      const byProduct = {};
      for (const [variantId, change] of Object.entries(edits)) {
        const row = rows.find((r) => String(r.variantId) === String(variantId));
        if (!row) continue;
        (byProduct[row.productId] ||= {})[variantId] = change;
      }
      for (const [productId, changes] of Object.entries(byProduct)) {
        try { await api.put(`/shopify/products/${encodeURIComponent(productId)}/variants`, { changes }); ok += Object.keys(changes).length; }
        catch (err) { failed += Object.keys(changes).length; showError(err, `Product rejected`); }
      }
      for (const [sku, meta] of Object.entries(supplyEdits)) {
        if (!sku) continue;
        try { await api.put(`/shopify/variants/meta/${encodeURIComponent(sku)}`, meta); } catch (err) { showError(err, `Could not save supply info for ${sku}`); }
      }
      if (ok || Object.keys(supplyEdits).length) {
        toast({ kind: failed ? 'warn' : 'ok', title: 'Saved', body: `${ok} variant(s) pushed to Shopify${failed ? `, ${failed} failed` : ''}` });
      }
      setEdits({}); setSupplyEdits({}); reload();
    } finally { setSaving(false); }
  };

  return (
    <section className="card">
      <div className="flex wrap mb16">
        <input className="input search" placeholder="Search title or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="spacer" />
        {dirtyCount > 0 && <button className="btn primary sm" disabled={saving} onClick={saveAll}>{saving ? <Spinner /> : `Save ${dirtyCount} change(s)`}</button>}
        <button className="btn sm" disabled={syncing} onClick={sync}>{syncing ? <Spinner /> : '↻ Sync from Shopify'}</button>
      </div>

      {loading && !data ? <Spinner /> : rows.length === 0 ? (
        <Empty icon="⧉" title="No products yet">Press "Sync from Shopify" to pull your catalogue.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="col-tight">Image</th>
              <th>SKU</th>
              <th>Product</th>
              <th className="small dim">Variation</th>
              <th className="num">Price</th>
              <th className="num">Compare-at</th>
              <th className="num">Cost</th>
              <th className="num">Qty</th>
              <th>Supply link</th>
              <th>Stock <Help text="Live per-variant stock and price from OneBound. A variant with 0 or unreported stock - or a nonsense repeating-digit price like 333/9999/99999, a common sold-out placeholder - is flagged as out of stock. Only checked when you press ↻, since each check is a paid call." /></th>
              <th className="col-tight" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const edit = edits[r.variantId] ?? {};
              const supply = supplyEdits[r.sku] ?? {};
              const sku = edit.sku ?? r.sku;
              const price = edit.price ?? r.price;
              const cost = edit.cost ?? r.cost;
              const supplyLink = supply.supplyLink ?? r.supplyLink;
              const isDirty = edits[r.variantId] || supplyEdits[r.sku];
              return (
                <tr key={r.variantId} style={isDirty ? { boxShadow: 'inset 3px 0 0 var(--brand)' } : undefined}>
                  <td><Thumb src={r.imageUrl} alt="" /></td>
                  <td><input className="input sm mono" style={{ width: 120 }} value={sku ?? ''} placeholder="— none —"
                              onChange={(e) => stage(r.variantId, 'sku', e.target.value)} /></td>
                  <td className="cell-title" title={r.productTitle}>
                    <button className="btn xs ghost" onClick={() => setEditingProduct(r.productId)}>{r.productTitle}</button>
                  </td>
                  <td className="small dim">{r.variantTitle}</td>
                  <td className="num"><DecimalInput className="input sm right" style={{ width: 76 }} value={price ?? ''}
                              onChange={(v) => stage(r.variantId, 'price', v)} /></td>
                  <td className="num"><DecimalInput className="input sm right" style={{ width: 76 }} value={edit.compareAtPrice ?? r.compareAtPrice ?? ''}
                              onChange={(v) => stage(r.variantId, 'compareAtPrice', v)} /></td>
                  <td className="num"><DecimalInput className="input sm right" style={{ width: 76 }} value={cost ?? ''}
                              onChange={(v) => stage(r.variantId, 'cost', v)} /></td>
                  <td className="num small dim">{r.inventoryQuantity ?? '—'}</td>
                  <td>
                    <input className="input sm" style={{ width: 180 }} placeholder="supplier link"
                           value={supplyLink} onChange={(e) => stageSupply(r.sku, 'supplyLink', e.target.value)} disabled={!r.sku} />
                  </td>
                  <td><StockCheckCell url={supplyLink} compact /></td>
                  <td className="small dim">{r.margin != null ? `margin ${r.margin}` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editingProduct && <ProductEditor productId={editingProduct} onClose={() => setEditingProduct(null)} onSaved={() => { setEditingProduct(null); reload(); }} />}
    </section>
  );
}

function ProductEditor({ productId, onClose, onSaved }) {
  const toast = useToast();
  const showError = useErrorToast();
  const { data, loading } = useAsync(() => api.get(`/shopify/products/${encodeURIComponent(productId)}`), [productId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  if (data && !form) setForm({ title: data.title, descriptionHtml: data.descriptionHtml || '', vendor: data.vendor || '', productType: data.productType || '', tags: (data.tags ?? []).join(', '), status: data.status });

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/shopify/products/${encodeURIComponent(productId)}`, {
        ...form, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      toast({ kind: 'ok', title: 'Product updated' });
      onSaved();
    } catch (err) { showError(err, 'Shopify rejected the update'); } finally { setSaving(false); }
  };

  return (
    <Drawer open onClose={onClose} title={data?.title ?? 'Product'}
            footer={<button className="btn primary" disabled={saving || !form} onClick={save}>{saving ? <Spinner /> : 'Save to Shopify'}</button>}>
      {loading || !form ? <Spinner /> : (
        <>
          <div className="field"><label>Title</label><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div className="field"><label>Description (HTML)</label><textarea className="textarea" rows={6} value={form.descriptionHtml} onChange={(e) => setForm({ ...form, descriptionHtml: e.target.value })} /></div>
          <div className="field"><label>Vendor</label><input className="input" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
          <div className="field"><label>Product type</label><input className="input" value={form.productType} onChange={(e) => setForm({ ...form, productType: e.target.value })} /></div>
          <div className="field"><label>Tags (comma separated)</label><input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></div>
          <div className="field">
            <label>Status</label>
            <select className="select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
        </>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ orders */

function OrdersPanel() {
  const toast = useToast();
  const showError = useErrorToast();
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [sendingToAirtable, setSendingToAirtable] = useState(null);
  const { data, loading, reload } = useAsync(() => api.get('/shopify/orders', { search }), [search]);
  const rows = data?.rows ?? [];

  const sync = async () => {
    setSyncing(true);
    try { const r = await api.post('/shopify/sync/orders', {}); toast({ kind: 'ok', title: `Synced ${r.orders} order(s)` }); reload(); }
    catch (err) { showError(err, 'Sync failed'); } finally { setSyncing(false); }
  };

  const toggle = (id) => setSelected((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.orderId));

  return (
    <section className="card">
      <div className="flex wrap mb16">
        <input className="input search" placeholder="Search order, buyer or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="spacer" />
        {selected.size > 0 && (
          <button className="btn sm primary" onClick={() => setSendingToAirtable([...selected])}>⇉ Send {selected.size} to Airtable</button>
        )}
        <button className="btn sm" disabled={syncing} onClick={sync}>{syncing ? <Spinner /> : '↻ Sync from Shopify'}</button>
      </div>

      {loading && !data ? <Spinner /> : rows.length === 0 ? (
        <Empty icon="▣" title="No orders yet">Press "Sync from Shopify" to pull recent orders.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="col-tight">
                <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.orderId)))} />
              </th>
              <th>Order</th><th>Buyer</th><th>Financial</th><th>Fulfillment</th>
              <th className="num">Total</th><th className="right">Shipping cost</th><th>Tracking</th><th>Airtable</th><th className="col-tight" />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.orderId}>
                <td><Checkbox checked={selected.has(o.orderId)} onChange={() => toggle(o.orderId)} /></td>
                <td className="mono small">{o.name}</td>
                <td className="small">{o.customerName || '—'}</td>
                <td><span className="badge muted">{o.financialStatus}</span></td>
                <td><span className={`badge ${o.fulfillmentStatus === 'FULFILLED' ? 'green' : 'muted'}`}>{o.fulfillmentStatus || 'UNFULFILLED'}</span></td>
                <td className="num">{fmtMoney(o.total, o.currency)}</td>
                <td className="right"><ShippingCostCell row={o} onSaved={reload} /></td>
                <td className="small mono">{o.trackingNumber || '—'}</td>
                <td>
                  {o.airtablePushedAt
                    ? <span className="badge green" title={`Sent ${fmtDateTime(Date.parse(o.airtablePushedAt) / 1000)}`}>✓</span>
                    : <span className="muted small">—</span>}
                </td>
                <td><button className="btn xs" onClick={() => setDetail(o.orderId)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <OrderDetail orderId={detail} onClose={() => setDetail(null)} onChanged={reload} />

      {sendingToAirtable && (
        <SendToAirtable
          receiptIds={sendingToAirtable}
          channel="shopify"
          onClose={() => setSendingToAirtable(null)}
          onDone={() => { setSendingToAirtable(null); setSelected(new Set()); reload(); }}
        />
      )}
    </section>
  );
}

/** The name this store goes by in Airtable's shop/store column - separate
 *  from the domain, since a select column in Airtable is often spelled
 *  differently. Mirrors Etsy's own "Shop names in Airtable" panel, just
 *  scoped to Shopify stores instead of Etsy shops. */
function AirtableNameCell({ account, onSaved }) {
  const showError = useErrorToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(account.airtableName || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/shopify/accounts/${account.id}`, { airtableName: value });
      setEditing(false); onSaved?.();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <button className="btn xs ghost" onClick={() => { setValue(account.airtableName || ''); setEditing(true); }}>
        {account.airtableName || <span className="muted">add</span>}
      </button>
    );
  }
  return (
    <span className="flex gap4">
      <input className="input sm" style={{ width: 120 }} autoFocus value={value} onChange={(e) => setValue(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
      <button className="btn xs primary" onClick={save} disabled={busy}>✓</button>
    </span>
  );
}

function ShippingCostCell({ row, onSaved }) {
  const showError = useErrorToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.shippingCost ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/shopify/orders/${encodeURIComponent(row.orderId)}/shipping-cost`, { cost: value === '' ? null : Number(value), currency: row.shippingCostCurrency || undefined });
      setEditing(false); onSaved?.();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <button className="btn xs ghost" onClick={() => { setValue(row.shippingCost ?? ''); setEditing(true); }}>
        {row.shippingCost == null ? <span className="muted">add</span> : <>{row.shippingCost} <span className="muted">{row.shippingCostCurrency || ''}</span></>}
      </button>
    );
  }
  return (
    <span className="flex gap4">
      <DecimalInput className="input sm" style={{ width: 78 }} autoFocus value={value} onChange={setValue}
                     onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
      <button className="btn xs primary" onClick={save} disabled={busy}>✓</button>
      <button className="btn xs ghost" onClick={() => setEditing(false)}>✕</button>
    </span>
  );
}

function OrderDetail({ orderId, onClose, onChanged }) {
  const toast = useToast();
  const showError = useErrorToast();
  const { data, loading, reload } = useAsync(() => (orderId ? api.get(`/shopify/orders/${encodeURIComponent(orderId)}`) : null), [orderId], { immediate: !!orderId });
  const [tracking, setTracking] = useState('');
  const [company, setCompany] = useState('');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [supplierRef, setSupplierRef] = useState('');
  const [supplyTrack, setSupplyTrack] = useState('');

  React.useEffect(() => {
    setSupplierRef(data?.supplierOrderRef ?? '');
    setSupplyTrack(data?.supplyTrackingNumber ?? '');
  }, [data?.orderId]);

  if (!orderId) return null;

  const orderPath = `/shopify/orders/${encodeURIComponent(orderId)}`;

  const fulfill = async () => {
    setBusy(true);
    try {
      await api.post(`${orderPath}/fulfill`, { trackingNumber: tracking, trackingCompany: company || undefined, notifyCustomer: notify });
      toast({ kind: 'ok', title: 'Fulfillment pushed to Shopify' });
      reload(); onChanged();
    } catch (err) { showError(err, 'Could not fulfill'); } finally { setBusy(false); }
  };

  const saveSupplierInfo = async () => {
    try {
      await api.post(`${orderPath}/supplier-info`, { supplierOrderRef: supplierRef, supplyTrackingNumber: supplyTrack });
      toast({ kind: 'ok', title: 'Supplier info saved' });
      reload(); onChanged();
    } catch (err) { showError(err); }
  };

  return (
    <Drawer open onClose={onClose} title={data?.name ?? orderId}>
      {loading || !data ? <Spinner /> : (
        <>
          <dl className="kv mb16">
            <dt>Buyer</dt>
            <dd>
              {data.customerName || '—'} {data.email ? `· ${data.email}` : ''}
              {data.phone && <div className="small dim">{data.phone}</div>}
            </dd>
            <dt>Ship to</dt><dd>{[data.shipName, data.shipAddress1, data.shipCity, data.shipCountry].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Financial</dt><dd>{data.financialStatus}</dd>
            <dt>Fulfillment</dt><dd>{data.fulfillmentStatus || 'UNFULFILLED'}</dd>
            <dt>Total</dt><dd>{fmtMoney(data.total, data.currency)}</dd>
            {data.discountCodes?.length > 0 && (
              <>
                <dt>Discount</dt>
                <dd>{data.discountCodes.join(', ')} {data.discounts ? `(−${fmtMoney(data.discounts, data.currency)})` : ''}</dd>
              </>
            )}
            {data.tags?.length > 0 && (
              <>
                <dt>Tags</dt>
                <dd>{data.tags.map((t) => <span key={t} className="badge muted" style={{ marginRight: 4 }}>{t}</span>)}</dd>
              </>
            )}
            {data.riskLevel && (
              <>
                <dt>Risk</dt>
                <dd>
                  <span className={`badge ${data.riskLevel === 'HIGH' ? 'red' : data.riskLevel === 'MEDIUM' ? 'amber' : 'green'}`}>
                    {data.riskLevel.toLowerCase()}
                  </span>
                </dd>
              </>
            )}
            {(data.sourceName || data.attributionSource) && (
              <>
                <dt>Source</dt>
                <dd>
                  {data.sourceName || '—'}
                  {data.attributionSource && data.attributionSource !== data.sourceName && ` (${data.attributionSource})`}
                  {data.attributionLandingPage && <div className="small dim">Landing: {data.attributionLandingPage}</div>}
                </dd>
              </>
            )}
            {data.note && (
              <>
                <dt>Note</dt>
                <dd>{data.note}</dd>
              </>
            )}
            <dt>Airtable</dt>
            <dd>
              {data.airtablePushedAt
                ? <span className="badge green">Sent {fmtDateTime(Date.parse(data.airtablePushedAt) / 1000)}</span>
                : <span className="muted small">not sent yet</span>}
            </dd>
          </dl>

          <div className="section-title">Items</div>
          <table className="data mb16">
            <thead><tr><th>SKU</th><th>Title</th><th>Variant</th><th className="num">Qty</th><th className="num">Price</th><th>Depo görseli</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.lineItemId}>
                  <td className="mono small">{i.sku || '—'}</td>
                  <td className="small">{i.title}</td>
                  <td className="small dim">{i.variantTitle}</td>
                  <td className="num">{i.quantity}</td>
                  <td className="num">{fmtMoney(i.price, i.currency)}</td>
                  <td>
                    <WarehousePhotoCell channel="shopify" orderPath={orderPath} item={i} onChanged={() => { reload(); onChanged(); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="section-title">Supplier</div>
          <dl className="kv mb16">
            <dt>Supplier order code</dt>
            <dd><input className="input sm" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)}
                       placeholder="e.g. the order number on the supplier's site" /></dd>
            <dt>Supply tracking no.</dt>
            <dd><input className="input sm" value={supplyTrack} onChange={(e) => setSupplyTrack(e.target.value)}
                       placeholder="Inbound: supplier → warehouse" /></dd>
          </dl>
          <button className="btn sm mb16" onClick={saveSupplierInfo}>Save supplier info</button>

          <div className="section-title">Tracking</div>
          {data.trackingNumber ? (
            <div className="small mb16">
              {data.trackingNumber} {data.trackingCompany ? `via ${data.trackingCompany}` : ''}
              {data.trackingUrl && <> · <a href={data.trackingUrl} target="_blank" rel="noreferrer">track</a></>}
              {data.pushedAt && <div className="muted">pushed {fmtDateTime(Date.parse(data.pushedAt) / 1000)}</div>}
            </div>
          ) : (
            <div className="flex mb16" style={{ flexWrap: 'wrap' }}>
              <input className="input sm" placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
              <input className="input sm" placeholder="Carrier (optional)" value={company} onChange={(e) => setCompany(e.target.value)} />
              <Checkbox checked={notify} onChange={setNotify} label="Notify customer" />
              <button className="btn sm primary" disabled={busy || !tracking.trim()} onClick={fulfill}>{busy ? <Spinner /> : 'Fulfill on Shopify'}</button>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
