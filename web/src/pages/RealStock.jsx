import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api.js';
import { TablePage } from '../components/Page.jsx';
import {
  Spinner, Empty, Banner, Thumb, Pager, SortTh, Modal, CopyButton, ShopBadge, useAsync, useDebounced, fmtDateTime,
} from '../components/ui.jsx';
import { RealStockCell } from '../components/RealStock.jsx';

const LIMIT = 100;
const FILTERS = [
  ['', 'Every SKU'], ['counted', 'Counted'], ['none', 'Not counted'], ['zero', 'Nothing on the shelf'],
  ['oversell', 'Shop sells, shelf empty'], ['orphan', 'Counted, no longer sold'],
];

const KIND = {
  count: ['blue', 'Counted'], order: ['orange', 'Order'], cancel: ['green', 'Order cancelled'], clear: ['grey', 'Stopped counting'], rename: ['grey', 'SKU renamed'],
};

/** What the last change of a SKU was, in a few words. */
function Last({ last }) {
  if (!last) return <span className="muted small">no changes yet</span>;
  const [kind, text] = KIND[last.kind] ?? ['grey', last.kind];
  return (
    <div className="small">
      <span className={`badge ${kind}`}>{text}</span>
      {last.delta ? <strong style={{ marginLeft: 6, color: last.delta < 0 ? 'var(--bad)' : 'var(--ok, #34d399)' }}>{last.delta > 0 ? '+' : ''}{last.delta}</strong> : null}
      <div className="muted">{fmtDateTime(last.at)}{last.order ? ` · ${last.order}` : ''}</div>
    </div>
  );
}

/** Everything that ever changed one SKU's real stock - who and what, not just when. */
function HistoryModal({ sku, onClose }) {
  const { data, loading, error } = useAsync(() => api.get('/catalog/stock/history', { sku }), [sku]);
  const sum = data?.summary;
  return (
    <Modal open lg onClose={onClose} title={`Stock history · ${sku}`} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loading && !data ? <div className="empty"><Spinner /></div> : error ? <Banner kind="err">{error.message}</Banner> : (
        <>
          <div className="flex gap12 mb8" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {data.variants.slice(0, 4).map((v, i) => (
              <div key={i} className="flex gap8" style={{ alignItems: 'flex-start', minWidth: 220 }}>
                <Thumb src={v.variantImageUrl || v.coverUrl} size="lg" />
                <div style={{ minWidth: 0 }}>
                  <ShopBadge channel={v.channel} name={v.shopName} />
                  <div className="small" style={{ marginTop: 2 }}><a href={v.productUrl} target="_blank" rel="noreferrer">{v.productTitle} ↗</a></div>
                  <div className="small muted">{v.variation || 'single variant'}{v.shopQty != null ? ` · shop shows ${v.shopQty}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap8 mb8" style={{ flexWrap: 'wrap' }} data-testid="stock-summary">
            <span className="badge blue">On the shelf: {data.qty ?? 'not counted'}</span>
            <span className="badge grey" title="Orders that took pieces off">{sum.orders} order{sum.orders === 1 ? '' : 's'} · {sum.orderedPieces} ordered · {sum.takenPieces} taken</span>
            {sum.shortPieces > 0 && <span className="badge amber" title="Pieces that were ordered but not on the shelf - to order from the supplier">{sum.shortPieces} were short</span>}
            {sum.cancels > 0 && <span className="badge green">{sum.cancels} cancelled · {sum.putBackPieces} put back</span>}
            <span className="badge grey">{sum.counts} count{sum.counts === 1 ? '' : 's'}{sum.lastCountAt ? ` · last ${fmtDateTime(sum.lastCountAt)} → ${sum.lastCountQty}` : ''}</span>
          </div>
          {!data.entries.length ? <Empty icon="∅" title="Nothing has changed this SKU yet">Type a number in its Real column to start counting.</Empty> : (
            <table className="data">
              <thead><tr><th>When</th><th>What</th><th className="num">Change</th><th className="num">Shelf</th><th>Order</th><th className="num">Pieces</th><th>Details</th></tr></thead>
              <tbody>
                {data.entries.map((e) => {
                  const [kind, text] = KIND[e.kind] ?? ['grey', e.kind];
                  return (
                    <tr key={e.id}>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.at)}</td>
                      <td><span className={`badge ${kind}`}>{text}</span></td>
                      <td className="num mono" style={{ color: e.delta < 0 ? 'var(--bad)' : e.delta > 0 ? 'var(--ok, #34d399)' : undefined }}>{e.delta ? `${e.delta > 0 ? '+' : ''}${e.delta}` : '—'}</td>
                      <td className="num mono small">{e.before ?? '–'} → {e.after ?? '–'}</td>
                      <td className="small">
                        {e.orderLabel ? (
                          <>
                            {e.channel === 'etsy' ? <Link to={`/orders?search=${encodeURIComponent(e.orderId)}`}>{e.orderLabel}</Link> : <span>{e.orderLabel}</span>}
                            {e.orderCode && <span className="badge grey" style={{ marginLeft: 4 }}>{e.orderCode}</span>}
                            <div className="muted">{[e.buyer, e.shop].filter(Boolean).join(' · ')}</div>
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="num small">
                        {e.ordered != null ? <>ordered {e.ordered}<br />taken {e.taken ?? 0}{e.short > 0 ? <><br /><strong style={{ color: 'var(--warn, #fbbf24)' }}>short {e.short}</strong></> : null}</>
                          : e.kind === 'cancel' && e.taken != null ? <>put back {e.delta > 0 ? e.taken : 0}</> : '—'}
                      </td>
                      <td className="small muted" style={{ maxWidth: 320 }}>{e.note || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * The real stock of every SKU - what is on the shelf - with the photos, where each SKU is sold (with the link to
 * each shop's page), its variant, the supplier, and a History button that shows every change and why.
 */
export default function RealStock() {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('sku');
  const [dir, setDir] = useState('asc');
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState(null);
  const { data, loading, error, reload } = useAsync(
    () => api.get('/catalog/stock/list', { search: debounced, filter: filter || undefined, sort, dir, limit: LIMIT, offset }),
    [debounced, filter, sort, dir, offset],
  );
  const rows = data?.rows ?? [];
  const counts = data?.counts;
  const onSort = (field, nextDir) => { if (sort === field) setDir(nextDir); else { setSort(field); setDir(field === 'changed' ? 'desc' : 'asc'); } setOffset(0); };

  return (
    <TablePage
      title="Real stock"
      subtitle={counts ? `${counts.total.toLocaleString()} SKUs · ${counts.counted.toLocaleString()} counted` : ''}
      actions={<button className="btn sm" onClick={reload} disabled={loading}>{loading ? <Spinner /> : '↻'} Refresh</button>}
      toolbar={(
        <>
          <input className="input search" placeholder="Search SKU, product or variant…" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
          <select className="select sm" value={filter} aria-label="Show" onChange={(e) => { setFilter(e.target.value); setOffset(0); }}>
            {FILTERS.map(([v, label]) => (
              <option key={v} value={v}>{label}{counts && v ? ` (${{ counted: counts.counted, none: counts.none, zero: counts.zero, oversell: counts.oversell }[v] ?? ''})`.replace(' ()', '') : ''}</option>
            ))}
          </select>
          <div className="spacer" />
          <span className="small muted">What is really on the shelf, one count per SKU in every shop. Orders take pieces off it; a cancelled order puts them back.</span>
        </>
      )}
      pager={<Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />}
    >
      {error && <div style={{ padding: 16 }}><Banner kind="err">{error.message}</Banner></div>}
      {counts?.oversell > 0 && filter !== 'oversell' && (
        <div style={{ padding: '8px 16px 0' }}>
          <Banner kind="warn">
            <strong>{counts.oversell} SKU{counts.oversell === 1 ? '' : 's'}</strong> show pieces in a shop while the shelf is empty.{' '}
            <button className="btn xs" onClick={() => { setFilter('oversell'); setOffset(0); }}>Show them</button>
          </Banner>
        </div>
      )}
      {loading && !data ? <div className="empty"><Spinner /></div> : rows.length === 0 ? (
        <Empty icon="📦" title="No SKUs here">Give variants a SKU on All products, or loosen the filter.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="col-tight">Photos</th>
              <SortTh label="SKU" field="sku" sort={sort} dir={dir} onSort={onSort} />
              <SortTh label="Sold as" field="title" sort={sort} dir={dir} onSort={onSort} />
              <th>Supplier</th>
              <th>Shops show</th>
              <SortTh label="Real stock" field="qty" sort={sort} dir={dir} onSort={onSort} className="right" />
              <SortTh label="Last change" field="changed" sort={sort} dir={dir} onSort={onSort} />
              <th className="col-tight" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku} style={r.oversell ? { boxShadow: 'inset 3px 0 0 var(--bad)' } : undefined}>
                <td>
                  <div className="flex gap4"><Thumb src={r.coverUrl} alt="product" /><Thumb src={r.variantImageUrl} alt="variant" fallback="–" /></div>
                </td>
                <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{r.sku} <CopyButton text={r.sku} label="⧉" className="btn xs ghost" /></td>
                <td style={{ minWidth: 260, maxWidth: 420 }}>
                  {r.orphan ? <span className="muted small">no shop sells this SKU any more</span> : r.variants.slice(0, 4).map((v) => (
                    <div key={v.key} style={{ marginBottom: 4 }}>
                      <ShopBadge channel={v.channel} name={v.shopName} />{' '}
                      <a href={v.productUrl} target="_blank" rel="noreferrer" className="small" title={v.productTitle}>{v.productTitle.length > 70 ? `${v.productTitle.slice(0, 70)}…` : v.productTitle} ↗</a>
                      <div className="small muted">{v.variation || 'single variant'}{v.state && !/^active$/i.test(v.state) ? <span className="badge grey" style={{ marginLeft: 6 }}>{v.state}</span> : null}</div>
                    </div>
                  ))}
                  {r.variants.length > 4 && <div className="small muted">+{r.variants.length - 4} more</div>}
                </td>
                <td style={{ minWidth: 150 }}>
                  {r.supply.length ? r.supply.slice(0, 3).map((s) => (
                    <div key={s.link} className="small"><a href={s.link} target="_blank" rel="noreferrer" title={s.link}>{s.variant ? 'Variant' : 'Product'} ↗</a>{s.name ? <span className="muted"> · {s.name}</span> : null}</div>
                  )) : <span className="muted small">—</span>}
                </td>
                <td className="small" style={{ minWidth: 130 }}>
                  {r.variants.map((v) => <div key={v.key} className="muted">{v.shopName}: <strong style={{ color: 'var(--text)' }}>{v.shopQty ?? '–'}</strong></div>)}
                </td>
                <td className="num" style={{ minWidth: 120 }}>
                  <RealStockCell sku={r.sku} counted={r.qty} onSaved={reload} width={78} />
                  {r.oversell && <div><span className="badge red" style={{ marginTop: 3 }} title="A shop shows pieces, but the shelf is empty">shop sells, shelf empty</span></div>}
                  {r.countedAt && <div className="small muted">counted {fmtDateTime(r.countedAt)}</div>}
                </td>
                <td style={{ minWidth: 160 }}><Last last={r.last} /></td>
                <td><button className="btn xs" onClick={() => setHistory(r.sku)} aria-label={`History of ${r.sku}`}>History</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history && <HistoryModal sku={history} onClose={() => setHistory(null)} />}
    </TablePage>
  );
}
