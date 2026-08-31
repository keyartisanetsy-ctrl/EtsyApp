import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Empty, Banner, Stat, Thumb, useAsync, useErrorToast, fmtMoney, CopyButton } from '../components/ui.jsx';

/** Keyword research over Etsy's public active-listing search. */
export default function Research() {
  const [keyword, setKeyword] = useState('');
  const [sample, setSample] = useState(100);
  const [sortOn, setSortOn] = useState('score');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [withAi, setWithAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const showError = useErrorToast();

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.post('/research/keyword', {
        keyword, sample: Number(sample), sortOn, withAi,
        minPrice: minPrice || null, maxPrice: maxPrice || null,
      }));
    } catch (err) { showError(err, 'Research failed'); } finally { setBusy(false); }
  };

  const m = result?.metrics;

  return (
    <Page title="Product research" subtitle="Live competitive set from Etsy's public search">
      <div className="card mb16">
        <div className="flex wrap">
          <input className="input" style={{ flex: 2, minWidth: 240 }} placeholder="Keyword, e.g. personalised leather keyring"
                 value={keyword} onChange={(e) => setKeyword(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && keyword && run()} />
          <select className="select" style={{ width: 130 }} value={sample} onChange={(e) => setSample(e.target.value)}>
            {[50, 100, 200, 300].map((n) => <option key={n} value={n}>{n} listings</option>)}
          </select>
          <select className="select" style={{ width: 150 }} value={sortOn} onChange={(e) => setSortOn(e.target.value)}>
            <option value="score">Relevance</option><option value="created">Newest</option><option value="price">Price</option>
          </select>
          <input className="input" style={{ width: 100 }} placeholder="min €" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
          <input className="input" style={{ width: 100 }} placeholder="max €" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
          <label className="checkbox">
            <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
            <span>AI read-out</span>
          </label>
          <button className="btn primary" disabled={busy || !keyword.trim()} onClick={run}>
            {busy ? <Spinner /> : '◎'} Research
          </button>
        </div>
        <div className="card-sub mt8">
          Etsy's API publishes no search-volume figure, so nothing here invents one. What you get is the live
          competitive set: prices, tags, listing age and the favourites Etsy reports per listing.
        </div>
      </div>

      {busy && <div className="empty"><Spinner /><p className="mt8">Sampling live listings…</p></div>}

      {result && !m && <Banner kind="warn">{result.note ?? 'No listings returned for that query.'}</Banner>}

      {m && (
        <>
          <div className="section-title">Price distribution ({m.sample} listings)</div>
          <div className="grid c5 mb16">
            <Stat label="Lowest" value={fmtMoney(m.price.min, m.price.currency)} />
            <Stat label="25th pct" value={fmtMoney(m.price.p25, m.price.currency)} />
            <Stat label="Median" value={fmtMoney(m.price.median, m.price.currency)} kind="good" />
            <Stat label="75th pct" value={fmtMoney(m.price.p75, m.price.currency)} />
            <Stat label="Highest" value={fmtMoney(m.price.max, m.price.currency)} />
          </div>

          <div className="grid c4 mb16">
            <Stat label="Median favourites" value={m.engagement.medianFavourites ?? '—'} />
            <Stat label="Top favourites" value={m.engagement.maxFavourites ?? '—'} />
            <Stat label="Median age" value={`${m.engagement.medianAgeDays ?? '—'} d`} />
            <Stat label="Listed in last 90d" value={`${m.engagement.newListingsShare}%`}
                  note="How fast the field refreshes" />
          </div>

          <div className="split">
            <div className="card">
              <div className="card-head">
                <h3>Most-used tags</h3>
                <div className="spacer" />
                <CopyButton text={m.topTags.slice(0, 13).map((t) => t.tag).join(', ')} label="Copy top 13" className="btn xs" />
              </div>
              {m.topTags.slice(0, 22).map((t) => (
                <div key={t.tag} className="flex small" style={{ padding: '2px 0' }}>
                  <span style={{ width: 170 }}>{t.tag}</span>
                  <div className="progress" style={{ flex: 1 }}><span style={{ width: `${t.share}%` }} /></div>
                  <span className="muted" style={{ width: 52, textAlign: 'right' }}>{t.share}%</span>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="card-head"><h3>Highest traction</h3></div>
              <div className="card-sub">Favourites per month live — the closest honest proxy for demand.</div>
              <table className="data">
                <thead><tr><th /><th>Title</th><th className="right">Price</th><th className="right">Favs/mo</th></tr></thead>
                <tbody>
                  {m.valueLeaders.map((r) => (
                    <tr key={r.listingId}>
                      <td><Thumb src={r.imageUrl} /></td>
                      <td className="cell-title small"><a href={r.url} target="_blank" rel="noreferrer">{r.title}</a></td>
                      <td className="num">{fmtMoney(r.price, r.currency)}</td>
                      <td className="num">{r.favouritesPerMonth ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {result.analysis && (
            <>
              <div className="section-title">
                AI read-out
                {result.analysis.text && <CopyButton text={result.analysis.text} label="Copy" className="btn xs" />}
              </div>
              {result.analysis.error
                ? <Banner kind="warn">AI analysis skipped: {result.analysis.error}</Banner>
                : <div className="card"><div className="copy-block" style={{ maxHeight: 'none' }}>{result.analysis.text}</div></div>}
            </>
          )}

          <div className="section-title">Sampled listings</div>
          <div className="card">
            <table className="data">
              <thead><tr><th /><th>Title</th><th className="right">Price</th><th className="right">Favs</th><th className="right">Age</th><th>Tags</th></tr></thead>
              <tbody>
                {result.rows.slice(0, 60).map((r) => (
                  <tr key={r.listingId}>
                    <td><Thumb src={r.imageUrl} /></td>
                    <td className="cell-title small"><a href={r.url} target="_blank" rel="noreferrer">{r.title}</a></td>
                    <td className="num">{fmtMoney(r.price, r.currency)}</td>
                    <td className="num">{r.favorers ?? '—'}</td>
                    <td className="num small muted">{r.ageDays != null ? `${r.ageDays}d` : '—'}</td>
                    <td className="small muted">{r.tags.slice(0, 4).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!busy && !result && (
        <Empty icon="◎" title="Search a keyword">
          The sample comes from Etsy's public active-listing search, so it reflects what buyers actually see today.
        </Empty>
      )}
    </Page>
  );
}
