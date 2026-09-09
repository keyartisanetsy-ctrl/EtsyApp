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

      {!compact && <PinVariantImages listingId={listingId} onChanged={reload} />}
    </>
  );
}

/**
 * Choosing which photo goes with which option, from here instead of Etsy.
 *
 * Etsy replaces the entire set on every save and allows photos on one property
 * only. Both of those are handled on the server - it reads what Etsy has,
 * merges your change in, and sends the lot back - but they are worth saying on
 * screen too, because "I changed one and the rest vanished" is the kind of
 * surprise that costs an afternoon.
 */
function PinVariantImages({ listingId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const { data, loading, reload } = useAsync(
    () => (listingId ? api.get(`/listings/${listingId}/variant-images`) : null),
    [listingId], { immediate: !!listingId },
  );

  if (loading && !data) return null;
  if (!data?.options?.length) return null;

  const pin = async (option, imageId) => {
    setBusy(true);
    try {
      const r = await api.post(`/listings/${listingId}/variant-images`, {
        changes: [{ propertyId: option.propertyId, valueId: option.valueId, imageId }],
      });
      toast({
        kind: 'ok',
        title: imageId ? `Photo pinned to "${option.value}"` : `Photo unpinned from "${option.value}"`,
        body: r.note ?? `${r.pinned} option(s) now carry a photo on Etsy.`,
        duration: r.note ? 9000 : undefined,
      });
      reload(); onChanged?.();
    } catch (err) { showError(err, 'Etsy would not take that'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="section-title">Which photo for which option</div>
      <div className="hint mb8">
        Buyers see the matching photo when they pick an option. Etsy keeps these on one option type only, and
        each save replaces the whole set — this app reads what Etsy has and merges your change in, so changing
        one never clears the others.
      </div>
      {data.note && <Banner kind="warn">{data.note}</Banner>}

      <table className="data">
        <thead><tr><th>Option</th><th>Photo</th><th>Pick one</th></tr></thead>
        <tbody>
          {data.options.map((o) => (
            <tr key={`${o.propertyId}-${o.valueId}`}>
              <td className="small">
                {o.value}
                {o.propertyName && <div className="small dim">{o.propertyName}</div>}
              </td>
              <td>
                {o.imageUrl
                  ? <img src={o.imageUrl} alt={o.value} className="pic-thumb" />
                  : <span className="muted small">none</span>}
              </td>
              <td>
                <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
                  {data.images.map((img, n) => (
                    <button
                      key={img.imageId}
                      type="button"
                      className="pin-choice"
                      disabled={busy}
                      title={`Use photo #${n + 1} for "${o.value}"`}
                      onClick={() => pin(o, img.imageId)}
                      style={img.imageId === o.imageId
                        ? { outline: '2px solid var(--brand)', outlineOffset: 1 }
                        : undefined}
                    >
                      <img src={img.thumb || img.url} alt={`photo ${n + 1}`} />
                    </button>
                  ))}
                  {o.imageId && (
                    <button className="btn xs ghost" disabled={busy} onClick={() => pin(o, null)}>clear</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
