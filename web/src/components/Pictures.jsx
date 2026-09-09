import React, { useState } from 'react';
import api from '../lib/api.js';
import { Spinner, Empty, Banner, CopyButton, useAsync, useToast, useErrorToast } from './ui.jsx';

/**
 * Every photo on a listing, with its link next to it.
 *
 * Two things this has to get right, because they are what the sheets need:
 *
 *   - the photo for the exact variant that was bought, when Etsy has one;
 *   - when it does not, the first photo and the last one. On these listings the
 *     last photo is nearly always the layout or size chart, which is the thing
 *     worth having beside the cover shot.
 *
 * Every URL is copyable, because half the use of this is pasting a link
 * somewhere else.
 */
export default function Pictures({ listingId, valueIds = [], productId = null, compact = false }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const { data, loading, reload } = useAsync(
    () => (listingId
      ? api.get(`/listings/${listingId}/pictures`, {
        valueIds: valueIds.length ? valueIds.join(',') : undefined,
        productId: productId || undefined,
      })
      : null),
    [listingId, valueIds.join(','), productId],
    { immediate: !!listingId },
  );

  if (!listingId) return null;
  if (loading && !data) return <div className="empty"><Spinner /></div>;
  if (!data) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/listings/${listingId}/pictures/refresh`, {});
      toast({ kind: 'ok', title: `${r.pinned} option photo(s) read from Etsy`, body: `${r.updated} variation(s) updated.` });
      reload();
    } catch (err) { showError(err, 'Could not read the photos'); } finally { setBusy(false); }
  };

  const Row = ({ label, img, hint }) => {
    if (!img?.url) return null;
    return (
      <div className="pic-row">
        <img src={img.thumb || img.url} alt={label} className="pic-thumb" />
        <div className="pic-body">
          <div className="pic-label">
            {label}
            {img.imageId != null && <span className="badge grey" style={{ marginLeft: 6 }}>id {img.imageId}</span>}
          </div>
          {hint && <div className="small dim">{hint}</div>}
          <div className="flex gap4 mt4">
            <input className="input sm mono" readOnly value={img.url} onFocus={(e) => e.target.select()} />
            <CopyButton text={img.url} label="⧉" className="btn xs ghost" />
            <a className="btn xs" href={img.url} target="_blank" rel="noreferrer">↗</a>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="section-title">
        Pictures
        <button className="btn xs ghost" style={{ marginLeft: 8 }} onClick={refresh} disabled={busy}>
          {busy ? <Spinner /> : '↻'} Ask Etsy again
        </button>
      </div>

      {data.note && <div className="hint mb8">{data.note}</div>}

      {data.variant
        ? <Row label="This variant" img={data.variant} hint="The photo Etsy has pinned to the option that was chosen." />
        : (
          <>
            <Row label="First photo" img={data.first} hint="The cover shot. Use this when the listing has no per-option photo." />
            <Row label="Last photo" img={data.last} hint="Usually the size or layout chart." />
          </>
        )}

      {!compact && data.images?.length > 0 && (
        <>
          <div className="section-title">
            All {data.count} photo{data.count === 1 ? '' : 's'}
            <CopyButton
              text={data.images.map((i) => i.url).join('\n')}
              label="Copy every link"
              className="btn xs ghost"
            />
          </div>
          <div className="pic-grid">
            {data.images.map((i, n) => (
              <div key={i.imageId} className="pic-cell" title={i.url}>
                <img src={i.thumb || i.url} alt={`photo ${n + 1}`} />
                <div className="small dim">
                  #{n + 1}{n === 0 ? ' · cover' : n === data.images.length - 1 ? ' · last' : ''}
                </div>
                <CopyButton text={i.url} label="⧉" className="btn xs ghost" />
              </div>
            ))}
          </div>
        </>
      )}

      {!data.images?.length && (
        <Empty icon="🖼" title="No photos synced yet">
          Sync this listing, or press &ldquo;Ask Etsy again&rdquo;.
        </Empty>
      )}

      {!data.hasVariantImages && data.images?.length > 0 && (
        <Banner kind="info">
          This listing has no per-option photos on Etsy, so a sheet gets the cover shot. Add them on Etsy
          if you want each option to carry its own picture.
        </Banner>
      )}
    </>
  );
}

/** Paste any Etsy variant URL and see which photo it resolves to. */
export function PictureLookup() {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const look = async () => {
    setBusy(true);
    try { setResult(await api.get('/listings/pictures/by-url', { url })); }
    catch (err) { showError(err, 'Could not read that link'); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head"><h3>Which photo is this variant?</h3></div>
      <div className="hint mb8">
        Paste a listing link with a variant on it — the part that reads
        <span className="mono"> ?variation0=6251766498</span> — and this shows the photo for that exact option.
      </div>
      <div className="flex gap4">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)}
               placeholder="https://www.etsy.com/listing/4447531240/…?variation0=6251766498" />
        <button className="btn primary" onClick={look} disabled={busy || !url.trim()}>
          {busy ? <Spinner /> : 'Look'}
        </button>
      </div>
      {result && (
        <div className="mt16">
          <Pictures listingId={result.listingId} valueIds={result.variant ? [result.variant.valueId] : []} />
        </div>
      )}
    </div>
  );
}
