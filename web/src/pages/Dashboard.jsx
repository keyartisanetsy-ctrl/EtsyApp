import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Stat, Banner, Spinner, useToast, useErrorToast, fmtAgo, fmtMoney } from '../components/ui.jsx';

export default function Dashboard({ summary, onRefresh }) {
  const [syncing, setSyncing] = useState(null);
  const nav = useNavigate();
  const toast = useToast();
  const showError = useErrorToast();

  const runSync = async (kind) => {
    setSyncing(kind);
    try {
      if (kind === 'all') {
        const r = await api.syncAll({ withInventory: true });
        const failed = r.listings.errors?.length ?? 0;
        toast({
          kind: failed ? 'warn' : 'ok',
          title: 'Sync complete',
          body: failed
            ? `${r.listings.listings} listings, ${r.listings.products} variations, ${r.receipts.receipts} orders — ${failed} listing(s) could not be read (photos/variants may be missing for those); see Listings > Sync for details`
            : `${r.listings.listings} listings, ${r.listings.products} variations, ${r.receipts.receipts} orders`,
        });
      } else if (kind === 'orders') {
        const r = await api.post('/orders/sync', {});
        toast({ kind: 'ok', title: 'Orders synced', body: `${r.receipts} receipts updated` });
      } else {
        const r = await api.post('/tracking/sync', {});
        toast({
          kind: r.errors?.length ? 'warn' : 'ok',
          title: 'Tracking synced',
          body: `${r.checked} parcels checked${r.errors?.length ? `, ${r.errors.length} could not be reached` : ''}`,
        });
      }
      onRefresh();
    } catch (err) {
      showError(err, 'Sync failed');
    } finally {
      setSyncing(null);
    }
  };

  if (!summary) {
    return <Page title="Dashboard"><div className="flex"><Spinner /> <span className="dim">Loading…</span></div></Page>;
  }

  const { listings, orders, tracking, revenue, ai, lastSync } = summary;

  return (
    <Page
      title="Dashboard"
      subtitle={summary.shop?.shopName ? `${summary.shop.shopName} · ${summary.operationCount} API operations` : `${summary.operationCount} API operations`}
      actions={
        <>
          <button className="btn sm" disabled={!!syncing} onClick={() => runSync('orders')}>
            {syncing === 'orders' ? <Spinner /> : '↻'} Orders
          </button>
          <button className="btn sm" disabled={!!syncing} onClick={() => runSync('tracking')}>
            {syncing === 'tracking' ? <Spinner /> : '➤'} Tracking
          </button>
          <button className="btn sm primary" disabled={!!syncing} onClick={() => runSync('all')}>
            {syncing === 'all' ? <Spinner /> : '⟳'} Sync everything
          </button>
        </>
      }
    >
      {!summary.connected && (
        <Banner kind="warn">
          <div>
            <strong>No Etsy shop connected.</strong> Add your keystring in Settings, then connect the shop to pull
            listings and orders. Everything else on this page stays empty until then.
            <div className="mt8"><button className="btn sm" onClick={() => nav('/settings')}>Open Settings</button></div>
          </div>
        </Banner>
      )}

      <div className="section-title">Orders</div>
      <div className="grid c5">
        <Stat label="New (unseen)" value={orders.newOrders} kind={orders.newOrders ? 'alert' : ''}
              note="Not yet ticked as seen" onClick={() => nav('/orders?seen=false')} />
        <Stat label="Not done" value={orders.notDone} note="Open on the tick list" onClick={() => nav('/orders?done=false')} />
        <Stat label="Unshipped" value={orders.unshipped} onClick={() => nav('/orders?shipped=false')} />
        <Stat label="No tracking" value={orders.noTracking} note="Needs a number" onClick={() => nav('/orders?hasTracking=false')} />
        <Stat label="Tracking alerts" value={tracking.alerts} kind={tracking.alerts ? 'alert' : 'good'}
              note={`No movement in ${tracking.staleDays}+ days`} onClick={() => nav('/tracking?alertsOnly=true')} />
      </div>

      <div className="section-title">Catalogue</div>
      <div className="grid c5">
        <Stat label="Listings" value={listings.total} note={Object.entries(listings.byState).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none synced'} onClick={() => nav('/listings')} />
        <Stat label="Variations" value={listings.variations} note="Across all listings" onClick={() => nav('/skus')} />
        <Stat label="Missing SKU" value={listings.missingSku} kind={listings.missingSku ? 'alert' : 'good'} onClick={() => nav('/skus?missingSku=true')} />
        <Stat label="Duplicate SKUs" value={listings.duplicateSkus} kind={listings.duplicateSkus ? 'alert' : 'good'} onClick={() => nav('/skus')} />
        <Stat label="No supply link" value={listings.missingSupplyLink} note="SKUs without a supplier URL" onClick={() => nav('/skus?missingSupply=true')} />
      </div>

      <div className="section-title">Revenue &amp; tracking mix</div>
      <div className="grid c2">
        <div className="card">
          <div className="card-head"><h3>Revenue</h3></div>
          <div className="grid c2">
            <Stat label="Last 7 days" value={fmtMoney(revenue.last7, revenue.currency)} />
            <Stat label="Last 30 days" value={fmtMoney(revenue.last30, revenue.currency)} />
          </div>
          {revenue.detail?.last30 && (
            <dl className="kv mt16">
              <dt>Gross (last 30 days)</dt><dd>{fmtMoney(revenue.detail.last30.gross, revenue.currency)}</dd>
              <dt>Refunded</dt>
              <dd className={revenue.detail.last30.refunded ? 'num' : 'dim'} style={{ color: revenue.detail.last30.refunded ? 'var(--danger,#e05252)' : undefined }}>
                {revenue.detail.last30.refunded ? `-${fmtMoney(revenue.detail.last30.refunded, revenue.currency)}` : 'none'}
                {revenue.detail.last30.refundedOrders ? ` (${revenue.detail.last30.refundedOrders} order${revenue.detail.last30.refundedOrders === 1 ? '' : 's'})` : ''}
              </dd>
              <dt>Cancelled orders excluded</dt><dd>{revenue.detail.last30.canceledOrders || 0}</dd>
            </dl>
          )}
          <div className="card-sub mt16">
            Net figures already have refunds taken off and cancelled orders left out — this is not the same as
            Etsy&rsquo;s own Payment account fees (transaction/listing/processing fees, Ads spend), which Etsy&rsquo;s
            public API does not expose in the same categorised form its own Shop Manager uses. Sync orders to bring
            this up to date.
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Parcels by status</h3>
            <div className="spacer" />
            <span className="dim small">{tracking.total} tracked</span>
          </div>
          {tracking.total === 0
            ? <div className="dim small">No tracking numbers recorded yet.</div>
            : (
              <div className="flex col gap4">
                {Object.entries(tracking.byStatus).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
                  <div key={status} className="flex">
                    <span style={{ width: 150 }} className="small">{tracking.labels[status] ?? status}</span>
                    <div className="progress" style={{ flex: 1 }}>
                      <span style={{ width: `${Math.round((count / tracking.total) * 100)}%` }} />
                    </div>
                    <span className="small dim" style={{ width: 36, textAlign: 'right' }}>{count}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>

      <div className="section-title">Status</div>
      <div className="grid c3">
        <div className="card">
          <div className="card-head"><h3>Last sync</h3></div>
          <dl className="kv">
            <dt>Listings</dt><dd>{fmtAgo(lastSync.listings)}</dd>
            <dt>Orders</dt><dd>{fmtAgo(lastSync.receipts)}</dd>
            <dt>Tracking</dt><dd>{fmtAgo(lastSync.tracking)}</dd>
          </dl>
        </div>

        <div className="card">
          <div className="card-head"><h3>AI providers</h3></div>
          <dl className="kv">
            {['manus', 'anthropic', 'openai'].map((p) => (
              <React.Fragment key={p}>
                <dt style={{ textTransform: 'capitalize' }}>{p}</dt>
                <dd>
                  <span className={`badge ${ai[p].configured ? 'green' : 'grey'}`}>
                    {ai[p].configured ? 'ready' : 'no key'}
                  </span>
                  {ai.active === p && <span className="badge blue" style={{ marginLeft: 6 }}>default</span>}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>

        <div className="card">
          <div className="card-head"><h3>Recent bulk jobs</h3></div>
          {summary.recentJobs?.length
            ? summary.recentJobs.map((j) => (
                <div key={j.id} className="flex small" style={{ padding: '3px 0' }}>
                  <span className={`badge ${j.status === 'completed' ? 'green' : j.status === 'failed' ? 'red' : 'blue'}`}>{j.status}</span>
                  <span className="dim">{j.label}</span>
                  <div className="spacer" />
                  <span className="muted">{j.succeeded}/{j.total}</span>
                </div>
              ))
            : <div className="dim small">Nothing run yet.</div>}
        </div>
      </div>
    </Page>
  );
}
