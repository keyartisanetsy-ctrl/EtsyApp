import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Empty, Banner, Tabs, useAsync, useToast, useErrorToast } from '../components/ui.jsx';

const TABS = [
  { id: 'sections', label: 'Sections' },
  { id: 'shipping', label: 'Shipping profiles' },
  { id: 'returns', label: 'Return policies' },
  { id: 'holidays', label: 'Holiday preferences' },
  { id: 'partners', label: 'Production partners' },
  { id: 'reviews', label: 'Reviews' },
];

export default function ShopSettings() {
  const [tab, setTab] = useState('sections');
  return (
    <Page title="Shop settings" subtitle="Sections, shipping, policies and reviews from the Etsy API">
      <Tabs active={tab} onChange={setTab} tabs={TABS} />
      {tab === 'sections' && <Sections />}
      {tab === 'shipping' && <Simple path="/shop/shipping-profiles" title="Shipping profiles"
        columns={[['shipping_profile_id', 'ID'], ['title', 'Title'], ['min_processing_days', 'Min days'], ['max_processing_days', 'Max days'], ['origin_country_iso', 'From']]} />}
      {tab === 'returns' && <Simple path="/shop/return-policies" title="Return policies"
        columns={[['return_policy_id', 'ID'], ['accepts_returns', 'Returns'], ['accepts_exchanges', 'Exchanges'], ['return_deadline', 'Deadline (days)']]} />}
      {tab === 'holidays' && <Simple path="/shop/holiday-preferences" title="Holiday preferences"
        columns={[['holiday_id', 'ID'], ['holiday_name', 'Holiday'], ['is_working', 'Working']]} />}
      {tab === 'partners' && <Simple path="/shop/production-partners" title="Production partners"
        columns={[['production_partner_id', 'ID'], ['partner_name', 'Partner'], ['location', 'Location']]} />}
      {tab === 'reviews' && <Reviews />}
    </Page>
  );
}

/** Read-only table over any shop endpoint that returns {results:[...]}. */
function Simple({ path, title, columns }) {
  const { data, loading, error } = useAsync(() => api.get(path), [path]);
  if (loading) return <Spinner />;
  if (error) return <Banner kind="err">{error.message}</Banner>;
  const rows = data?.results ?? (Array.isArray(data) ? data : []);
  if (!rows.length) return <Empty icon="□" title={`No ${title.toLowerCase()}`} />;

  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3><div className="spacer" /><span className="small muted">{rows.length}</span></div>
      <table className="data">
        <thead><tr>{columns.map(([, label]) => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map(([key]) => (
                <td key={key} className="small">
                  {typeof r[key] === 'boolean' ? (r[key] ? 'yes' : 'no') : String(r[key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sections() {
  const [title, setTitle] = useState('');
  const { data, loading, error, reload } = useAsync(() => api.get('/shop/sections'), []);
  const toast = useToast();
  const showError = useErrorToast();

  const create = async () => {
    try { await api.post('/shop/sections', { title }); toast({ kind: 'ok', title: 'Section created' }); setTitle(''); reload(); }
    catch (err) { showError(err); }
  };
  const remove = async (id) => {
    if (!confirm('Delete this section?')) return;
    try { await api.del(`/shop/sections/${id}`); reload(); } catch (err) { showError(err); }
  };

  if (loading) return <Spinner />;
  if (error) return <Banner kind="err">{error.message}</Banner>;
  const rows = data?.results ?? [];

  return (
    <>
      <div className="card mb16">
        <div className="flex">
          <input className="input" placeholder="New section name" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn primary" disabled={!title.trim()} onClick={create}>Create</button>
        </div>
      </div>
      {rows.length === 0 ? <Empty icon="□" title="No sections" /> : (
        <div className="card">
          <table className="data">
            <thead><tr><th>ID</th><th>Title</th><th className="right">Listings</th><th className="right">Rank</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.shop_section_id}>
                  <td className="mono small">{s.shop_section_id}</td>
                  <td>{s.title}</td>
                  <td className="num">{s.active_listing_count ?? '—'}</td>
                  <td className="num">{s.rank ?? '—'}</td>
                  <td><button className="btn xs danger" onClick={() => remove(s.shop_section_id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Reviews() {
  const { data, loading, error } = useAsync(() => api.get('/shop/reviews', { limit: 100 }), []);
  if (loading) return <Spinner />;
  if (error) return <Banner kind="err">{error.message}</Banner>;
  const rows = data?.results ?? [];
  if (!rows.length) return <Empty icon="★" title="No reviews yet" />;

  const avg = rows.reduce((s, r) => s + (r.rating ?? 0), 0) / rows.length;

  return (
    <>
      <Banner kind="info">{rows.length} reviews · average {avg.toFixed(2)} ★</Banner>
      <div className="card">
        <table className="data">
          <thead><tr><th>Rating</th><th>Review</th><th>Listing</th><th>Language</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><span className={`badge ${r.rating >= 4 ? 'green' : r.rating >= 3 ? 'amber' : 'red'}`}>{'★'.repeat(r.rating ?? 0)}</span></td>
                <td className="cell-wrap small">{r.review || <span className="muted">no text</span>}</td>
                <td className="mono small">{r.listing_id ?? '—'}</td>
                <td className="small muted">{r.language ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
