import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Spinner, Modal, ShopBadge, useToast, useErrorToast } from './ui.jsx';

const money = (v, ccy) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${ccy || 'CNY'}`;

/**
 * The Taobao item (id or link) and price of the product behind a parcel. Saved against the
 * product's SKU, so every shop that sells it - Etsy shops and Shopify stores - gets them, and
 * Shopify also gets the price as the variant's "cost per item". Another shop that already holds
 * something different is asked about first (change / keep).
 */
export default function ItemSupplyBox({ parcel, onSaved }) {
  const m = parcel.match;
  const brief = m.item?.itemSupply;
  const toast = useToast();
  const showError = useErrorToast();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [taobao, setTaobao] = useState('');
  const [price, setPrice] = useState('');
  const [ccy, setCcy] = useState('CNY');
  const [sku, setSku] = useState('');
  const [deciding, setDeciding] = useState(null);

  const itemKey = `${m.channel}:${m.itemId}`;
  const load = async () => {
    try {
      const r = await api.get('/packing/items/supply', { channel: m.channel, itemId: m.itemId });
      setInfo(r);
      setTaobao(r.current.taobaoId || '');
      setPrice(r.current.cost ?? '');
      setCcy(r.current.currency || 'CNY');
    } catch (err) { showError(err, 'Could not read this product'); }
  };
  useEffect(() => { if (open) load(); }, [open, itemKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = [brief?.taobaoId && `Taobao ${brief.taobaoId}`, brief?.cost != null && money(brief.cost, brief.currency)].filter(Boolean).join(' · ');

  const report = (r) => {
    const failed = r.results.filter((x) => x.error);
    const where = r.results.filter((x) => !x.error && (x.link === 'saved' || x.price === 'saved')).length;
    if (failed.length) {
      toast({ kind: 'err', title: `Saved on ${r.results.length - failed.length} of ${r.results.length} shops`, duration: 12000, body: failed.map((f) => `${f.shop}: ${f.error}`).join(' · ') });
    } else {
      toast({ kind: 'ok', title: `Saved for ${r.sku}`, body: `${where} shop${where === 1 ? '' : 's'} updated${r.kept?.length ? `, ${r.kept.length} left as they were` : ''}.` });
    }
    for (const w of r.warnings ?? []) toast({ kind: 'info', title: 'Shopify cost', body: w, duration: 12000 });
  };

  const save = async (decision) => {
    setBusy(true);
    try {
      const r = await api.post('/packing/items/supply', {
        channel: m.channel, itemId: m.itemId, taobao, price: String(price), currency: ccy, ...(info?.item.needsSku ? { sku } : {}), decision,
      });
      if (r.status === 'needs_decision') { setDeciding(r.conflicts); return; }
      setDeciding(null);
      report(r);
      setInfo(r.info);
      // show what is stored now (a pasted link becomes its item id, a missing SKU becomes the saved one)
      setTaobao(r.info.current.taobaoId || '');
      setPrice(r.info.current.cost ?? '');
      setCcy(r.info.current.currency || 'CNY');
      onSaved?.();
    } catch (err) { showError(err, 'Could not save the Taobao item'); } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 6, maxWidth: 460 }}>
      <button className={`btn xs ${summary ? '' : 'ghost'}`} onClick={() => setOpen((v) => !v)}
              title="The Taobao item id (or link) and its price - saved for the product's SKU in every shop that sells it, and as Shopify's cost per item">
        🏷 {summary || 'Product: Taobao item & price'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {!info ? <Spinner /> : (
            <>
              <div className="small" style={{ marginBottom: 4 }}>
                {info.item.sku
                  ? <>SKU <strong className="mono">{info.item.sku}</strong></>
                  : <span style={{ color: 'var(--bad)' }}>This item has no SKU yet.</span>}
                {info.item.variation ? <span className="muted"> · {info.item.variation}</span> : null}
              </div>
              {info.item.needsSku && (
                <div style={{ marginBottom: 6 }}>
                  <input className="input sm mono" value={sku} placeholder={info.item.canSetSku ? 'Type a SKU for it (e.g. KC001-RED)' : 'No variation in the shop to give a SKU to'}
                         disabled={!info.item.canSetSku} aria-label={`SKU for ${parcel.label}`} onChange={(e) => setSku(e.target.value)} />
                  <div className="small muted" style={{ marginTop: 2 }}>It is written to the shop this item was sold in, and the Taobao details are saved against it.</div>
                </div>
              )}
              <div className="flex gap4" style={{ flexWrap: 'wrap' }}>
                <input className="input sm" style={{ flex: '2 1 190px' }} value={taobao} placeholder="Taobao item id or link"
                       aria-label={`Taobao item for ${parcel.label}`} onChange={(e) => setTaobao(e.target.value)} />
                <input className="input sm" style={{ flex: '1 1 70px', maxWidth: 100 }} type="number" min="0" step="0.01" value={price} placeholder="Price"
                       aria-label={`Taobao price for ${parcel.label}`} onChange={(e) => setPrice(e.target.value)} />
                <input className="input sm" style={{ width: 56 }} value={ccy} maxLength={4} aria-label="Price currency" onChange={(e) => setCcy(e.target.value.toUpperCase())} />
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                One piece of this product, as Taobao prices it. A link with a colour/size picked keeps that variant too.
              </div>
              {info.targets.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div className="small muted">Saved for every shop that sells {info.item.sku || 'it'}:</div>
                  {info.targets.map((t) => (
                    <div key={t.key ?? `${t.channel}:${t.shopName}`} className="small flex gap4" style={{ alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                      <ShopBadge channel={t.channel} name={t.shopName} />
                      <span>{t.productTitle?.slice(0, 40)}{t.variation ? ` · ${t.variation}` : ''}</span>
                      <span className="muted">
                        {t.taobaoId ? `Taobao ${t.taobaoId}` : 'no item yet'}
                        {t.cost != null ? ` · ${money(t.cost, t.currency)}` : ''}
                        {t.channel === 'shopify' && t.shopCost != null ? ` · Shopify cost ${t.shopCost} ${t.shopCurrency || ''}` : ''}
                      </span>
                    </div>
                  ))}
                  {info.differs && <div className="small" style={{ color: 'var(--warn)', marginTop: 2 }}>These shops do not agree yet - saving brings them together.</div>}
                </div>
              )}
              <div className="flex gap4" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn xs primary" disabled={busy || (!taobao.trim() && String(price).trim() === '')} onClick={() => save('check')}
                        title="Saves in every shop that sells this SKU and sets Shopify's cost per item. If another shop holds something different you are asked first.">
                  {busy ? <Spinner /> : 'Save to all shops'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {deciding && (
        <Modal open onClose={() => setDeciding(null)} title="Another shop already has something different"
               footer={(
                 <>
                   <button className="btn" disabled={busy} onClick={() => save('keep')}>Keep (don't change them)</button>
                   <button className="btn primary" disabled={busy} onClick={() => save('change')}>{busy ? <Spinner /> : 'Change them'}</button>
                 </>
               )}>
          <div className="small muted mb8">
            Nothing has been saved yet. "Change them" puts what you typed in those shops too; "Keep" saves it everywhere else and leaves these as they are.
          </div>
          <table className="data">
            <thead><tr><th>Shop</th><th>What</th><th>It has</th><th>You typed</th></tr></thead>
            <tbody>
              {deciding.map((c, i) => (
                <tr key={`${c.shop}${c.field}${i}`}>
                  <td><ShopBadge channel={c.channel} name={c.shop} /></td>
                  <td><strong>{c.field}</strong><div className="small muted">{c.product}{c.variation ? ` · ${c.variation}` : ''}</div></td>
                  <td className="mono">{c.current}</td>
                  <td className="mono"><strong>{c.next}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
