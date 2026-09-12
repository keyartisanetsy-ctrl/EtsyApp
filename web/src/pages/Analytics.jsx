import React, { useMemo, useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Banner, Empty, Stat, useAsync, useToast, useErrorToast, useDebounced, fmtMoney, DecimalInput,
} from '../components/ui.jsx';

/**
 * The shop's own numbers.
 *
 * One thing to be straight about, because it shapes the whole screen: Etsy's
 * public API has no traffic, visit, view or advertising endpoint. Not a
 * restricted one — none at all. So there are no visitor counts or conversion
 * rates here, and there cannot be. What Etsy does give in full is the orders,
 * and everything below is worked out from those, plus the ad spend you type in
 * off the seller dashboard.
 *
 * Every figure is converted from each order's own currency at that order's own
 * date, so the lira shop and the dollar shops can sit in one total honestly.
 */

const RANGES = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 3 months' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last year' },
  { value: 'custom', label: 'Between two dates…' },
];

export default function Analytics() {
  const [range, setRange] = useState('90');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [search, setSearch] = useState('');
  const [sku, setSku] = useState('');
  const debouncedSearch = useDebounced(search);
  const debouncedSku = useDebounced(sku);

  const filters = useMemo(() => {
    const f = { search: debouncedSearch || undefined, sku: debouncedSku || undefined, months: 6 };
    if (range === 'custom') {
      if (since) f.since = since;
      if (until) f.until = until;
    } else {
      f.sinceDays = Number(range);
    }
    return f;
  }, [range, since, until, debouncedSearch, debouncedSku]);

  const { data, loading, error, reload } = useAsync(() => api.get('/analytics', filters), [filters]);

  const o = data?.overview;
  const currency = data?.filters?.currency ?? 'USD';
  const filtered = !!(debouncedSearch || debouncedSku);

  return (
    <Page
      title="Shop data"
      subtitle={o ? `${o.orders} orders · every figure in ${currency}` : ''}
      actions={<button className="btn sm" onClick={reload} disabled={loading}>{loading ? <Spinner /> : '↻'} Refresh</button>}
    >
      {error && <Banner kind="err">{error.message}</Banner>}

      <div className="card">
        <div className="card-head"><h3>What to look at</h3></div>
        <div className="toolbar" style={{ padding: 0, border: 0 }}>
          <select className="select" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {range === 'custom' && (
            <>
              <input className="input" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
              <span className="small dim">to</span>
              <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </>
          )}
          <input className="input" placeholder="Filter by product title…" value={search}
                 onChange={(e) => setSearch(e.target.value)} />
          <input className="input mono" placeholder="…or one exact SKU" value={sku}
                 onChange={(e) => setSku(e.target.value)} style={{ maxWidth: 180 }} />
          {filtered && <button className="btn sm ghost" onClick={() => { setSearch(''); setSku(''); }}>Clear</button>}
        </div>
        {filtered && (
          <div className="hint">
            A product filter counts a whole order when any line in it matches, so the totals stay real
            orders rather than fragments of them.
          </div>
        )}
      </div>

      {loading && !data ? <div className="empty"><Spinner /></div> : !o ? null : (
        <>
          <div className="grid c4 mb16">
            <Stat label="Orders" value={o.orders.toLocaleString()} note={`${o.units} item(s)`} />
            <Stat label="Gross" value={fmtMoney(o.gross, currency)} note="before refunds" />
            <Stat label="Net" value={fmtMoney(o.net, currency)}
                  note={o.refunded ? `after ${fmtMoney(o.refunded, currency)} refunded` : 'nothing refunded'} />
            <Stat label="Average order" value={fmtMoney(o.averageOrder, currency)} />
          </div>

          <Banner kind="info">
            {o.note} Cancelled orders are left out and refunds are taken off, so &ldquo;net&rdquo; is money
            that actually stayed.
          </Banner>

          <div className="grid c2">
            <AdSpend data={data} currency={currency} onSaved={reload} />
            <Countries rows={data.countries} total={o.orders} />
          </div>

          <MonthTable months={data.months} currency={currency} />
          <TopProducts rows={data.topProducts} currency={currency} />
        </>
      )}
    </Page>
  );
}

/** Month by month, with both kinds of advertising taken off. */
function MonthTable({ months, currency }) {
  if (!months?.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Month by month</h3>
        <span className="small dim">what came in, what the ads cost, what is left</span>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Month</th>
            <th className="right">Orders</th>
            <th className="right">Gross</th>
            <th className="right">Refunded</th>
            <th className="right">Net</th>
            <th className="right" title="15% or 12% of the orders you marked as coming from an offsite ad">Offsite ads</th>
            <th className="right" title="Etsy Ads and anything else you entered by hand">Ad spend</th>
            <th className="right">After ads</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <td className="mono small">{m.month}</td>
              <td className="num">{m.orders}</td>
              <td className="num">{fmtMoney(m.gross, currency)}</td>
              <td className="num dim">{m.refunded ? fmtMoney(m.refunded, currency) : '—'}</td>
              <td className="num money-subtotal">{fmtMoney(m.net, currency)}</td>
              <td className="num dim">{m.offsiteAdsFees ? fmtMoney(m.offsiteAdsFees, currency) : '—'}</td>
              <td className="num dim">{m.enteredAdSpend ? fmtMoney(m.enteredAdSpend, currency) : '—'}</td>
              <td className="num"><strong>{fmtMoney(m.afterAds, currency)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopProducts({ rows, currency }) {
  if (!rows?.length) return <Empty icon="◎" title="No sales in this period" />;
  const best = rows[0]?.revenue || 1;
  return (
    <div className="card">
      <div className="card-head"><h3>What sold</h3><span className="small dim">{rows.length} product(s)</span></div>
      <table className="data">
        <thead>
          <tr><th>SKU</th><th>Product</th><th className="right">Units</th><th className="right">Revenue</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sku || r.listingId}>
              <td className="mono small">{r.sku || <span className="muted">no SKU</span>}</td>
              <td className="cell-title" title={r.title}>{r.title}</td>
              <td className="num">{r.units}</td>
              <td className="num">{fmtMoney(r.revenue, currency)}</td>
              <td style={{ width: 120 }}>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--border)' }}>
                  <div style={{ height: 6, borderRadius: 3, width: `${Math.round((r.revenue / best) * 100)}%`,
                                background: 'var(--brand)' }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Where the orders went.
 *
 * Etsy gives no audience or traffic figures, so this is the nearest honest
 * thing to one: who actually bought.
 */
function Countries({ rows, total }) {
  return (
    <div className="card">
      <div className="card-head"><h3>Where the orders went</h3></div>
      {!rows?.length ? <Empty icon="🌍" title="Nothing yet" /> : (
        <table className="data">
          <thead><tr><th>Country</th><th className="right">Orders</th><th className="right">Share</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.country}>
                <td>{c.country}</td>
                <td className="num">{c.orders}</td>
                <td className="num dim">{total ? `${Math.round((c.orders / total) * 100)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hint">
        Etsy publishes no visitor or traffic data through its API, so this counts buyers, not visitors.
      </div>
    </div>
  );
}

/** Etsy Ads and the rest, typed in by hand because the API does not expose them. */
function AdSpend({ data, currency, onSaved }) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [kind, setKind] = useState('etsy_ads');
  const [amount, setAmount] = useState('');
  const [entryCurrency, setEntryCurrency] = useState(currency);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const { data: costData, reload } = useAsync(() => api.get('/analytics/ad-costs', { currency }), [currency]);
  const kinds = costData?.kinds ?? [{ value: 'etsy_ads', label: 'Etsy Ads' }];
  const costs = costData?.costs ?? data?.adCosts ?? [];

  const save = async () => {
    if (!amount) { toast({ kind: 'warn', title: 'Enter what you spent' }); return; }
    setBusy(true);
    try {
      await api.post('/analytics/ad-costs', { month, kind, amount: Number(amount), currency: entryCurrency, note });
      toast({ kind: 'ok', title: 'Saved', body: `${month} · ${kinds.find((k) => k.value === kind)?.label}` });
      setAmount(''); setNote('');
      reload(); onSaved();
    } catch (err) { showError(err, 'Could not save that'); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    if (!confirm(`Remove the ${row.kindLabel} figure for ${row.month}?`)) return;
    try { await api.del('/analytics/ad-costs', { month: row.month, kind: row.kind }); reload(); onSaved(); }
    catch (err) { showError(err); }
  };

  return (
    <div className="card">
      <div className="card-head"><h3>Advertising spend</h3></div>
      <div className="hint mb8">
        Etsy&rsquo;s API exposes no advertising data at all, so these come off your seller dashboard once a
        month. Entering a month again replaces it rather than adding a second figure. Offsite Ads are
        worked out per order instead — they are the fee column in the table below.
      </div>

      <div className="split">
        <div className="field">
          <label>Month</label>
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="field">
          <label>What for</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
      </div>
      <div className="split">
        <div className="field">
          <label>Spent</label>
          <DecimalInput value={amount} onChange={setAmount} placeholder="0.00" />
        </div>
        <div className="field">
          <label>Currency</label>
          <select className="select" value={entryCurrency} onChange={(e) => setEntryCurrency(e.target.value)}>
            {['USD', 'TRY', 'EUR', 'GBP', 'CNY'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Note (optional)</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="e.g. raised the daily budget mid-month" />
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save this month'}</button>

      {costs.length > 0 && (
        <table className="data mt16">
          <thead><tr><th>Month</th><th>What for</th><th className="right">Spent</th><th /></tr></thead>
          <tbody>
            {costs.map((c) => (
              <tr key={`${c.month}-${c.kind}`}>
                <td className="mono small">{c.month}</td>
                <td className="small">{c.kindLabel}{c.note && <div className="small dim">{c.note}</div>}</td>
                <td className="num">
                  {fmtMoney(c.amount, c.currency)}
                  {c.currency !== c.convertedCurrency && (
                    <div className="small dim">≈ {fmtMoney(c.converted, c.convertedCurrency)}</div>
                  )}
                </td>
                <td><button className="btn xs ghost" onClick={() => remove(c)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
