import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Banner, useAsync, useToast, useErrorToast, useDebounced } from '../components/ui.jsx';

const WHEN_MADE = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007', '2000_2006',
  '1990s', '1980s', '1970s', '1960s', '1950s', '1940s', '1930s', '1920s', '1910s', '1900s', '1800s', '1700s', 'before_1700'];

/**
 * Create a draft listing. Etsy always creates as a draft, so nothing here can
 * accidentally publish; you activate it afterwards from the Listings screen.
 */
export default function NewListing() {
  const [form, setForm] = useState({
    title: '', description: '', price: '', quantity: 1,
    who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: '',
    tags: '', materials: '', type: 'physical', is_supply: false,
    shipping_profile_id: '', return_policy_id: '', shop_section_id: '',
  });
  const [taxSearch, setTaxSearch] = useState('');
  const debouncedTax = useDebounced(taxSearch);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [images, setImages] = useState([]);

  const nav = useNavigate();
  const toast = useToast();
  const showError = useErrorToast();

  const { data: taxonomy } = useAsync(() => api.get('/research/taxonomy/seller', { flat: true }), []);
  const { data: profiles } = useAsync(() => api.get('/shop/shipping-profiles').catch(() => null), []);
  const { data: sections } = useAsync(() => api.get('/shop/sections').catch(() => null), []);

  // Pick up a draft handed over from the AI listing writer.
  useEffect(() => {
    const stored = sessionStorage.getItem('ai-listing-draft');
    if (!stored) return;
    try {
      const d = JSON.parse(stored);
      setForm((f) => ({
        ...f,
        title: d.title ?? f.title,
        description: d.description ?? f.description,
        tags: Array.isArray(d.tags) ? d.tags.join(', ') : f.tags,
        materials: Array.isArray(d.materials) ? d.materials.join(', ') : f.materials,
        who_made: d.who_made ?? f.who_made,
        when_made: d.when_made ?? f.when_made,
        price: d.price_suggestion ?? f.price,
      }));
      toast({ kind: 'ok', title: 'AI draft loaded', body: 'Check every field before creating it on Etsy.' });
    } catch { /* ignore a malformed handover */ }
    sessionStorage.removeItem('ai-listing-draft');
  }, [toast]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const taxMatches = useMemo(() => {
    if (!debouncedTax || !taxonomy) return [];
    const q = debouncedTax.toLowerCase();
    return taxonomy.filter((t) => t.path.toLowerCase().includes(q)).slice(0, 20);
  }, [debouncedTax, taxonomy]);

  const tagList = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const problems = [
    !form.title.trim() && 'Title is required',
    form.title.length > 140 && `Title is ${form.title.length} characters (max 140)`,
    !form.description.trim() && 'Description is required',
    !form.price && 'Price is required',
    !form.taxonomy_id && 'Pick a category',
    tagList.length > 13 && `${tagList.length} tags (max 13)`,
    tagList.some((t) => t.length > 20) && 'One or more tags is over 20 characters',
  ].filter(Boolean);

  const create = async () => {
    setBusy(true);
    try {
      const body = {
        ...form,
        price: Number(form.price),
        quantity: Number(form.quantity),
        taxonomy_id: Number(form.taxonomy_id),
        tags: tagList,
        materials: form.materials.split(',').map((t) => t.trim()).filter(Boolean),
      };
      for (const k of ['shipping_profile_id', 'return_policy_id', 'shop_section_id']) {
        if (body[k] === '' || body[k] == null) delete body[k]; else body[k] = Number(body[k]);
      }
      const listing = await api.post('/listings', body);
      setCreated(listing);
      toast({ kind: 'ok', title: `Draft ${listing.listing_id} created`, body: 'Add images, then activate it from Listings.' });

      for (const file of images) {
        const fd = new FormData();
        fd.append('image', file);
        try { await api.upload(`/listings/${listing.listing_id}/images`, fd); }
        catch (err) { showError(err, `Image ${file.name} failed`); }
      }
      if (images.length) toast({ kind: 'ok', title: `${images.length} image(s) uploaded` });
    } catch (err) { showError(err, 'Etsy rejected the listing'); } finally { setBusy(false); }
  };

  return (
    <Page
      title="Create listing"
      subtitle="Created as a draft — you activate it afterwards"
      actions={
        <>
          <button className="btn sm" onClick={() => nav('/ai')}>✦ Write it with AI</button>
          <button className="btn sm primary" disabled={busy || problems.length > 0} onClick={create}>
            {busy ? <Spinner /> : '＋'} Create draft
          </button>
        </>
      }
    >
      {created && (
        <Banner kind="ok">
          Draft <strong>{created.listing_id}</strong> created.{' '}
          <a href={created.url} target="_blank" rel="noreferrer">View on Etsy ↗</a>{' '}
          — it stays a draft until you activate it from the Listings screen.
        </Banner>
      )}

      {problems.length > 0 && (
        <Banner kind="warn">
          <div>
            <strong>Not ready yet:</strong>
            <ul style={{ margin: '6px 0 0 18px' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        </Banner>
      )}

      <div className="split">
        <div className="card">
          <div className="card-head"><h3>The listing</h3></div>

          <div className="field">
            <label>Title <span className="muted">({form.title.length}/140)</span></label>
            <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} />
          </div>

          <div className="field">
            <label>Description</label>
            <textarea className="textarea" rows={10} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </div>

          <div className="split">
            <div className="field">
              <label>Price</label>
              <input className="input" type="number" step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} />
            </div>
            <div className="field">
              <label>Quantity</label>
              <input className="input" type="number" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>Tags <span className="muted">({tagList.length}/13)</span></label>
            <input className="input" value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="comma separated" />
            <div className="pill-row mt8">
              {tagList.map((t) => <span key={t} className={`tag ${t.length > 20 ? 'badge red' : ''}`}>{t}</span>)}
            </div>
          </div>

          <div className="field">
            <label>Materials</label>
            <input className="input" value={form.materials} onChange={(e) => set('materials', e.target.value)} placeholder="comma separated" />
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Category &amp; logistics</h3></div>

          <div className="field">
            <label>Category (Etsy taxonomy)</label>
            <input className="input" placeholder="Search, e.g. candle" value={taxSearch} onChange={(e) => setTaxSearch(e.target.value)} />
            {form.taxonomy_id && (
              <div className="small mt8">
                Selected: <strong>{taxonomy?.find((t) => t.id === Number(form.taxonomy_id))?.path ?? form.taxonomy_id}</strong>
              </div>
            )}
            <div style={{ maxHeight: 170, overflowY: 'auto', marginTop: 8 }}>
              {taxMatches.map((t) => (
                <div key={t.id} className="small" style={{ padding: '3px 0', cursor: 'pointer' }}
                     onClick={() => { set('taxonomy_id', t.id); setTaxSearch(''); }}>
                  {t.path}
                </div>
              ))}
            </div>
          </div>

          <div className="split">
            <div className="field">
              <label>Who made it</label>
              <select className="select" value={form.who_made} onChange={(e) => set('who_made', e.target.value)}>
                <option value="i_did">I did</option>
                <option value="someone_else">Someone else</option>
                <option value="collective">A collective</option>
              </select>
            </div>
            <div className="field">
              <label>When was it made</label>
              <select className="select" value={form.when_made} onChange={(e) => set('when_made', e.target.value)}>
                {WHEN_MADE.map((w) => <option key={w} value={w}>{w.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Listing type</label>
            <select className="select" value={form.type} onChange={(e) => set('type', e.target.value)}>
              <option value="physical">Physical</option>
              <option value="download">Digital download</option>
              <option value="both">Both</option>
            </select>
          </div>

          <div className="field">
            <label>Shipping profile</label>
            <select className="select" value={form.shipping_profile_id} onChange={(e) => set('shipping_profile_id', e.target.value)}>
              <option value="">— none —</option>
              {(profiles?.results ?? []).map((p) => (
                <option key={p.shipping_profile_id} value={p.shipping_profile_id}>{p.title}</option>
              ))}
            </select>
            <div className="hint">Physical listings need one before Etsy will let you activate.</div>
          </div>

          <div className="field">
            <label>Shop section</label>
            <select className="select" value={form.shop_section_id} onChange={(e) => set('shop_section_id', e.target.value)}>
              <option value="">— none —</option>
              {(sections?.results ?? []).map((s) => (
                <option key={s.shop_section_id} value={s.shop_section_id}>{s.title}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Images</label>
            <input className="input" type="file" accept="image/*" multiple onChange={(e) => setImages([...e.target.files])} />
            <div className="hint">Uploaded right after the draft is created, in the order you pick them.</div>
            {images.length > 0 && <div className="small dim mt8">{images.length} file(s) ready</div>}
          </div>
        </div>
      </div>
    </Page>
  );
}
