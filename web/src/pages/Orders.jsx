import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Checkbox, Pager, SortTh, Drawer, Modal, CopyButton, Thumb, Tabs,
  useAsync, useDebounced, useToast, useErrorToast, fmtMoney, fmtDateTime, fmtDate, TRACK_BADGE,
} from '../components/ui.jsx';

const LIMIT = 60;

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [done, setDone] = useState(params.get('done') ?? '');
  const [shipped, setShipped] = useState(params.get('shipped') ?? '');
  const [seen, setSeen] = useState(params.get('seen') ?? '');
  const [hasTracking, setHasTracking] = useState(params.get('hasTracking') ?? '');
  const [alertsOnly, setAlertsOnly] = useState(params.get('alertsOnly') === 'true');
  const [sort, setSort] = useState('created');
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);

  const [selected, setSelected] = useState(new Set());
  const [detailId, setDetailId] = useState(null);
  const [trackingOpen, setTrackingOpen] = useState(false);

  const toast = useToast();
  const showError = useErrorToast();

  const query = useMemo(() => ({
    search: debounced, done, shipped, seen, hasTracking,
    alertsOnly: alertsOnly || undefined, sort, dir, limit: LIMIT, offset,
  }), [debounced, done, shipped, seen, hasTracking, alertsOnly, sort, dir, offset]);

  const { data, loading, error, reload } = useAsync(() => api.get('/orders', query), [query]);
  const { data: counters, reload: reloadCounters } = useAsync(() => api.get('/orders/counters'), []);

  const rows = data?.rows ?? [];
  const refreshAll = () => { reload(); reloadCounters(); };

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.receiptId));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.receiptId)));

  /** The Done tick — the column the shop works down. */
  const setFlag = async (receiptIds, patch) => {
    try {
      await api.post('/orders/flags', { receiptIds, ...patch });
      refreshAll();
    } catch (err) { showError(err, 'Could not update'); }
  };

  const syncOrders = async () => {
    try {
      const r = await api.post('/orders/sync', {});
      toast({ kind: 'ok', title: 'Orders synced', body: `${r.receipts} receipts` });
      refreshAll();
    } catch (err) { showError(err, 'Sync failed'); }
  };

  const exportXlsx = async () => {
    try {
      const r = await api.post('/exports/orders', { search: debounced, done: done || undefined, shipped: shipped || undefined, alertsOnly });
      toast({ kind: 'ok', title: 'Workbook ready', body: r.filename });
      window.location.href = `/api/exports/download/${encodeURIComponent(r.filename)}`;
    } catch (err) { showError(err, 'Export failed'); }
  };

  const Filter = ({ label, value, onChange }) => (
    <select className="select sm" value={value} onChange={(e) => { onChange(e.target.value); setOffset(0); }}>
      <option value="">{label}: all</option>
      <option value="true">{label}: yes</option>
      <option value="false">{label}: no</option>
    </select>
  );

  return (
    <TablePage
      title="Orders"
      subtitle={counters ? `${counters.newOrders} new · ${counters.notDone} not done · ${counters.noTracking} without tracking` : ''}
      actions={
        <>
          <button className="btn sm" onClick={exportXlsx}>⤓ Excel</button>
          <button className="btn sm" onClick={syncOrders}>↻ Sync</button>
          <button className="btn sm primary" onClick={() => setTrackingOpen(true)}>➤ Bulk tracking</button>
        </>
      }
      toolbar={
        <>
          <input className="input search" placeholder="Search order id, buyer, city, SKU, tracking…"
                 value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
          <Filter label="Done" value={done} onChange={setDone} />
          <Filter label="Shipped" value={shipped} onChange={setShipped} />
          <Filter label="Seen" value={seen} onChange={setSeen} />
          <Filter label="Tracking" value={hasTracking} onChange={setHasTracking} />
          <Checkbox checked={alertsOnly} onChange={(v) => { setAlertsOnly(v); setOffset(0); }} label="Alerts only" />
          <div className="spacer" />
          {counters?.newOrders > 0 && (
            <button className="btn sm" onClick={() => setFlag(rows.map((r) => r.receiptId), { seen: true })}>
              Mark page seen
            </button>
          )}
        </>
      }
      selection={selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected</span>
          <button className="btn xs" onClick={() => setFlag([...selected], { done: true })}>✓ Mark done</button>
          <button className="btn xs" onClick={() => setFlag([...selected], { done: false })}>Undo done</button>
          <button className="btn xs" onClick={() => setFlag([...selected], { seen: true })}>Mark seen</button>
          <button className="btn xs" onClick={() => setFlag([...selected], { flagged: true })}>⚑ Flag</button>
          <button className="btn xs" onClick={() => setFlag([...selected], { supplierOrdered: true })}>Supplier ordered</button>
          <div className="spacer" />
          <button className="btn xs ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      pager={<Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />}
    >
      {error && <div style={{ padding: 16 }}><Banner kind="err">{error.message}</Banner></div>}

      {loading && !data ? <div className="empty"><Spinner /></div>
        : rows.length === 0 ? (
          <Empty icon="▣" title="No orders match">Sync orders from the Dashboard, or clear the filters.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th className="col-tight"><Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} /></th>
                <th className="col-tight" title="Tick when the order is fully handled">Done</th>
                <th className="col-tight">New</th>
                <SortTh label="Order" field="created" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} />
                <SortTh label="Buyer" field="name" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} />
                <th>Items</th>
                <SortTh label="Total" field="total" sort={sort} dir={dir} onSort={(f, d) => { setSort(f); setDir(d); }} className="right" />
                <th>Tracking</th>
                <th>Status</th>
                <th className="col-tight" />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.receiptId}
                    className={[selected.has(o.receiptId) ? 'selected' : '', o.isDone ? 'done' : '', o.alert ? 'alert-row' : ''].join(' ')}>
                  <td><Checkbox checked={selected.has(o.receiptId)} onChange={() => toggle(o.receiptId)} /></td>
                  <td>
                    <Checkbox checked={o.isDone} onChange={(v) => setFlag([o.receiptId], { done: v })} />
                  </td>
                  <td>{o.isNew ? <span className="badge orange">new</span> : <span className="muted small">·</span>}</td>
                  <td>
                    <div className="mono">#{o.receiptId}</div>
                    <div className="small muted">{fmtDate(o.createdTs)}</div>
                  </td>
                  <td>
                    <div>{o.name || '—'}{o.isFlagged && <span className="badge amber" style={{ marginLeft: 6 }}>⚑</span>}</div>
                    <div className="small muted">{[o.city, o.country].filter(Boolean).join(', ')}</div>
                  </td>
                  <td className="small">{o.itemCount}</td>
                  <td className="num">{fmtMoney(o.total?.value, o.total?.currency)}</td>
                  <td>
                    {o.trackingCode ? (
                      <div className="flex gap4">
                        <a className="mono small" href={o.trackingUrl} target="_blank" rel="noreferrer">{o.trackingCode}</a>
                        <CopyButton text={o.trackingCode} label="⧉" className="btn xs ghost" />
                      </div>
                    ) : <span className="badge grey">none</span>}
                  </td>
                  <td>
                    <div className="pill-row">
                      {o.isCanceled && <span className="badge red">canceled</span>}
                      {!o.isPaid && !o.isCanceled && <span className="badge amber">unpaid</span>}
                      {o.trackingStatus && <span className={`badge ${TRACK_BADGE[o.trackingStatus] ?? 'grey'}`}>{o.trackingStatusLabel}</span>}
                      {!o.trackingStatus && o.isShipped && <span className="badge blue">shipped</span>}
                      {o.alert && <span className="badge red" title={o.alertReason}>⚠ {o.daysSinceMove}d</span>}
                    </div>
                  </td>
                  <td><button className="btn xs" onClick={() => setDetailId(o.receiptId)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <OrderDetail id={detailId} onClose={() => setDetailId(null)} onChanged={refreshAll} />
      <BulkTrackingModal open={trackingOpen} onClose={() => setTrackingOpen(false)} onDone={refreshAll} />
    </TablePage>
  );
}

/** Order detail: everything about the order, with copy buttons on each block. */
function OrderDetail({ id, onClose, onChanged }) {
  const [tab, setTab] = useState('summary');
  const { data: order, loading, reload } = useAsync(() => (id ? api.get(`/orders/${id}`) : null), [id], { immediate: !!id });
  const { data: copy } = useAsync(() => (id ? api.get(`/orders/${id}/copy`) : null), [id], { immediate: !!id });
  const [notes, setNotes] = useState('');
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => { setNotes(order?.notes ?? ''); setTab('summary'); }, [order?.receiptId]);
  React.useEffect(() => { if (id) api.post('/orders/seen', { receiptIds: [id] }).then(onChanged).catch(() => {}); }, [id]);

  if (!id) return null;

  const saveNotes = async () => {
    try { await api.post(`/orders/${id}/flags`, { notes }); toast({ kind: 'ok', title: 'Notes saved' }); onChanged(); }
    catch (err) { showError(err); }
  };

  const setFlag = async (patch) => {
    try { await api.post(`/orders/${id}/flags`, patch); reload(); onChanged(); }
    catch (err) { showError(err); }
  };

  return (
    <Drawer
      open onClose={onClose} wide
      title={order ? `Order #${order.receiptId}` : 'Order'}
      footer={order && (
        <>
          <Checkbox checked={order.isDone} onChange={(v) => setFlag({ done: v })} label="Done" />
          <Checkbox checked={order.isFlagged} onChange={(v) => setFlag({ flagged: v })} label="Flagged" />
          <Checkbox checked={order.supplierOrdered} onChange={(v) => setFlag({ supplierOrdered: v })} label="Ordered from supplier" />
          <div className="spacer" />
          <CopyButton text={copy?.full} label="Copy whole order" className="btn primary" />
        </>
      )}
    >
      {loading || !order ? <Spinner /> : (
        <>
          <Tabs
            active={tab} onChange={setTab}
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'items', label: 'Items', count: order.items.length },
              { id: 'tracking', label: 'Tracking', count: order.shipments.length },
              { id: 'copy', label: 'Copy blocks' },
            ]}
          />

          {tab === 'summary' && (
            <>
              <div className="section-title">Buyer</div>
              <dl className="kv mb16">
                <dt>Name</dt><dd>{order.name || '—'}</dd>
                <dt>Email</dt><dd>{order.buyerEmail || <span className="muted">not shared by Etsy</span>}</dd>
                <dt>Placed</dt><dd>{fmtDateTime(order.createdTs)}</dd>
                <dt>Expected ship</dt><dd>{order.expectedShipTs ? fmtDate(order.expectedShipTs) : '—'}</dd>
                <dt>Payment</dt><dd>{order.paymentMethod || '—'}</dd>
              </dl>

              <div className="section-title">
                Shipping address <CopyButton text={copy?.address} label="Copy address" className="btn xs" />
              </div>
              <div className="copy-block mb16">{copy?.address || order.address.formatted || '—'}</div>

              <div className="section-title">Totals</div>
              <dl className="kv mb16">
                <dt>Subtotal</dt><dd>{fmtMoney(order.totals.subtotal?.value, order.totals.subtotal?.currency)}</dd>
                <dt>Shipping</dt><dd>{fmtMoney(order.totals.shipping?.value, order.totals.shipping?.currency)}</dd>
                <dt>Tax</dt><dd>{fmtMoney(order.totals.tax?.value, order.totals.tax?.currency)}</dd>
                <dt>Discount</dt><dd>{fmtMoney(order.totals.discount?.value, order.totals.discount?.currency)}</dd>
                <dt><strong>Grand total</strong></dt><dd><strong>{fmtMoney(order.totals.grand?.value, order.totals.grand?.currency)}</strong></dd>
              </dl>

              {(order.messages.fromBuyer || order.messages.giftMessage) && (
                <>
                  <div className="section-title">Messages</div>
                  {order.messages.fromBuyer && (
                    <div className="mb8">
                      <div className="small dim mb8">From buyer</div>
                      <div className="copy-block">{order.messages.fromBuyer}</div>
                    </div>
                  )}
                  {order.messages.giftMessage && (
                    <div className="mb8">
                      <div className="small dim mb8">Gift message</div>
                      <div className="copy-block">{order.messages.giftMessage}</div>
                    </div>
                  )}
                </>
              )}

              <div className="section-title">Internal notes</div>
              <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
                        placeholder="Private notes for this order…" />
              <button className="btn sm mt8" onClick={saveNotes}>Save notes</button>
            </>
          )}

          {tab === 'items' && (
            <table className="data">
              <thead><tr><th /><th>Item</th><th>SKU</th><th className="right">Qty</th><th className="right">Price</th><th>Supply</th></tr></thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={i.transactionId}>
                    <td><Thumb src={i.imageUrl} /></td>
                    <td className="cell-wrap">
                      <div>{i.title}</div>
                      {i.variationLabel && <div className="small dim">{i.variationLabel}</div>}
                    </td>
                    <td className="mono small">
                      {i.sku || <span className="muted">—</span>}
                      {i.sku && <CopyButton text={i.sku} label="⧉" className="btn xs ghost" />}
                    </td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{fmtMoney(i.price?.value, i.price?.currency)}</td>
                    <td>
                      {i.supplyLink
                        ? <a href={i.supplyLink} target="_blank" rel="noreferrer" className="btn xs">Open ↗</a>
                        : <span className="muted small">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'tracking' && (
            <>
              {order.shipments.length === 0
                ? <Empty icon="➤" title="No tracking yet">Add a number from the Orders list or the Tracking board.</Empty>
                : order.shipments.map((s) => (
                    <div key={s.trackingCode} className="card mb8">
                      <div className="flex">
                        <a className="mono" href={s.trackingUrl} target="_blank" rel="noreferrer">{s.trackingCode}</a>
                        <CopyButton text={s.trackingCode} label="⧉" className="btn xs ghost" />
                        <div className="spacer" />
                        {s.status && <span className={`badge ${TRACK_BADGE[s.status] ?? 'grey'}`}>{s.statusLabel}</span>}
                        <span className={`badge ${s.pushedToEtsy ? 'green' : 'amber'}`}>
                          {s.pushedToEtsy ? 'on Etsy' : 'local only'}
                        </span>
                      </div>
                      <dl className="kv mt8">
                        <dt>Carrier</dt><dd>{s.carrier || '—'}</dd>
                        <dt>Last scan</dt><dd>{s.lastEventText || '—'}</dd>
                        <dt>Last movement</dt><dd>{s.lastEventAt ? fmtDateTime(s.lastEventAt) : '—'}</dd>
                        <dt>Days idle</dt><dd>{s.daysSinceMove ?? '—'}</dd>
                      </dl>
                      {s.isStale && <Banner kind="warn">{s.alertReason}</Banner>}
                      {s.pushError && <Banner kind="err">Etsy rejected this: {s.pushError}</Banner>}
                    </div>
                  ))}
            </>
          )}

          {tab === 'copy' && (
            <>
              {[
                ['Everything', copy?.full],
                ['Address only', copy?.address],
                ['Items only', copy?.items],
                ['Supply links', copy?.supplyLinks],
                ['Tracking link', copy?.trackingUrl],
              ].map(([label, text]) => (
                <div key={label} className="mb16">
                  <div className="section-title">
                    {label} <CopyButton text={text} label="Copy" className="btn xs" />
                  </div>
                  <div className="copy-block">{text || <span className="muted">nothing to copy</span>}</div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

/** Paste order/tracking pairs, preview the parse, then push to Etsy. */
function BulkTrackingModal({ open, onClose, onDone }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [pushToEtsy, setPushToEtsy] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const toast = useToast();
  const showError = useErrorToast();

  if (!open) return null;

  const doPreview = async () => {
    try { setPreview(await api.post('/tracking/parse', { text })); }
    catch (err) { showError(err, 'Could not read that'); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post('/tracking/bulk', { text, pushToEtsy, noteToBuyer: note });
      setResult(r);
      toast({
        kind: r.failed ? 'warn' : 'ok',
        title: `${r.succeeded}/${r.total} tracking numbers added`,
        body: r.failed ? `${r.failed} failed — see the list` : pushToEtsy ? 'Pushed to Etsy and buyers notified' : 'Stored locally',
      });
      onDone();
    } catch (err) { showError(err, 'Bulk tracking failed'); } finally { setBusy(false); }
  };

  const downloadTemplate = async () => {
    const r = await api.post('/exports/tracking-template', {});
    window.location.href = `/api/exports/download/${encodeURIComponent(r.filename)}`;
  };

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('pushToEtsy', String(pushToEtsy));
      const r = await api.upload('/tracking/bulk/upload', fd);
      setResult(r);
      toast({ kind: r.failed ? 'warn' : 'ok', title: `${r.succeeded}/${r.total} added from file` });
      onDone();
    } catch (err) { showError(err, 'Upload failed'); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} lg title="Bulk add tracking numbers"
           footer={<><button className="btn" onClick={doPreview} disabled={!text.trim()}>Preview</button>
                     <button className="btn primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? <Spinner /> : 'Add tracking'}</button>
                     <div className="spacer" />
                     <button className="btn sm ghost" onClick={downloadTemplate}>⤓ Excel template</button></>}>
      <div className="field">
        <label>Paste one order per line</label>
        <textarea className="textarea mono" rows={9} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }}
                  placeholder={'3456789012, LP00432300758472, YunExpress\n3456789013  YT2024001234567'} />
        <div className="hint">
          Order id first, then the tracking number, then an optional carrier. Commas, semicolons or tabs all work.
        </div>
      </div>

      <div className="field">
        <label>Or upload the filled-in template</label>
        <input className="input" type="file" accept=".xlsx" onChange={(e) => upload(e.target.files?.[0])} />
      </div>

      <Checkbox checked={pushToEtsy} onChange={setPushToEtsy}
                label="Send to Etsy (marks the order shipped and emails the buyer)" />

      {pushToEtsy && (
        <div className="field mt8">
          <label>Note to buyer (optional)</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}

      {preview && (
        <>
          <div className="section-title">Preview — {preview.rows.length} valid, {preview.errors.length} rejected</div>
          {preview.rows.slice(0, 12).map((r, i) => (
            <div key={i} className="small mono" style={{ padding: '2px 0' }}>
              #{r.receiptId} → {r.trackingCode} {r.carrierName ? `(${r.carrierName})` : ''}
            </div>
          ))}
          {preview.errors.map((e, i) => (
            <div key={i} className="small" style={{ color: 'var(--bad)' }}>line {e.line}: {e.reason}</div>
          ))}
        </>
      )}

      {result && (
        <>
          <div className="section-title">Result</div>
          {result.results.filter((r) => r.status === 'error').map((r, i) => (
            <div key={i} className="small" style={{ color: 'var(--bad)' }}>#{r.receiptId} {r.trackingCode}: {r.error}</div>
          ))}
          {result.failed === 0 && <Banner kind="ok">All {result.succeeded} added successfully.</Banner>}
        </>
      )}
    </Modal>
  );
}
