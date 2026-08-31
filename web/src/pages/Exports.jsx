import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Empty, useAsync, useToast, useErrorToast, fmtAgo } from '../components/ui.jsx';

const KINDS = [
  { id: 'orders', label: 'Orders', desc: 'Order summary, one row per sold line item, and the tracking board — three sheets.', path: '/exports/orders' },
  { id: 'skus', label: 'SKUs & variations', desc: 'Every variation with both price columns, supply links, margins and image URLs.', path: '/exports/skus' },
  { id: 'listings', label: 'Listings', desc: 'Catalogue with prices, tags, materials, views and favourites.', path: '/exports/listings' },
  { id: 'tracking', label: 'Tracking', desc: 'Parcel board with statuses, idle days, alerts and YunTrack links.', path: '/exports/tracking' },
  { id: 'tracking-template', label: 'Tracking template', desc: 'Blank sheet pre-filled with orders that still need a number — fill it in and upload.', path: '/exports/tracking-template' },
];

export default function Exports() {
  const [busy, setBusy] = useState(null);
  const { data, loading, reload } = useAsync(() => api.get('/exports'), []);
  const toast = useToast();
  const showError = useErrorToast();

  const build = async (kind) => {
    setBusy(kind.id);
    try {
      const r = await api.post(kind.path, {});
      toast({ kind: 'ok', title: 'Workbook ready', body: `${r.filename} · ${Math.round(r.bytes / 1024)} KB` });
      reload();
      window.location.href = `/api/exports/download/${encodeURIComponent(r.filename)}`;
    } catch (err) { showError(err, 'Export failed'); } finally { setBusy(null); }
  };

  const remove = async (filename) => {
    try { await api.del(`/exports/${encodeURIComponent(filename)}`); reload(); }
    catch (err) { showError(err); }
  };

  return (
    <Page title="Excel exports" subtitle="Real .xlsx with frozen headers, filters and clickable links">
      <div className="grid c3 mb16">
        {KINDS.map((k) => (
          <div className="card" key={k.id}>
            <div className="card-head"><h3>{k.label}</h3></div>
            <div className="card-sub">{k.desc}</div>
            <button className="btn primary" disabled={busy === k.id} onClick={() => build(k)}>
              {busy === k.id ? <Spinner /> : '⤓'} Build &amp; download
            </button>
          </div>
        ))}
      </div>

      <div className="section-title">Previously generated</div>
      {loading ? <Spinner /> : !data?.length ? (
        <Empty icon="⤓" title="No workbooks yet" />
      ) : (
        <div className="card">
          <table className="data">
            <thead><tr><th>File</th><th className="right">Size</th><th>Created</th><th /></tr></thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.filename}>
                  <td className="mono small">{f.filename}</td>
                  <td className="num">{Math.round(f.bytes / 1024)} KB</td>
                  <td className="small muted">{fmtAgo(f.createdAt)}</td>
                  <td>
                    <div className="flex gap4">
                      <a className="btn xs" href={`/api/exports/download/${encodeURIComponent(f.filename)}`}>Download</a>
                      <button className="btn xs danger" onClick={() => remove(f.filename)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
