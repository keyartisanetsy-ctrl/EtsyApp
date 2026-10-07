import React, { useState } from 'react';
import api, { withBase } from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Drawer, Modal, Thumb, Tabs, Help,
  useAsync, useToast, useErrorToast, fmtMoney, fmtDateTime, DecimalInput,
} from '../components/ui.jsx';
import { SendToAirtable } from './Airtable.jsx';
import StockCheckCell from '../components/StockCheck.jsx';
import WarehousePhotoCell from '../components/WarehousePhoto.jsx';
import { OrderCode, ArrivalChip } from '../components/OrderCode.jsx';
import { SupplyCell, WarehouseCell, ProductImageCell } from '../components/OrderSupplyPreview.jsx';

// Shopify only auto-builds a tracking link (and shows one in the shipping
// confirmation email) for a carrier name it recognises exactly, capitalization
// included - "YunExpress", not "Yunexpress" or "yunexpress". Typed in any other
// casing, the tracking number is still saved and pushed, just without a
// clickable link for the customer.
const SHOPIFY_KNOWN_CARRIER = 'YunExpress';

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
              <th className="col-tight">First</th>
              <th className="col-tight" title="This exact variant's own photo - blank when Shopify has none for it">Variant</th>
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
                  <td><Thumb src={r.firstImageUrl} alt="" /></td>
                  <td><Thumb src={r.variantImageUrl} alt="" fallback="–" /></td>
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
  const [syncingLedger, setSyncingLedger] = useState(false);
  const [detail, setDetail] = useState(null);
  const [quickTrackId, setQuickTrackId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [sendingToAirtable, setSendingToAirtable] = useState(null);
  const [showCanceled, setShowCanceled] = useState(false);
  const { data, loading, reload } = useAsync(
    () => api.get('/shopify/orders', { search, canceled: showCanceled ? true : undefined }), [search, showCanceled]);
  const rows = data?.rows ?? [];

  const sync = async () => {
    setSyncing(true);
    try { const r = await api.post('/shopify/sync/orders', {}); toast({ kind: 'ok', title: `Synced ${r.orders} order(s)` }); reload(); }
    catch (err) { showError(err, 'Sync failed'); } finally { setSyncing(false); }
  };

  /**
   * Shopify Payments' own balance ledger - the real per-order fee/net (Payouts
   * > Transactions), not the rate-card estimate. `hasAccount: false` in the
   * response means the store's token has no read_shopify_payments_accounts
   * scope yet - reconnect the store (Settings > Shopify) to grant it.
   */
  const syncLedger = async () => {
    setSyncingLedger(true);
    try {
      const r = await api.post('/shopify/sync/balance-transactions', {});
      if (!r.hasAccount) {
        toast({ kind: 'info', title: 'No Shopify Payments ledger access', body: 'Reconnect this store (Settings > Shopify) to grant read_shopify_payments_accounts, then try again.', duration: 12000 });
      } else {
        toast({ kind: 'ok', title: `Synced ${r.transactions} real fee/net entr${r.transactions === 1 ? 'y' : 'ies'}` });
      }
      reload();
    } catch (err) { showError(err, 'Balance-ledger sync failed'); } finally { setSyncingLedger(false); }
  };

  /**
   * Cancel here means here only. Shopify's API could really cancel (and
   * refund/restock) the order, but this app deliberately never calls that -
   * it just hides the order from this list, same as the Etsy side.
   */
  const cancelOrder = async (order) => {
    if (!confirm(`Cancel order ${order.name} (${order.customerName || 'no name'})?\n\n`
      + 'This only hides it in this app - nothing changes on Shopify, and the customer is not notified. '
      + 'You can find it again with "Show canceled" and restore it.')) return;
    try {
      await api.post(`/shopify/orders/${encodeURIComponent(order.orderId)}/flags`, { canceled: true });
      toast({ kind: 'ok', title: `Order ${order.name} canceled here` });
      reload();
    } catch (err) { showError(err, 'Could not cancel that'); }
  };

  const restoreOrder = async (order) => {
    try {
      await api.post(`/shopify/orders/${encodeURIComponent(order.orderId)}/flags`, { canceled: false });
      toast({ kind: 'ok', title: `Order ${order.name} restored` });
      reload();
    } catch (err) { showError(err, 'Could not restore that'); }
  };

  const toggle = (id) => setSelected((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.orderId));

  return (
    <section className="card">
      <div className="flex wrap mb16">
        <input className="input search" placeholder="Search order, buyer or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span title="Canceled orders (Shopify's own, or ones you canceled here) are hidden by default - tick this to find and restore one">
          <Checkbox checked={showCanceled} onChange={setShowCanceled} label="Show canceled" />
        </span>
        <div className="spacer" />
        {selected.size > 0 && (
          <button className="btn sm primary" onClick={() => setSendingToAirtable([...selected])}>⇉ Send {selected.size} to Airtable</button>
        )}
        <ShopCampaignsPanel />
        <button className="btn sm" disabled={syncingLedger} onClick={syncLedger}
          title="Pull Shopify Payments' own balance ledger - the real per-order fee/net, matching Payouts > Transactions">
          {syncingLedger ? <Spinner /> : '↻ Sync real fees'}
        </button>
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
              <th className="num">Total</th><th className="right">Shipping cost</th><th className="right">Supply cost</th><th>Tracking</th><th>Airtable</th>
              <th title="Supplier link, order number and inbound tracking number">Supply</th>
              <th title="The item's own listing/variant photo">Photo</th>
              <th title="Photo taken at the warehouse, next to the item's own listing photo">Warehouse</th>
              <th className="col-tight" />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.orderId}>
                <td><Checkbox checked={selected.has(o.orderId)} onChange={() => toggle(o.orderId)} /></td>
                <td className="mono small">
                  {o.name}
                  {(o.isCanceled || o.isLocallyCanceled) && (
                    <span className="badge red" style={{ marginLeft: 6 }}
                      title={o.isLocallyCanceled ? 'Canceled here - Shopify is not affected' : 'Shopify reports this order as cancelled'}>
                      {o.isLocallyCanceled ? 'Canceled (you)' : 'Canceled'}
                    </span>
                  )}
                  {o.isShopAdsAttributed && (
                    <span className="badge violet" style={{ marginLeft: 6 }}
                      title={o.shopAdsSource === 'ledger' ? "Confirmed by Shopify's own referral-fee ledger line"
                        : o.shopAdsSource === 'override' ? 'Marked Shop ads by hand'
                        : 'Guessed from tags/sales channel - open the order to correct it if wrong'}>
                      Shop ads
                    </span>
                  )}
                  {o.code && <div><OrderCode code={o.code} /></div>}
                  {o.arrival && <div style={{ marginTop: 3 }}><ArrivalChip arrival={o.arrival} /></div>}
                </td>
                <td className="small">
                  {o.customerName || '—'}
                  {o.notes && (
                    <button className="btn xs ghost" style={{ marginLeft: 6 }} title={o.notes}
                      onClick={() => setDetail(o.orderId)}>📝</button>
                  )}
                </td>
                <td><span className="badge muted">{o.financialStatus}</span></td>
                <td><span className={`badge ${o.fulfillmentStatus === 'FULFILLED' ? 'green' : 'muted'}`}>{o.fulfillmentStatus || 'UNFULFILLED'}</span></td>
                <td className="num">
                  {(o.isCanceled || o.isLocallyCanceled) ? (
                    <>
                      {fmtMoney(0, o.currency)}
                      <div className="small muted" style={{ textDecoration: 'line-through' }}>{fmtMoney(o.total, o.currency)}</div>
                    </>
                  ) : (
                    <>
                      {fmtMoney(o.displayTotal?.value ?? o.total, o.currency)}
                      {o.refundedAmount && (
                        <div className="small" style={{ color: 'var(--warn, #e0a33e)' }}
                             title="Part of this order's payment has been refunded">
                          (−{fmtMoney(o.refundedAmount.value, o.refundedAmount.currency)} refunded)
                        </div>
                      )}
                      {o.realNet && (
                        <div className="small dim"
                          title={(o.paymentFees ? `−${fmtMoney(o.paymentFees.value, o.paymentFees.currency)} Shopify Payments fee` : 'No processing fee reported (not a Shopify Payments charge)')
                            + (o.feeSource === 'estimate' ? ' (rate-card estimate - press "Sync real fees" for the actual number)' : o.feeSource === 'ledger' ? ' (Shopify Payments\' own ledger)' : '')}>
                          net: {fmtMoney(o.realNet.value, o.realNet.currency)}{o.feeSource === 'estimate' && <sup>~</sup>}
                        </div>
                      )}
                      {o.manualCost && (
                        <div className="small dim" title={o.manualCost.note || 'Typed in manually - open the order to edit'}>
                          manual: −{fmtMoney(o.manualCost.value, o.manualCost.currency)}
                        </div>
                      )}
                      {o.costBreakdown?.profit && (
                        <div className="small" style={{ fontWeight: 600 }}
                             title="Net minus shipping cost, supply cost and manual cost">
                          profit: {fmtMoney(o.costBreakdown.profit.value, o.costBreakdown.profit.currency)}
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td className="right"><ShippingCostCell row={o} onSaved={reload} /></td>
                <td className="right"><SupplyCostCell row={o} onSaved={reload} /></td>
                <td className="small mono">
                  {o.trackingNumber || (
                    <button className="btn xs" onClick={() => setQuickTrackId(o.orderId)}
                      title="Add tracking and fulfill this order on Shopify without opening it">+ Add</button>
                  )}
                </td>
                <td>
                  {o.airtablePushedAt
                    ? <span className="badge green" title={`Sent ${fmtDateTime(Date.parse(o.airtablePushedAt) / 1000)}`}>✓</span>
                    : <span className="muted small">—</span>}
                </td>
                <td><SupplyCell order={o} channel="shopify" onChanged={reload} /></td>
                <td><ProductImageCell order={o} /></td>
                <td><WarehouseCell order={o} channel="shopify" onChanged={reload} /></td>
                <td>
                  <div className="flex gap4">
                    <button className="btn xs" onClick={() => setDetail(o.orderId)}>Open</button>
                    {o.isLocallyCanceled ? (
                      <button className="btn xs ghost" title="Bring this order back into the working queue"
                        onClick={() => restoreOrder(o)}>Restore</button>
                    ) : (
                      <button className="btn xs danger" title="Hide this order here - nothing changes on Shopify"
                        onClick={() => cancelOrder(o)}>Cancel</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <OrderDetail orderId={detail} onClose={() => setDetail(null)} onChanged={reload} />
      {quickTrackId && (
        <Modal open onClose={() => setQuickTrackId(null)} title="Add tracking">
          <QuickFulfillForm orderId={quickTrackId} onDone={() => { setQuickTrackId(null); reload(); }} />
        </Modal>
      )}

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

/**
 * What Shopify's own Shop Campaigns ads (run from inside the Shop app /
 * shop.app, not a third-party platform) have cost lately, by campaign. This
 * is entirely separate from Etsy's Offsite Ads fee - different platform,
 * different mechanics, its own screen. The numbers come from a ShopifyQL
 * query Shopify only answers once the merchant has requested its "Level 2
 * protected customer data" approval, so an unapproved store sees an
 * explanation here instead of a crash.
 */
function ShopCampaignsPanel() {
  const [open, setOpen] = useState(false);
  const [sinceDays, setSinceDays] = useState(30);
  const { data, loading, reload } = useAsync(
    () => (open ? api.get('/shopify/campaigns/ad-spend', { sinceDays }) : null),
    [open, sinceDays],
    { immediate: open },
  );

  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}
        title="Shopify's own Shop Campaigns ads: spend and return, by campaign">
        ◈ Shop Campaigns{data?.available && data.totals.adSpend ? ` · ${fmtMoney(data.totals.adSpend)}/${sinceDays}d` : ''}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Shop Campaigns" lg>
        <p className="small muted">
          Shop Campaigns are ads Shopify runs for you inside its own consumer Shop app / shop.app - a different
          product from a third-party ad platform, and unrelated to Etsy's Offsite Ads. Spend, sales and return
          are Shopify's own numbers, pulled per campaign.
        </p>

        <div className="flex mb8">
          <label className="small">Last</label>
          <select className="select sm" value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <div className="spacer" />
          <button className="btn xs" onClick={reload}>↻ Refresh</button>
        </div>

        {loading ? <Spinner /> : !data?.available ? (
          <Banner kind="warn">
            {data?.reason || 'Not available yet.'}
          </Banner>
        ) : data.campaigns.length === 0 ? (
          <Empty icon="◈" title="No Shop Campaigns activity" >No campaign orders in the last {sinceDays} days.</Empty>
        ) : (
          <>
            <Banner kind="info">
              Last {sinceDays} days, all campaigns: {fmtMoney(data.totals.adSpend)} spend, {fmtMoney(data.totals.sales)} sales
              {data.totals.roas != null ? `, ${data.totals.roas}x return` : ''}
              {data.totals.avgCac != null ? `, ${fmtMoney(data.totals.avgCac)} avg. cost per customer` : ''}.
            </Banner>
            <table className="data mt8">
              <thead>
                <tr>
                  <th>Campaign</th><th className="num">Ad spend</th><th className="num">Sales</th>
                  <th className="num">ROAS</th><th className="num">Avg. CAC</th><th className="num">Avg. order</th>
                  <th className="num">Customers</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="num">{fmtMoney(c.adSpend)}</td>
                    <td className="num">{fmtMoney(c.sales)}</td>
                    <td className="num">{c.roas != null ? `${c.roas}x` : '—'}</td>
                    <td className="num">{fmtMoney(c.avgCac)}</td>
                    <td className="num">{fmtMoney(c.avgOrderValue)}</td>
                    <td className="num">{c.customers ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Modal>
    </>
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

/** What the goods in this order actually cost, typed in right next to shipping cost - same idea as ShippingCostCell. */
function SupplyCostCell({ row, onSaved }) {
  const showError = useErrorToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.supplyCost ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/shopify/orders/${encodeURIComponent(row.orderId)}/supply-cost`, { cost: value === '' ? null : Number(value), currency: row.supplyCostCurrency || undefined });
      setEditing(false); onSaved?.();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <button className="btn xs ghost" onClick={() => { setValue(row.supplyCost ?? ''); setEditing(true); }}
              title={row.supplyCost == null ? 'No real figure typed in yet - the profit line above is using an estimate, if one is available' : ''}>
        {row.supplyCost == null ? <span className="muted">add</span> : <>{row.supplyCost} <span className="muted">{row.supplyCostCurrency || ''}</span></>}
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

/**
 * Everything money-related about this Shopify order, in one place: the total
 * (with cancel/refund treatment), Shopify's own transactions (with each
 * fee's type/rate and the VAT/GST it charges on top where that applies),
 * what it actually cost to ship and source the goods, the manual-cost
 * catch-all (including the Shop Campaigns attribution that field exists
 * for), and the profit left once all of it is accounted for. Lives on the
 * left of the drawer, so none of this is scattered a scroll apart from the
 * rest - a deliberately different layout from Etsy's finance panel, built
 * around what Shopify's API actually gives (transactions/fees, not a ledger).
 */
function ShopifyFinancePanel({ data, manualCost, setManualCost, manualCostNote, setManualCostNote, saveManualCost, setShopAds, onSaved }) {
  const isCanceled = data.isCanceled || data.isLocallyCanceled;
  const marginPct = (data.costBreakdown?.profit && data.total)
    ? Math.round((data.costBreakdown.profit.value / data.total) * 1000) / 10
    : null;

  return (
    <div className="finance-panel">
      <div className="card-head"><h3>Finance</h3></div>

      <div className="section-title">Total</div>
      <dl className="kv mb12">
        <dt>Subtotal</dt><dd>{fmtMoney(data.subtotal, data.currency)}</dd>
        <dt>Shipping</dt><dd>{fmtMoney(data.shipping, data.currency)}</dd>
        <dt>Tax</dt><dd>{fmtMoney(data.tax, data.currency)}</dd>
        {data.discountCodes?.length > 0 && (
          <>
            <dt>Discount</dt>
            <dd>{data.discountCodes.join(', ')} {data.discounts ? `(−${fmtMoney(data.discounts, data.currency)})` : ''}</dd>
          </>
        )}
        <dt><strong>Total</strong></dt>
        <dd>
          {isCanceled ? (
            <>
              <strong>{fmtMoney(0, data.currency)}</strong>
              <div className="small muted" style={{ textDecoration: 'line-through' }}>{fmtMoney(data.total, data.currency)}</div>
            </>
          ) : (
            <>
              <strong>{fmtMoney(data.displayTotal?.value ?? data.total, data.currency)}</strong>
              {data.refundedAmount && (
                <div className="small" style={{ color: 'var(--warn, #e0a33e)' }}>
                  (−{fmtMoney(data.refundedAmount.value, data.refundedAmount.currency)} refunded)
                </div>
              )}
            </>
          )}
        </dd>
      </dl>
      <div className="small dim mb12">
        {data.isShopAdsAttributed && (
          <div className="mb4">
            <span className="badge violet">Shop ads</span>{' '}
            {data.shopAdsSource === 'ledger'
              ? "confirmed by Shopify's own referral-fee ledger line"
              : data.shopAdsSource === 'override' ? 'marked by hand' : 'guessed from tags/sales channel'}
            {data.costBreakdown?.adSpend && (
              <> — {fmtMoney(data.costBreakdown.adSpend.value, data.costBreakdown.adSpend.currency)}
                {data.costBreakdown.adSpend.source === 'estimate' ? ' (flat estimate, order > $50)' : ' (real ledger amount)'}</>
            )}
          </div>
        )}
        <div className="flex wrap">
          <span>Shop ads for this order:</span>
          <button className={`btn sm ${data.shopAdsOverride == null ? 'primary' : ''}`} onClick={() => setShopAds(null)}>Auto</button>
          <button className={`btn sm ${data.shopAdsOverride === true ? 'primary' : ''}`} onClick={() => setShopAds(true)}>On</button>
          <button className={`btn sm ${data.shopAdsOverride === false ? 'primary' : ''}`} onClick={() => setShopAds(false)}>Off</button>
        </div>
      </div>

      {data.feeSource && (
        <div className="small dim mb8">
          {data.feeSource === 'ledger'
            ? "Net below is Shopify Payments' own ledger total (Payouts > Transactions) - the actual fee it charged, not an estimate."
            : 'Net below is a rate-card estimate - press "Sync real fees" (Orders toolbar) to pull the real numbers from Shopify Payments.'}
        </div>
      )}

      {data.ledgerLines?.length > 0 && (
        <>
          <div className="section-title">Real ledger (Shopify Payments)</div>
          <table className="data mb12">
            <thead><tr><th>Type</th><th className="num">Amount</th><th className="num">Fee</th><th className="num">Net</th></tr></thead>
            <tbody>
              {data.ledgerLines.map((l) => (
                <tr key={l.txnId} className={l.category !== 'settlement' ? 'dim' : undefined}>
                  <td className="small" title={l.category === 'marketing' ? 'Shop Campaigns activity - counted as ad spend below, not payment fees'
                    : l.category === 'other' ? 'Account-level activity referencing this order - not counted in net or ad spend above' : undefined}>
                    {l.label}{l.category !== 'settlement' && <span className="small dim"> ({l.category})</span>}
                  </td>
                  <td className="num">{fmtMoney(l.amount, l.currency)}</td>
                  <td className="num">{l.fee ? fmtMoney(l.fee, l.currency) : <span className="muted">—</span>}</td>
                  <td className="num">{fmtMoney(l.net, l.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="section-title">
        Transaction detail {data.ledgerLines?.length > 0 ? '(rate-card breakdown, for reference)' : "(Shopify's own numbers)"}
      </div>
      {data.transactions?.length > 0 ? (
        <table className="data mb8">
          <thead><tr><th>Kind</th><th>Status</th><th className="num">Amount</th><th className="num">Fee</th><th className="num">Net</th></tr></thead>
          <tbody>
            {data.transactions.map((t) => (
              <React.Fragment key={t.transactionId}>
                <tr>
                  <td className="small">{t.kind}</td>
                  <td><span className={`badge ${t.status === 'SUCCESS' ? 'green' : 'muted'}`}>{t.status}</span></td>
                  <td className="num">{fmtMoney(t.amount, t.currency)}</td>
                  <td className="num">{t.feeAmount != null ? fmtMoney(t.feeAmount, t.feeCurrency) : <span className="muted">—</span>}</td>
                  <td className="num">{fmtMoney((t.amount ?? 0) - (t.feeAmount ?? 0), t.currency)}</td>
                </tr>
                {t.fees?.length > 0 && (
                  <tr>
                    <td colSpan={5} className="small dim" style={{ paddingTop: 0 }}>
                      {t.fees.map((f, i) => (
                        <div key={i}>
                          ↳ {f.flatFeeName || f.rateName || f.type || 'Fee'}
                          {f.rate != null && ` (${Math.round(f.rate * 10000) / 100}%)`}
                          : −{fmtMoney(f.amount, f.currency)}
                          {f.taxAmount != null && <> + VAT −{fmtMoney(f.taxAmount, f.currency)}</>}
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="small dim mb12">No transactions synced yet - press "Sync from Shopify" above.</div>
      )}

      <div className="section-title">Cost of goods &amp; shipping</div>
      <dl className="kv mb8">
        <dt>Shipping cost</dt>
        <dd><ShippingCostCell row={data} onSaved={onSaved} /></dd>
        <dt>Supply cost</dt>
        <dd>
          <SupplyCostCell row={data} onSaved={onSaved} />
          {data.costBreakdown?.supply?.isEstimate && (
            <div className="small dim">estimated from Shopify's own per-item cost - no real figure typed in yet</div>
          )}
        </dd>
      </dl>

      <div className="section-title">Manual cost</div>
      <div className="hint mb8">
        This order's share of Shop Campaigns spend, packaging, or anything else Shopify's transactions don't tie
        to it by themselves. Subtracted from the net below.
      </div>
      <div className="flex wrap mb12">
        <input
          className="input" type="number" step="0.01" style={{ maxWidth: 100 }}
          placeholder="0.00" value={manualCost} onChange={(e) => setManualCost(e.target.value)}
        />
        <input
          className="input" style={{ flex: 1, minWidth: 100 }} placeholder="What is this for? (optional)"
          value={manualCostNote} onChange={(e) => setManualCostNote(e.target.value)}
        />
        <button className="btn sm" onClick={saveManualCost}>Save</button>
      </div>

      {data.costBreakdown?.profit && (
        <>
          <div className="section-title">Profit</div>
          <dl className="kv">
            <dt>Net after fees</dt>
            <dd>{fmtMoney(data.realNet?.value ?? data.total, data.realNet?.currency ?? data.currency)}</dd>
            {data.costBreakdown.shipping && (
              <>
                <dt>− Shipping</dt>
                <dd>{fmtMoney(data.costBreakdown.shipping.value, data.costBreakdown.shipping.currency)}</dd>
              </>
            )}
            {data.costBreakdown.supply && (
              <>
                <dt>− Supply{data.costBreakdown.supply.isEstimate ? ' (est.)' : ''}</dt>
                <dd>{fmtMoney(data.costBreakdown.supply.value, data.costBreakdown.supply.currency)}</dd>
              </>
            )}
            {data.costBreakdown.adSpend && (
              <>
                <dt>− Shop ads{data.costBreakdown.adSpend.source === 'estimate' ? ' (est.)' : ''}</dt>
                <dd>{fmtMoney(data.costBreakdown.adSpend.value, data.costBreakdown.adSpend.currency)}</dd>
              </>
            )}
            {data.manualCost && (
              <>
                <dt>− Manual</dt>
                <dd>{fmtMoney(data.manualCost.value, data.manualCost.currency)}</dd>
              </>
            )}
            <dt><strong>Profit</strong></dt>
            <dd>
              <strong>{fmtMoney(data.costBreakdown.profit.value, data.costBreakdown.profit.currency)}</strong>
              {marginPct !== null && <span className="small dim"> ({marginPct}% margin)</span>}
            </dd>
          </dl>
        </>
      )}
    </div>
  );
}

function OrderDetail({ orderId, onClose, onChanged }) {
  const toast = useToast();
  const showError = useErrorToast();
  const { data, loading, reload } = useAsync(() => (orderId ? api.get(`/shopify/orders/${encodeURIComponent(orderId)}`) : null), [orderId], { immediate: !!orderId });
  const { data: carrierDefaults } = useAsync(() => api.get('/tracking/carriers').catch(() => null), []);
  const [tracking, setTracking] = useState('');
  const [company, setCompany] = useState('');
  const [companyTouched, setCompanyTouched] = useState(false);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  // Same shop-wide default carrier the Etsy tracking form uses (orders.default_carrier,
  // "Yunexpress" out of the box) - never overwrites a carrier typed by hand.
  React.useEffect(() => {
    // Show the known-good default immediately rather than leaving the field
    // empty while /tracking/carriers is still loading (or failed outright,
    // in which case carrierDefaults stays null forever - it must never mean
    // "show nothing").
    if (!companyTouched) setCompany(carrierDefaults?.defaultCarrier || SHOPIFY_KNOWN_CARRIER);
  }, [carrierDefaults]); // eslint-disable-line react-hooks/exhaustive-deps
  const [supplierRef, setSupplierRef] = useState('');
  const [supplyTrack, setSupplyTrack] = useState('');
  const [notes, setNotes] = useState('');
  const [manualCost, setManualCost] = useState('');
  const [manualCostNote, setManualCostNote] = useState('');

  React.useEffect(() => {
    setSupplierRef(data?.supplierOrderRef ?? '');
    setSupplyTrack(data?.supplyTrackingNumber ?? '');
    setNotes(data?.notes ?? '');
    setManualCost(data?.manualCost?.value != null ? String(data.manualCost.value) : '');
    setManualCostNote(data?.manualCost?.note ?? '');
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

  const saveNotes = async () => {
    try {
      await api.post(`${orderPath}/flags`, { notes });
      toast({ kind: 'ok', title: 'Notes saved' });
      reload(); onChanged();
    } catch (err) { showError(err); }
  };

  const saveManualCost = async () => {
    try {
      await api.post(`${orderPath}/manual-cost`, { amount: manualCost === '' ? null : Number(manualCost), note: manualCostNote });
      toast({ kind: 'ok', title: 'Manual cost saved' });
      reload(); onChanged();
    } catch (err) { showError(err); }
  };

  /** Force this order's Shop-ads attribution on/off, or back to automatic (override: null). */
  const setShopAds = async (override) => {
    try {
      await api.post(`${orderPath}/shop-ads`, { override });
      toast({ kind: 'ok', title: override === null ? 'Back to automatic' : override ? 'Marked as Shop ads' : 'Shop ads canceled for this order' });
      reload(); onChanged();
    } catch (err) { showError(err); }
  };

  /** Local only - see the list's Cancel button for why this never calls Shopify's real cancel API. */
  const cancelOrder = async () => {
    if (!confirm(`Cancel order ${data.name} (${data.customerName || 'no name'})?\n\n`
      + 'This only hides it in this app - nothing changes on Shopify, and the customer is not notified. '
      + 'You can find it again with "Show canceled" on the list and restore it.')) return;
    try {
      await api.post(`${orderPath}/flags`, { canceled: true });
      toast({ kind: 'ok', title: `Order ${data.name} canceled here` });
      reload(); onChanged();
    } catch (err) { showError(err, 'Could not cancel that'); }
  };

  const restoreOrder = async () => {
    try {
      await api.post(`${orderPath}/flags`, { canceled: false });
      toast({ kind: 'ok', title: `Order ${data.name} restored` });
      reload(); onChanged();
    } catch (err) { showError(err, 'Could not restore that'); }
  };

  return (
    <Drawer open onClose={onClose} wide title={data ? `${data.name}${data.code ? ` · ${data.code}` : ''}` : orderId}
      footer={data && (
        data.isLocallyCanceled ? (
          <button className="btn ghost" onClick={restoreOrder}>Restore this order</button>
        ) : (
          <button className="btn danger" onClick={cancelOrder}>Cancel this order</button>
        )
      )}>
      {loading || !data ? <Spinner /> : (
        <div className="drawer-2col">
          <ShopifyFinancePanel
            data={data} manualCost={manualCost} setManualCost={setManualCost}
            manualCostNote={manualCostNote} setManualCostNote={setManualCostNote} saveManualCost={saveManualCost}
            setShopAds={setShopAds}
            onSaved={() => { reload(); onChanged(); }}
          />
          <div>
          <dl className="kv mb16">
            <dt>Buyer</dt>
            <dd>
              {data.customerName || '—'} {data.email ? `· ${data.email}` : ''}
              {data.phone && <div className="small dim">{data.phone}</div>}
            </dd>
            <dt>Ship to</dt><dd>{[data.shipName, data.shipAddress1, data.shipCity, data.shipCountry].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Financial</dt><dd>{data.financialStatus}</dd>
            <dt>Fulfillment</dt><dd>{data.fulfillmentStatus || 'UNFULFILLED'}</dd>
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
            <thead><tr><th>SKU</th><th>Title</th><th>Variant</th><th className="num">Qty</th><th className="num">Price</th><th>Supply</th><th>Depo görseli</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.lineItemId}>
                  <td className="mono small">{i.sku || '—'}</td>
                  <td className="small">{i.title}</td>
                  <td className="small dim">{i.variantTitle}</td>
                  <td className="num">{i.quantity}</td>
                  <td className="num">{fmtMoney(i.price, i.currency)}</td>
                  <td>
                    {i.supplyLink ? (
                      <a href={i.supplyLink} target="_blank" rel="noreferrer" className="btn xs"
                         title={i.supplierName || "The supplier's page for this SKU"}>Open ↗</a>
                    ) : <span className="muted small">—</span>}
                  </td>
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
              <input className="input sm" placeholder="Carrier (optional)" value={company}
                onChange={(e) => { setCompany(e.target.value); setCompanyTouched(true); }} />
              <button type="button" className="btn sm ghost" title="Shopify only builds a tracking link for this exact spelling"
                onClick={() => { setCompany(SHOPIFY_KNOWN_CARRIER); setCompanyTouched(true); }}>{SHOPIFY_KNOWN_CARRIER}</button>
              <Checkbox checked={notify} onChange={setNotify} label="Notify customer" />
              <button className="btn sm primary" disabled={busy || !tracking.trim()} onClick={fulfill}>{busy ? <Spinner /> : 'Fulfill on Shopify'}</button>
            </div>
          )}

          <div className="section-title">Internal notes</div>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="Private notes for this order…" />
          <button className="btn sm mt8" onClick={saveNotes}>Save notes</button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** The list's quick "+ Add" tracking action - the same fields and fulfill call as the drawer's own inline form. */
function QuickFulfillForm({ orderId, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const { data: carrierDefaults } = useAsync(() => api.get('/tracking/carriers').catch(() => null), []);
  const [tracking, setTracking] = useState('');
  const [company, setCompany] = useState('');
  const [companyTouched, setCompanyTouched] = useState(false);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  // Same shop-wide default carrier the Etsy tracking form uses (orders.default_carrier,
  // "Yunexpress" out of the box) - never overwrites a carrier typed by hand.
  React.useEffect(() => {
    // Show the known-good default immediately rather than leaving the field
    // empty while /tracking/carriers is still loading (or failed outright,
    // in which case carrierDefaults stays null forever - it must never mean
    // "show nothing").
    if (!companyTouched) setCompany(carrierDefaults?.defaultCarrier || SHOPIFY_KNOWN_CARRIER);
  }, [carrierDefaults]); // eslint-disable-line react-hooks/exhaustive-deps

  const fulfill = async () => {
    setBusy(true);
    try {
      await api.post(`/shopify/orders/${encodeURIComponent(orderId)}/fulfill`,
        { trackingNumber: tracking, trackingCompany: company || undefined, notifyCustomer: notify });
      toast({ kind: 'ok', title: 'Fulfillment pushed to Shopify' });
      onDone();
    } catch (err) { showError(err, 'Could not fulfill'); } finally { setBusy(false); }
  };

  return (
    <div className="flex mb8" style={{ flexWrap: 'wrap' }}>
      <input className="input sm" placeholder="Tracking number" autoFocus value={tracking} onChange={(e) => setTracking(e.target.value)} />
      <input className="input sm" placeholder="Carrier (optional)" value={company}
        onChange={(e) => { setCompany(e.target.value); setCompanyTouched(true); }} />
      <button type="button" className="btn sm ghost" title="Shopify only builds a tracking link for this exact spelling"
        onClick={() => { setCompany(SHOPIFY_KNOWN_CARRIER); setCompanyTouched(true); }}>{SHOPIFY_KNOWN_CARRIER}</button>
      <Checkbox checked={notify} onChange={setNotify} label="Notify customer" />
      <button className="btn sm primary" disabled={busy || !tracking.trim()} onClick={fulfill}>{busy ? <Spinner /> : 'Fulfill on Shopify'}</button>
    </div>
  );
}
