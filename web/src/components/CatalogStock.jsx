import React, { useState } from 'react';
import api from '../lib/api.js';
import { Spinner, useErrorToast, useToast } from './ui.jsx';

const VERDICT = {
  match: ['green', 'pictures match'],
  unsure: ['amber', 'pictures unsure'],
  mismatch: ['red', 'pictures differ'],
};

/**
 * The supplier side of one variant: is it in stock, and is the supplier page
 * really our product. The stock answer is the paid OneBound check - it only
 * runs when ↻ is pressed. Right after it, our picture is held against the first
 * two pictures the supplier API returned (colours, free); "AI" asks a model for
 * a second opinion when the colours are not conclusive.
 */
export default function CatalogStock({ row, info, onResult }) {
  const showError = useErrorToast();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  const link = row.variantSupplyLink || row.supplyLink;
  if (!link) return <span className="small muted">no supplier link</span>;
  if (info?.noItem) return <span className="small muted" title="The link has no product number in it">link not readable</span>;

  const check = async () => {
    setBusy(true);
    try {
      const r = await api.post('/catalog/stock-check', { key: row.key });
      onResult(row.key, r);
      if (r.imageError) toast({ kind: 'info', title: 'Stock checked', body: `Pictures were not compared: ${r.imageError}` });
    } catch (err) { showError(err, 'Stock check failed'); } finally { setBusy(false); }
  };
  const askAi = async () => {
    setAiBusy(true);
    try { onResult(row.key, await api.post('/catalog/image-check', { key: row.key })); }
    catch (err) { showError(err, 'Picture check failed'); } finally { setAiBusy(false); }
  };

  const checked = info?.checked;
  const status = !checked ? null
    : info.allVariantsOut || info.inStock === false ? ['red', info.delisted ? 'delisted / out' : 'OUT OF STOCK']
    : info.variant ? (info.variant.outOfStock ? ['red', `this variant out${info.variant.quantity === 0 ? ' (0)' : ''}`] : ['green', `in stock${info.variant.quantity != null ? ` (${info.variant.quantity})` : ''}`])
    : info.outCount ? ['amber', `${info.outCount} of ${info.variantCount} variants out`] : ['green', 'in stock'];
  const reasonText = info?.variant?.reason || undefined;
  const img = info?.image;
  const [kind, text] = img ? (VERDICT[img.verdict] ?? ['muted', img.verdict]) : [];

  return (
    <div style={{ minWidth: 150 }}>
      <span className="flex gap4" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {status ? <span className={`badge ${status[0]}`} title={reasonText}>{status[1]}</span> : <span className="small muted">not checked</span>}
        <button className="btn xs ghost" onClick={check} disabled={busy} title="Ask the supplier API for this link's live stock (one paid call) and compare its pictures with ours">
          {busy ? <Spinner /> : '↻'}
        </button>
      </span>
      {checked && (
        <div className="flex gap4" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
          {img ? (
            <>
              <span className={`badge ${kind}`}
                    title={img.summary || `Our picture against the supplier's first two: the closest is picture ${img.which}${img.similarity != null ? ` (${Math.round(img.similarity * 100)}% alike in colour)` : ''}`}>
                {text}{img.similarity != null && !img.byAi ? ` ${Math.round(img.similarity * 100)}%` : ''}{img.which ? ` · #${img.which}` : ''}{img.byAi ? ' · AI' : ''}
              </span>
              {img.verdict !== 'match' || !img.byAi ? (
                <button className="btn xs ghost" onClick={askAi} disabled={aiBusy} title="One quick, cheap AI look at our picture against the supplier's first two">
                  {aiBusy ? <Spinner /> : 'AI'}
                </button>
              ) : null}
            </>
          ) : (
            <span className="small muted" title="Check again to get the supplier's pictures">no picture check</span>
          )}
        </div>
      )}
    </div>
  );
}
