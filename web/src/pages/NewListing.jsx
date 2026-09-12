import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Banner, Thumb, useAsync, useToast, useErrorToast, useDebounced, DecimalInput, Modal } from '../components/ui.jsx';
import { MakeProcessingProfile } from './Drafts.jsx';

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
    shipping_profile_id: '', return_policy_id: '', shop_section_id: '', readiness_state_id: '',
  });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [images, setImages] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [attributes, setAttributes] = useState({}); // propertyId -> [{ valueId, name }]

  // Local, throwaway URLs just so the picked files can be seen before
  // anything is uploaded -- revoked whenever the selection changes so they
  // do not pile up as the picker is used.
  useEffect(() => {
    const urls = images.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [images]);

  const nav = useNavigate();
  const toast = useToast();
  const showError = useErrorToast();

  // Shared with the Draft desk: shipping/processing profiles, sections and
  // return policies, fetched from the shop rather than typed in as ids.
  const { data: choices, reload: reloadChoices } = useAsync(() => api.get('/drafts/choices').catch(() => null), []);

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

  const tagList = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const isPhysical = form.type === 'physical';
  const problems = [
    !form.title.trim() && 'Title is required',
    form.title.length > 140 && `Title is ${form.title.length} characters (max 140)`,
    !form.description.trim() && 'Description is required',
    !form.price && 'Price is required',
    !form.taxonomy_id && 'Pick a category',
    tagList.length > 13 && `${tagList.length} tags (max 13)`,
    tagList.some((t) => t.length > 20) && 'One or more tags is over 20 characters',
    // Etsy's spec calls both of these optional; the live API refuses a
    // physical listing without either one.
    isPhysical && !form.shipping_profile_id && 'A physical listing needs a shipping profile',
    isPhysical && !form.readiness_state_id && 'A physical listing needs a processing profile',
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
      for (const k of ['shipping_profile_id', 'return_policy_id', 'shop_section_id', 'readiness_state_id']) {
        if (body[k] === '' || body[k] == null) delete body[k]; else body[k] = Number(body[k]);
      }
      const listing = await api.post('/listings', body);
      setCreated(listing);
      toast({ kind: 'ok', title: `Draft ${listing.listing_id} created`, body: 'Add images, then activate it from Listings.' });

      // The category attributes go on one at a time. Etsy takes one write at a
      // time from this app by design, so a failure names the attribute that
      // failed rather than losing the lot.
      const chosen = Object.entries(attributes).filter(([, picked]) => picked?.length);
      for (const [propertyId, picked] of chosen) {
        try {
          // Etsy wants both the ids and the words; sending one without the
          // other is rejected.
          await api.put(`/listings/${listing.listing_id}/properties/${propertyId}`, {
            value_ids: picked.map((v) => v.valueId),
            values: picked.map((v) => v.name),
          });
        } catch (err) { showError(err, `Attribute ${propertyId} was not saved`); }
      }
      if (chosen.length) toast({ kind: 'ok', title: `${chosen.length} attribute(s) set` });

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
          — it stays a draft until you activate it from the Listings screen.{' '}
          <button className="btn xs" onClick={() => nav(`/listings?open=${created.listing_id}`)}>
            Manage photos &amp; details →
          </button>
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
              <DecimalInput value={form.price} onChange={(v) => set('price', v)} />
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

          <CategoryPicker
            value={form.taxonomy_id}
            onPick={(id) => set('taxonomy_id', id)}
            attributes={attributes}
            onAttributes={setAttributes}
          />

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
              {(choices?.shippingProfiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.title}{p.processing ? ` · ${p.processing}` : ''}</option>
              ))}
            </select>
            <div className="hint">Physical listings need one before Etsy will take the draft.</div>
          </div>

          {isPhysical && (
            <div className="field">
              <label>Processing profile</label>
              {choices?.needsProcessingProfile ? (
                <>
                  <Banner kind="warn">{choices.note}</Banner>
                  <MakeProcessingProfile onMade={(id) => { set('readiness_state_id', String(id)); reloadChoices(); }} />
                </>
              ) : (
                <>
                  <select className="select" value={form.readiness_state_id} onChange={(e) => set('readiness_state_id', e.target.value)}>
                    <option value="">—</option>
                    {(choices?.processingProfiles ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label ? `${p.label} · ` : ''}{String(p.readinessState ?? '').replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                  <div className="hint">
                    How long before you dispatch. Etsy refuses a physical listing without one, even though its
                    own documentation calls this optional.
                  </div>
                </>
              )}
            </div>
          )}

          <div className="field">
            <label>Shop section</label>
            <select className="select" value={form.shop_section_id} onChange={(e) => set('shop_section_id', e.target.value)}>
              <option value="">— none —</option>
              {(choices?.sections ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Return policy</label>
            <select className="select" value={form.return_policy_id} onChange={(e) => set('return_policy_id', e.target.value)}>
              <option value="">— none —</option>
              {(choices?.returnPolicies ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.accepts ? `Accepts returns${p.days ? ` within ${p.days} days` : ''}` : 'No returns'}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Images</label>
            <input className="input" type="file" accept="image/*" multiple
                   onChange={(e) => {
                     const picked = [...e.target.files];
                     const room = Math.max(0, 20 - images.length);
                     const accepted = picked.slice(0, room);
                     if (picked.length > accepted.length) {
                       toast({
                         kind: 'warn',
                         title: 'Etsy allows 20 images per listing',
                         body: accepted.length
                           ? `Added the first ${accepted.length} of ${picked.length} picked; the rest were left out.`
                           : `Already at 20 of 20 -- none of the ${picked.length} picked were added.`,
                       });
                     }
                     setImages([...images, ...accepted]);
                   }} />
            <div className="hint">Uploaded right after the draft is created, in the order shown below.</div>
            {images.length > 0 && (
              <div className="flex gap4 mt8" style={{ flexWrap: 'wrap' }}>
                {images.map((file, i) => (
                  <div key={`${file.name}-${file.lastModified}-${i}`} style={{ position: 'relative' }}>
                    <Thumb src={previews[i]} size="lg" />
                    <button type="button" className="btn xs" disabled={busy}
                            style={{ position: 'absolute', top: -6, right: -6, borderRadius: '50%', padding: '0 6px' }}
                            onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}

/**
 * The category box, as close to Etsy's own as its API allows.
 *
 * Etsy shows you more than the thing you typed: it shows the branch you would
 * be listing in and what sits beside it, because that decides who finds the
 * listing. So does this. Pick one and the attributes Etsy will ask for load
 * underneath, with the required ones first and the occasion-style ones - the
 * ones that put a listing into the gift guides and get forgotten - given their
 * own section.
 */
export function CategoryPicker({ value, onPick, attributes, onAttributes }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [open, setOpen] = useState(false);
  const [attrsOpen, setAttrsOpen] = useState(false);

  const { data: found, loading } = useAsync(
    () => (debounced.trim() ? api.get('/research/taxonomy/search', { q: debounced, limit: 8 }) : null),
    [debounced],
  );
  const { data: detail, loading: loadingDetail } = useAsync(
    () => (value ? api.get(`/research/taxonomy/${value}/detail`) : null),
    [value],
  );

  const choose = (id) => { onPick(id); setSearch(''); setOpen(false); onAttributes({}); };

  const picked = (propertyId) => attributes[propertyId] ?? [];
  const isPicked = (propertyId, valueId) => picked(propertyId).some((v) => v.valueId === valueId);

  const setValue = (propertyId, value, multi) => onAttributes({
    ...attributes,
    [propertyId]: multi
      ? isPicked(propertyId, value.valueId)
        ? picked(propertyId).filter((v) => v.valueId !== value.valueId)
        : [...picked(propertyId), value]
      : [value],
  });

  const propertyField = (p) => (
    <div className="field" key={p.propertyId}>
      <label>
        {p.name}
        {p.isRequired && <span className="badge red" style={{ marginLeft: 6 }}>required</span>}
        {p.supportsVariations && <span className="badge blue" style={{ marginLeft: 6 }}>can vary</span>}
      </label>
      {p.values.length ? (
        p.isMultivalued ? (
          <div className="pill-row">
            {p.values.map((v) => (
              <button key={v.valueId} type="button"
                      className={`btn xs ${isPicked(p.propertyId, v.valueId) ? 'primary' : ''}`}
                      onClick={() => setValue(p.propertyId, v, true)}>
                {v.name}
              </button>
            ))}
          </div>
        ) : (
          <select className="select" value={picked(p.propertyId)[0]?.valueId ?? ''}
                  onChange={(e) => {
                    const v = p.values.find((x) => String(x.valueId) === e.target.value);
                    if (v) setValue(p.propertyId, v, false);
                    else onAttributes({ ...attributes, [p.propertyId]: [] });
                  }}>
            <option value="">—</option>
            {p.values.map((v) => <option key={v.valueId} value={v.valueId}>{v.name}</option>)}
          </select>
        )
      ) : (
        <div className="hint">Free text on Etsy — set it on the listing once it exists.</div>
      )}
      {p.maxValues > 1 && <div className="hint">Up to {p.maxValues} choices.</div>}
    </div>
  );

  return (
    <>
      <div className="field">
        <label>Category (Etsy taxonomy)</label>
        <input className="input" placeholder="What is it? e.g. keycap set, mum, desk mat…"
               value={search}
               onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
               onFocus={() => setOpen(true)} />
        <div className="hint">
          Turkish works too — &ldquo;klavye&rdquo; finds Keyboards. Each result shows the branch it sits in
          and what is next to it, so you can see the neighbourhood before you commit.
        </div>

        {loading && <div className="small dim mt8"><Spinner /> searching…</div>}

        {open && found?.results?.length > 0 && (
          <div className="mt8" style={{ maxHeight: 300, overflowY: 'auto' }}>
            {found.results.map((hit) => (
              <div key={hit.id} className="card" style={{ padding: 10, marginBottom: 6 }}>
                <div className="flex" style={{ alignItems: 'center' }}>
                  <button type="button" className="btn xs primary" onClick={() => choose(hit.id)}>Use this</button>
                  <div style={{ marginLeft: 8 }}>
                    <div><strong>{hit.name}</strong>{hit.isLeaf ? '' : <span className="badge grey" style={{ marginLeft: 6 }}>branch</span>}</div>
                    <div className="small dim">{hit.path}</div>
                  </div>
                </div>
                {hit.related.length > 0 && (
                  <div className="pill-row mt8">
                    <span className="small dim">also:</span>
                    {hit.related.map((rel) => (
                      <button key={`${hit.id}-${rel.id}`} type="button" className="btn xs ghost"
                              title={`${rel.path} — ${rel.kind === 'narrower' ? 'inside this one' : rel.kind === 'broader' ? 'the branch above' : 'beside this one'}`}
                              onClick={() => choose(rel.id)}>
                        {rel.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {open && debounced.trim() && !loading && found && !found.results.length && (
          <div className="small dim mt8">Nothing matches &ldquo;{debounced}&rdquo;. Try a plainer word — Etsy&rsquo;s categories are broad.</div>
        )}
      </div>

      {value && (
        <div className="card" style={{ padding: 12 }}>
          {loadingDetail ? <Spinner /> : detail && (
            <>
              <div className="flex" style={{ alignItems: 'center' }}>
                <div>
                  <div><strong>{detail.name}</strong> <span className="small dim">(id {value})</span></div>
                  <div className="small dim">{detail.path}</div>
                </div>
                <div className="spacer" />
                <button type="button" className="btn xs ghost" onClick={() => { onPick(''); onAttributes({}); }}>Change</button>
              </div>

              {detail.note && <Banner kind="warn">{detail.note}</Banner>}

              {detail.children.length > 0 && (
                <div className="pill-row mt8">
                  <span className="small dim">more specific:</span>
                  {detail.children.map((c) => (
                    <button key={c.id} type="button" className="btn xs ghost" onClick={() => choose(c.id)}>{c.name}</button>
                  ))}
                </div>
              )}

              {(() => {
                const withOptions = (p) => p.values.length > 0;
                const requiredWithOptions = detail.required.filter(withOptions);
                const requiredDone = requiredWithOptions.filter((p) => picked(p.propertyId).length > 0).length;
                const totalOptional = detail.occasions.length + detail.attributes.length;
                return (
                  <div className="flex gap8 mt8" style={{ alignItems: 'center' }}>
                    <button type="button" className="btn sm" onClick={() => setAttrsOpen(true)}>
                      Attributes &amp; details…
                    </button>
                    {requiredWithOptions.length > 0 && (
                      <span className={`badge ${requiredDone === requiredWithOptions.length ? 'green' : 'amber'}`}>
                        {requiredDone}/{requiredWithOptions.length} required set
                      </span>
                    )}
                    {totalOptional > 0 && <span className="small dim">+{totalOptional} optional</span>}
                    {detail.propertyError && (
                      <span className="small dim">Etsy returned no attributes for this category ({detail.propertyError}).</span>
                    )}
                  </div>
                );
              })()}

              <Modal open={attrsOpen} onClose={() => setAttrsOpen(false)} lg
                     title={`Attributes for ${detail.name}`}>
                {detail.required.length > 0 && (
                  <>
                    <div className="section-title">Etsy requires these</div>
                    {detail.required.map(propertyField)}
                  </>
                )}

                {detail.occasions.length > 0 && (
                  <>
                    <div className="section-title">Occasion &amp; recipient</div>
                    <div className="hint mb8">
                      These are what put a listing into Etsy&rsquo;s gift guides and seasonal pages. They are optional,
                      and they are the ones most often left blank.
                    </div>
                    {detail.occasions.map(propertyField)}
                  </>
                )}

                {detail.attributes.length > 0 && (
                  <>
                    <div className="section-title">Other attributes</div>
                    {detail.attributes.map(propertyField)}
                  </>
                )}

                {!detail.required.length && !detail.occasions.length && !detail.attributes.length && (
                  <div className="small dim">
                    {detail.propertyError
                      ? `Etsy returned no attributes for this category (${detail.propertyError}).`
                      : 'Etsy has no extra attributes for this category.'}
                  </div>
                )}
              </Modal>
            </>
          )}
        </div>
      )}
    </>
  );
}
