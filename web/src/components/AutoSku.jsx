import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api.js';
import { Spinner, Banner, Thumb, Modal, Checkbox, ShopBadge, useToast, useErrorToast } from './ui.jsx';

const KIND = {
  product: ['grey', 'single product', 'A product on its own - its variants are numbered in the order the shop lists them'],
  group: ['blue', 'linked products', 'Products you linked earlier - they keep carrying the same SKUs'],
  match: ['amber', 'same product in several shops', 'These look like the same product in different shops (same supplier item, SKU, or matching photos and words). They get the same SKUs and are linked.'],
};
const CHUNK = 10;
const PAGE = 25;

/** The SKUs of a unit in a few words: KEY022-1 … KEY022-3. */
function skuRange(unit) {
  if (!unit.edits.length) return 'no SKU to give';
  const skus = [...new Set(unit.edits.map((e) => e.sku))];
  if (skus.length <= 3) return skus.join(', ');
  return `${skus[0]} … ${skus[skus.length - 1]} (${skus.length})`;
}

function UnitRow({ unit, ticked, onTick, open, onOpen }) {
  const [kind, kindText, kindHelp] = KIND[unit.kind];
  const shown = unit.products.slice(0, 3);
  return (
    <div className="card" style={{ margin: 0, padding: 10, opacity: ticked ? 1 : 0.6 }} data-testid="auto-unit" data-kind={unit.kind}>
      <div className="flex gap8" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <input type="checkbox" aria-label={`Give SKUs to ${unit.title}`} checked={ticked} onChange={(e) => onTick(e.target.checked)} style={{ marginTop: 10 }} />
        <div className="flex gap12" style={{ flex: '1 1 380px', flexWrap: 'wrap' }}>
          {shown.map((p) => (
            <div key={p.key} className="flex gap8" style={{ alignItems: 'flex-start', minWidth: 200, flex: '1 1 200px' }}>
              <Thumb src={p.imageUrl} size="lg" />
              <div style={{ minWidth: 0 }}>
                <ShopBadge channel={p.channel} name={p.shopName} />
                <div className="small" style={{ marginTop: 2 }}><a href={p.url} target="_blank" rel="noreferrer">{p.title}</a></div>
                <div className="small muted">{p.variantCount} variant{p.variantCount === 1 ? '' : 's'}</div>
              </div>
            </div>
          ))}
          {unit.products.length > shown.length && <span className="small muted">+{unit.products.length - shown.length} more</span>}
        </div>
        <div style={{ minWidth: 190 }}>
          {unit.type && <span className="badge grey" style={{ marginRight: 4 }} title={`Product type: ${unit.type.label} - its SKUs start with ${unit.type.prefix}`} data-testid="unit-type">{unit.type.label} · {unit.type.prefix}</span>}
          <span className={`badge ${kind}`} title={kindHelp}>{kindText}</span>
          {unit.score != null && <span className="badge grey" style={{ marginLeft: 4 }} title="How alike the weakest pair is">{Math.round(unit.score * 100)}%</span>}
          <div className="mono small" style={{ marginTop: 4 }}>{skuRange(unit)}</div>
          <div className="small muted">{unit.edits.length ? `${unit.edits.length} SKU${unit.edits.length === 1 ? '' : 's'} to give` : unit.notes.length ? 'nothing to write' : 'already carries the same SKUs - only linked'}</div>
          {unit.partial > 0 && <div className="small" style={{ color: 'var(--warn, #fbbf24)' }} title="Some variants exist in only some of the shops. They get a SKU of the same family.">{unit.partial} variant{unit.partial === 1 ? '' : 's'} not in every shop</div>}
          <button className="btn xs ghost" style={{ marginTop: 2 }} onClick={onOpen}>{open ? 'Hide variants' : 'Show variants'}</button>
        </div>
      </div>
      {unit.kind === 'match' && !unit.ticked && unit.score == null && (
        <div className="small muted" style={{ marginTop: 4 }}>
          Not ticked: the shops already carry different SKUs for the same variant. Decide them on the card ("Same product - confirm") where you can pick one.
        </div>
      )}
      {unit.kind === 'match' && !unit.ticked && unit.score != null && (
        <div className="small muted" style={{ marginTop: 4 }}>
          Not ticked on its own: {unit.partial > 0 ? 'the shops do not have the same variants' : unit.score < 0.85 ? 'the match is not certain' : 'it needs a look'} - compare the photos, then tick it if it is the same product.
        </div>
      )}
      {unit.notes.map((n) => <div key={n} className="small" style={{ color: 'var(--bad)', marginTop: 2 }}>{n}</div>)}
      {open && (
        <table className="data" style={{ marginTop: 8 }}>
          <thead><tr><th>Shop</th><th>Variant</th><th>SKU it gets</th></tr></thead>
          <tbody>
            {unit.edits.map((e) => (
              <tr key={e.key}><td><ShopBadge channel={e.channel} name={e.shopName} /></td><td className="small">{e.variation || '(single variant)'}</td><td className="mono small"><strong>{e.sku}</strong></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


/** The product types and the letters each one's SKUs start with - edited here, kept in the settings. */
function TypesEditor({ onClose, onSaved }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/catalog/auto-sku/types').then((r) => setRows(r.types)).catch((err) => { showError(err, 'Could not load the product types'); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i, d) => setRows((r) => { const n = [...r]; const j = i + d; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = async () => {
    setBusy(true);
    try { await api.put('/catalog/auto-sku/types', { types: rows }); toast({ kind: 'ok', title: 'Product types saved' }); onSaved(); }
    catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!window.confirm('Go back to the standard list of product types?')) return;
    setBusy(true);
    try { await api.del('/catalog/auto-sku/types'); toast({ kind: 'ok', title: 'Standard product types restored' }); onSaved(); }
    catch (err) { showError(err, 'Could not reset'); } finally { setBusy(false); }
  };
  return (
    <Modal open lg onClose={onClose} title="Product types and SKU letters"
           footer={(
             <>
               <button className="btn ghost" disabled={busy} onClick={reset}>Standard list</button>
               <button className="btn" onClick={onClose}>Cancel</button>
               <button className="btn primary" disabled={busy || !rows} onClick={save}>{busy ? <Spinner /> : 'Save'}</button>
             </>
           )}>
      <div className="small muted mb8">
        A product gets the letters of the first type (top to bottom) whose words appear in its title - so keep the narrow ones above the wide ones
        (a keycap <em>puller</em> is a tool, not a keycap). Words are separated by commas and match whole words, plural too; an entry between slashes, like /keycaps?\s+set/, is a pattern.
        Products that fit no type use the one prefix you set on the previous screen.
      </div>
      {!rows ? <div className="empty"><Spinner /></div> : (
        <table className="data">
          <thead><tr><th style={{ width: 70 }} /><th>Type</th><th style={{ width: 90 }}>SKU starts</th><th>Title contains</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={i}>
                <td>
                  <button className="btn xs ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button className="btn xs ghost" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                </td>
                <td><input className="input sm" value={t.label} aria-label={`Type ${i + 1}`} onChange={(e) => edit(i, { label: e.target.value })} /></td>
                <td><input className="input sm mono" value={t.prefix} aria-label={`Letters of ${t.label}`} onChange={(e) => edit(i, { prefix: e.target.value.toUpperCase() })} /></td>
                <td><input className="input sm" style={{ width: '100%' }} value={t.words} aria-label={`Words of ${t.label}`} onChange={(e) => edit(i, { words: e.target.value })} /></td>
                <td><button className="btn xs ghost danger" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label={`Remove ${t.label}`}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && <button className="btn xs mt8" onClick={() => setRows((r) => [...r, { key: '', label: '', prefix: '', words: '' }])}>+ Add a type</button>}
    </Modal>
  );
}

/**
 * Automatic SKUs for every variant that has none. The server works out the plan -
 * who gets which SKU - and nothing is written until the ticked products are
 * approved here. Existing SKUs are never changed.
 */
export default function AutoSkuModal({ shops, selectedProducts = [], matchSets = null, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [opts, setOpts] = useState({ scope: 'shown', prefix: '', prefixMode: 'type', numbering: 'auto', includeInactive: false, linkMatches: true });
  const [editTypes, setEditTypes] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [prefixDraft, setPrefixDraft] = useState('');
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ticked, setTicked] = useState(new Set());
  const [open, setOpen] = useState(new Set());
  const [kindFilter, setKindFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [run, setRun] = useState(null);      // { done, total, written, failed: [{title, errors}], stopped, finished }
  const stopRef = useRef(false);

  const load = useCallback(async (o) => {
    setLoading(true);
    try {
      const body = matchSets ? {
        matchSets, prefix: o.prefix || undefined, prefixMode: o.prefixMode, numbering: o.numbering, linkMatches: true,
      } : {
        shops: shops && shops.length ? shops : undefined,
        productKeys: o.scope === 'selected' ? selectedProducts : undefined,
        prefix: o.prefix || undefined, prefixMode: o.prefixMode, numbering: o.numbering, includeInactive: o.includeInactive, linkMatches: o.linkMatches,
      };
      const p = await api.post('/catalog/auto-sku/plan', body);
      setPlan(p);
      setTicked(new Set(p.units.filter((u) => u.ticked).map((u) => u.id)));
      setOpen(new Set()); setPage(0);
      if (!o.prefix) setPrefixDraft(p.prefix);
    } catch (err) { showError(err, 'Could not work out the SKUs'); } finally { setLoading(false); }
  }, [shops, selectedProducts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(opts); }, [opts]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));
  const units = plan?.units ?? [];
  const visible = useMemo(() => units.filter((u) => (kindFilter === 'all' || u.kind === kindFilter) && (typeFilter === 'all' || (u.type?.label ?? 'Other') === typeFilter)), [units, kindFilter, typeFilter]);
  const pageUnits = visible.slice(page * PAGE, page * PAGE + PAGE);
  const chosen = units.filter((u) => ticked.has(u.id));
  const chosenSkus = chosen.reduce((n, u) => n + u.edits.length, 0);
  const chosenProducts = new Set(chosen.flatMap((u) => u.edits.map((e) => e.productKey))).size;
  const busy = !!run && !run.finished;

  const tickMany = (list, on) => setTicked((prev) => { const next = new Set(prev); for (const u of list) { if (on) next.add(u.id); else next.delete(u.id); } return next; });

  const write = async () => {
    const perShop = {};
    for (const u of chosen) for (const e of u.edits) perShop[e.shopName] = (perShop[e.shopName] ?? 0) + 1;
    const lines = Object.entries(perShop).map(([shop, n]) => `${shop}: ${n}`).join('\n');
    const matches = chosen.filter((u) => u.link).length;
    if (!window.confirm(`${chosenSkus ? `Write ${chosenSkus} SKUs for ${chosenProducts} products` : `Link ${chosen.length} match${chosen.length === 1 ? '' : 'es'}`}?\n\n${lines}\n\n${matches ? `${matches} group${matches === 1 ? '' : 's'} of the same product will also be linked.\n` : ''}Only empty SKUs are filled - no existing SKU is changed.`)) return;
    stopRef.current = false;
    const state = { done: 0, total: chosen.length, written: 0, failed: [], stopped: false, finished: false };
    setRun({ ...state });
    try {
      for (let i = 0; i < chosen.length; i += CHUNK) {
        if (stopRef.current) { state.stopped = true; break; }
        const part = chosen.slice(i, i + CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const r = await api.post('/catalog/auto-sku/apply', { units: part.map((u) => ({ id: u.id, edits: u.edits.map(({ key, sku }) => ({ key, sku })), link: u.link })) });
        state.done += part.length; state.written += r.written;
        for (const u of r.units.filter((x) => !x.ok)) state.failed.push({ title: part.find((p) => p.id === u.id)?.title, errors: u.errors });
        setRun({ ...state });
      }
    } catch (err) { state.stopped = true; showError(err, 'Writing stopped'); }
    state.finished = true;
    setRun({ ...state });
    toast({ kind: state.failed.length ? 'err' : 'ok', title: `${state.written} SKU${state.written === 1 ? '' : 's'} written`, body: state.failed.length ? `${state.failed.length} product${state.failed.length === 1 ? '' : 's'} had problems - see the list.` : undefined, duration: 8000 });
    onDone?.();
    if (matchSets) setPlan((p) => ({ ...p, units: [], counts: { ...p.counts, units: 0 } })); else load(opts);
  };

  return (
    <Modal open lg onClose={busy ? () => {} : onClose} title={matchSets ? 'Same product - confirm' : 'Automatic SKUs'}
           footer={(
             <>
               {busy ? <button className="btn" onClick={() => { stopRef.current = true; }}>Stop after this batch</button> : <button className="btn" onClick={onClose}>Close</button>}
               <button className="btn primary" disabled={busy || loading || !chosen.length} onClick={write}>
                 {busy ? <Spinner /> : matchSets && !chosenSkus ? `Link ${chosen.length} match${chosen.length === 1 ? '' : 'es'}`
                   : matchSets ? `Write ${chosenSkus} SKU${chosenSkus === 1 ? '' : 's'} & link ${chosen.length} match${chosen.length === 1 ? '' : 'es'}`
                   : `Write ${chosenSkus} SKU${chosenSkus === 1 ? '' : 's'} (${chosenProducts} product${chosenProducts === 1 ? '' : 's'})`}
               </button>
             </>
           )}>
      {matchSets ? (
        <div className="small muted mb8">
          You said these products are the same one. Their variants are paired up and share SKUs - a SKU that exists is passed on to the shops that lack it,
          a variant only one shop has gets a SKU of the same family - and the products are linked. A SKU that exists is never changed.
          Nothing is written until you press the button below - untick any match you want to leave out.
        </div>
      ) : (
      <div className="small muted mb8">
        Gives a SKU to every variant that has none. A SKU that exists is never changed, a SKU is never used twice, and the same product in several shops gets the same SKUs.
        Nothing is written until you press the button below - untick any product you want to leave out.
      </div>
      )}

      <div className="flex gap12 mb8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {!matchSets && <label className="small">Which products
          <select className="select sm" style={{ display: 'block' }} value={opts.scope} disabled={busy} onChange={(e) => set({ scope: e.target.value })}>
            <option value="shown">All in the shops shown{shops?.length ? ` (${shops.length})` : ''}</option>
            <option value="selected" disabled={!selectedProducts.length}>Only the {selectedProducts.length} selected</option>
          </select>
        </label>}
        <label className="small">SKU letters
          <select className="select sm" style={{ display: 'block' }} value={opts.prefixMode} disabled={busy} aria-label="SKU letters" onChange={(e) => set({ prefixMode: e.target.value })}>
            <option value="type">by product type (KC, KCS, BAG, DM …)</option>
            <option value="single">the same letters for everything</option>
          </select>
        </label>
        <label className="small">{opts.prefixMode === 'type' ? 'Other products start with' : 'SKU starts with'}
          <input className="input sm mono" style={{ display: 'block', width: 90 }} value={prefixDraft} disabled={busy} aria-label="SKU prefix"
                 onChange={(e) => setPrefixDraft(e.target.value.toUpperCase())}
                 onBlur={() => { if (prefixDraft && prefixDraft !== (opts.prefix || plan?.prefix)) set({ prefix: prefixDraft }); }}
                 onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </label>
        {opts.prefixMode === 'type' && <button className="btn xs" disabled={busy} onClick={() => setEditTypes(true)} title="Change which words make a product a keycap, a keycap set, a bag … and the letters each one gets">Product types…</button>}
        <label className="small">Variants numbered
          <select className="select sm" style={{ display: 'block' }} value={opts.numbering} disabled={busy} onChange={(e) => set({ numbering: e.target.value })}>
            <option value="auto">like the catalogue{plan ? ` (${plan.style.sep}${'1'.padStart(plan.style.width, '0')})` : ''}</option>
            <option value="1">-1, -2, -3</option>
            <option value="01">-01, -02, -03</option>
          </select>
        </label>
        {!matchSets && <Checkbox checked={opts.linkMatches} disabled={busy} onChange={(v) => set({ linkMatches: v })} label="Link products that are the same" />}
        {!matchSets && <Checkbox checked={opts.includeInactive} disabled={busy} onChange={(v) => set({ includeInactive: v })} label="Include drafts and expired listings" />}
      </div>

        {run && (
          <div className="mb8" data-testid="auto-progress">
            <div className="small">{run.finished ? (run.stopped ? 'Stopped' : 'Done') : 'Writing'}: {run.done} of {run.total} products · {run.written} SKUs written{run.failed.length ? ` · ${run.failed.length} with problems` : ''}</div>
            <div style={{ height: 6, background: 'var(--line, #223)', borderRadius: 3, marginTop: 4 }}>
              <div style={{ height: 6, width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%`, background: 'var(--brand)', borderRadius: 3 }} />
            </div>
            {run.failed.slice(0, 8).map((f, i) => <div key={i} className="small" style={{ color: 'var(--bad)' }}>{f.title}: {f.errors[0]}</div>)}
          </div>
        )}

      {loading ? (
        <div className="empty"><Spinner /><p className="small muted">Working out the SKUs and looking at the photos of look-alike products…</p></div>
      ) : !plan ? null : !units.length ? (
        <Banner kind="ok">{matchSets ? (run?.finished ? 'All done.' : 'Nothing to confirm.') : `Nothing to give: every variant here already has a SKU${plan.skipped.length ? `, apart from ${plan.skipped.length} left out below` : ''}.`}</Banner>
      ) : (
        <>
          <Banner kind="info">
            <strong>{plan.counts.variants.toLocaleString()} SKUs</strong> for {plan.counts.products.toLocaleString()} products:{' '}
            {matchSets ? `${plan.counts.matches} confirmed match${plan.counts.matches === 1 ? '' : 'es'}.` : `${plan.counts.single} single, ${plan.counts.matches} same-product match${plan.counts.matches === 1 ? '' : 'es'}, ${plan.counts.groups} linked group${plan.counts.groups === 1 ? '' : 's'}.`}
            {' '}{plan.prefixMode === 'type' ? <>By type: {Object.entries(plan.counts.byType ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ')}. Products of no type start with <span className="mono">{plan.prefix}</span> ({plan.prefixSource === 'catalogue' ? 'taken from your existing SKUs' : plan.prefixSource === 'typed' ? 'typed by you' : 'from the settings'}), next <span className="mono">{plan.prefix}{String(plan.nextNumber).padStart(3, '0')}</span>.</>
              : <>Next free number: <span className="mono">{plan.prefix}{String(plan.nextNumber).padStart(3, '0')}</span> ({plan.prefixSource === 'catalogue' ? 'prefix taken from your existing SKUs' : plan.prefixSource === 'typed' ? 'prefix typed by you' : 'prefix from the settings'}).</>}
            {' '}{plan.counts.ticked} of {plan.counts.units} ticked.
          </Banner>
          <div className="flex gap8 mb8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="select sm" value={kindFilter} onChange={(e) => { setKindFilter(e.target.value); setPage(0); }} aria-label="Show">
              <option value="all">All ({units.length})</option>
              <option value="match">Same product in several shops ({plan.counts.matches})</option>
              <option value="group">Linked products ({plan.counts.groups})</option>
              <option value="product">Single products ({plan.counts.single})</option>
            </select>
            {plan.prefixMode === 'type' && (
              <select className="select sm" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }} aria-label="Product type">
                <option value="all">Every type</option>
                {Object.entries(plan.counts.byType ?? {}).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
              </select>
            )}
            <button className="btn xs ghost" disabled={busy} onClick={() => tickMany(visible, true)}>Tick all shown</button>
            <button className="btn xs ghost" disabled={busy} onClick={() => tickMany(visible, false)}>Untick all shown</button>
            <div style={{ flex: 1 }} />
            <span className="small muted">{visible.length ? `${page * PAGE + 1}–${Math.min(visible.length, page * PAGE + PAGE)} of ${visible.length}` : ''}</span>
            <button className="btn xs ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
            <button className="btn xs ghost" disabled={(page + 1) * PAGE >= visible.length} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
          <div className="flex col" style={{ gap: 8 }}>
            {pageUnits.map((u) => (
              <UnitRow key={u.id} unit={u} ticked={ticked.has(u.id)} onTick={(on) => tickMany([u], on)}
                       open={open.has(u.id)} onOpen={() => setOpen((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })} />
            ))}
          </div>
        </>
      )}

      {editTypes && <TypesEditor onClose={() => setEditTypes(false)} onSaved={() => { setEditTypes(false); load(opts); }} />}

      {plan && plan.skipped.length > 0 && (
        <details className="mt16">
          <summary className="small muted" style={{ cursor: 'pointer' }}>{plan.skipped.length} left out</summary>
          <div className="flex col" style={{ gap: 3, marginTop: 6 }}>
            {plan.skipped.slice(0, 60).map((s, i) => (
              <div key={i} className="small muted">{s.products.map((p) => `${p.title} (${p.shopName})`).join(' / ')} - {s.reason}</div>
            ))}
          </div>
        </details>
      )}
    </Modal>
  );
}
