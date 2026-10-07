import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api.js';
import { Spinner, Empty, Banner, Thumb, Modal, ShopBadge, useAsync, useToast, useErrorToast } from './ui.jsx';
import AutoSkuModal from './AutoSku.jsx';

export { ShopBadge };

const AI_VERDICT = { same: ['green', 'same product'], different: ['red', 'different'], unsure: ['amber', 'unsure'] };
const TIER = { sure: ['green', 'sure'], likely: ['amber', 'likely'], maybe: ['grey', 'maybe'] };

/** Why two products are thought to be the same, in a few chips. */
function Evidence({ edge }) {
  return (
    <span className="flex gap4" style={{ flexWrap: 'wrap' }}>
      {edge.sku === 'same' && <span className="badge green" title="They already share a SKU">same SKU</span>}
      {edge.sku === 'family' && <span className="badge green" title="Their SKUs start the same way (KEY004-1 / KEY004)">same SKU family</span>}
      {edge.supplier && <span className="badge green" title="Their supplier links point at the same item">same supplier item</span>}
      {edge.title != null && <span className="badge grey" title="How much of the titles' wording is shared (rare words count more)">titles {Math.round(edge.title * 100)}%</span>}
      {edge.image?.sim != null && <span className={`badge ${edge.image.sim >= 0.8 ? 'green' : edge.image.sim >= 0.62 ? 'amber' : 'red'}`} title="Colour likeness of the first photos">photos {Math.round(edge.image.sim * 100)}%</span>}
      {edge.ai && (
        <span className={`badge ${AI_VERDICT[edge.ai.verdict]?.[0] ?? 'grey'}`} title={edge.ai.summary || 'The AI looked at both photos'}>
          AI: {AI_VERDICT[edge.ai.verdict]?.[1] ?? edge.ai.verdict}{edge.ai.confidence != null ? ` ${Math.round(edge.ai.confidence * 100)}%` : ''}
        </span>
      )}
      {edge.aiError && <span className="badge red" title={edge.aiError}>AI failed</span>}
    </span>
  );
}

function ProductCard({ p, pick }) {
  return (
    <div className="flex gap8" style={{ alignItems: 'flex-start', minWidth: 230, flex: '1 1 230px', opacity: pick && !pick.checked ? 0.55 : 1 }}>
      {pick && <input type="checkbox" aria-label={`Select ${p.title}`} title="Tick the products that are the same one" checked={pick.checked} onChange={(e) => pick.onChange(e.target.checked)} style={{ marginTop: 8 }} />}
      <Thumb src={p.imageUrl} size="lg" />
      <div style={{ minWidth: 0 }}>
        <ShopBadge channel={p.channel} name={p.shopName} />
        <div className="small" style={{ marginTop: 2 }}><a href={p.url} target="_blank" rel="noreferrer">{p.title}</a></div>
        <div className="small muted">{p.variantCount} variant{p.variantCount === 1 ? '' : 's'}{p.skus.length ? ` · ${p.skus.slice(0, 3).join(', ')}${p.skus.length > 3 ? '…' : ''}` : ' · no SKU'}</div>
      </div>
    </div>
  );
}

/**
 * Line the variants of linked products up and decide the SKU each pair shares.
 * The proposal comes from the server; every part of it can be changed here
 * before anything is written - which variant sits with which, and the SKU.
 */
export function LinkModal({ productKeys, onClose, onDone }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [slots, setSlots] = useState([]);
  const [problems, setProblems] = useState({});
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(null);

  useEffect(() => {
    let alive = true;
    api.post('/catalog/matrix', { productKeys })
      .then((m) => { if (alive) { setProducts(m.products); setSlots(m.slots.map((s) => ({ ...s, members: s.members }))); setLoading(false); } })
      .catch((err) => { showError(err, 'Could not line the variants up'); onClose(); });
    return () => { alive = false; };
  }, [productKeys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const memberOf = (slot, productKey) => slot.members.find((m) => m.productKey === productKey);
  const setSku = (id, sku) => { setChecked(null); setSlots((s) => s.map((x) => (x.id === id ? { ...x, sku } : x))); };

  /** Move one variant to another row, or to a row of its own. */
  const move = (member, target) => {
    setChecked(null);
    setSlots((all) => {
      const without = all.map((s) => ({ ...s, members: s.members.filter((m) => m.key !== member.key) }));
      let next;
      if (target === 'new') {
        next = [...without, { id: Math.max(-1, ...all.map((s) => s.id)) + 1, label: member.variation || '(single variant)', sku: '', generated: true, conflict: false, currentSkus: [], missingIn: [], members: [member] }];
      } else {
        next = without.map((s) => (s.id === Number(target) ? { ...s, members: [...s.members, member], sku: s.sku || member.sku } : s));
      }
      return next.filter((s) => s.members.length);
    });
  };

  const setSkip = (id, skip) => { setChecked(null); setSlots((s) => s.map((x) => (x.id === id ? { ...x, skip } : x))); };

  // rows set to "leave unchanged" are not sent at all - those variants keep whatever SKU they have
  const active = useMemo(() => slots.filter((s) => !s.skip), [slots]);
  const payload = useMemo(() => active.map((s) => ({ sku: s.sku.trim(), memberKeys: s.members.map((m) => m.key) })), [active]);
  const ready = active.length > 0 && active.every((s) => s.sku.trim());
  const partialRows = slots.filter((s) => products.length > 1 && s.members.length < products.length);
  const counts = products.map((p) => `${p.shopName}: ${p.variantCount} variant${p.variantCount === 1 ? '' : 's'}`);
  const unequal = new Set(products.map((p) => p.variantCount)).size > 1;

  const run = async (dryRun) => api.post('/catalog/link', { productKeys, slots: payload, dryRun });
  const check = async () => {
    setBusy(true);
    try {
      const r = await run(true);
      setChecked(r);
      setProblems(Object.fromEntries(r.results.filter((x) => !x.ok).map((x) => [x.key, x.error])));
    } catch (err) { showError(err, 'Check failed'); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const dry = await run(true);
      setChecked(dry);
      const bad = dry.results.filter((x) => !x.ok);
      setProblems(Object.fromEntries(bad.map((x) => [x.key, x.error])));
      if (bad.length) { toast({ kind: 'err', title: `${bad.length} SKU${bad.length === 1 ? '' : 's'} cannot be written`, body: 'Fix the marked ones first - nothing was sent.' }); return; }
      const byShop = {};
      for (const r of dry.results.filter((x) => !x.unchanged)) byShop[r.shop] = (byShop[r.shop] ?? 0) + 1;
      const lines = Object.entries(byShop).map(([shop, n]) => `${shop}: ${n}`).join('\n') || 'No SKU changes - the products are only linked.';
      if (!window.confirm(`Link these products and write their SKUs?\n\n${lines}`)) return;
      const r = await run(false);
      if (r.failed) toast({ kind: 'err', title: `${r.changed} written, ${r.failed} failed`, body: r.results.filter((x) => !x.ok).map((x) => x.error).slice(0, 2).join(' · '), duration: 10000 });
      else toast({ kind: 'ok', title: 'Linked', body: r.changed ? `${r.changed} SKU${r.changed === 1 ? '' : 's'} written to the shops.` : 'The SKUs already matched.' });
      onDone();
    } catch (err) { showError(err, 'Could not write the SKUs'); } finally { setBusy(false); }
  };
  const linkOnly = async () => {
    setBusy(true);
    try { await api.post('/catalog/groups', { productKeys }); toast({ kind: 'ok', title: 'Linked - no SKU was changed' }); onDone(); }
    catch (err) { showError(err, 'Could not link them'); } finally { setBusy(false); }
  };

  return (
    <Modal open lg onClose={onClose} title="Same product in several shops - line up the variants"
           footer={(
             <>
               <button className="btn" disabled={busy || loading} onClick={linkOnly} title="Only remember that these are the same product; leave every SKU as it is">Link only</button>
               <button className="btn" disabled={busy || loading || !ready} onClick={check}>Check</button>
               <button className="btn primary" disabled={busy || loading || !ready} onClick={apply}>{busy ? <Spinner /> : 'Write SKUs & link'}</button>
             </>
           )}>
      {loading ? <div className="empty"><Spinner /></div> : (
        <>
          <div className="small muted mb8">
            Variants that are the same thing share one SKU. A variant a shop does not have stays on its own row and still gets a SKU in the same family,
            so when the shop adds it the SKU is ready. A SKU that is already in use is kept; if shops disagree, pick one. Change a row's SKU, or move a variant to another row, before writing.
            Only SKUs change - prices, stock and titles are never touched.
          </div>
          {(unequal || partialRows.length > 0) && (
            <Banner kind="warn">
              <strong>The shops do not have the same variants.</strong> {counts.join(' · ')}.{' '}
              {partialRows.length} variant row{partialRows.length === 1 ? '' : 's'} exist{partialRows.length === 1 ? 's' : ''} in only some of the shops (marked "only in …").
              Each stays on its own row and gets a SKU of the same family, so when the other shop adds that variant its SKU is already decided.
              To leave a variant exactly as it is, tick "leave unchanged" on its row.
            </Banner>
          )}
          {checked && !Object.keys(problems).length && (
            <Banner kind="info">Checked: {checked.changed} SKU change{checked.changed === 1 ? '' : 's'} would be written, nothing is blocked.</Banner>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ minWidth: 190 }}>SKU for the row</th>
                  {products.map((p) => (
                    <th key={p.key} style={{ minWidth: 200, verticalAlign: 'top' }}><ProductCard p={p} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slots.map((s) => (
                  <tr key={s.id}>
                    <td style={{ verticalAlign: 'top' }}>
                      <input className="input sm mono" style={{ width: 160, opacity: s.skip ? 0.5 : 1 }} value={s.sku} placeholder="type a SKU" disabled={!!s.skip} onChange={(e) => setSku(s.id, e.target.value)} />
                      <div className="flex gap4" style={{ flexWrap: 'wrap', marginTop: 3 }}>
                        {s.conflict && <span className="badge amber" title={`The shops disagree: ${s.currentSkus.join(' / ')}`}>pick one: {s.currentSkus.join(' / ')}</span>}
                        {s.generated && s.sku && <span className="badge blue" title="No shop had a SKU for this one - this is a new one in the same family">new</span>}
                        {s.members.length < products.length && <span className="badge grey" title={`Not in: ${[...new Set(products.filter((p) => !s.members.some((m) => m.productKey === p.key)).map((p) => p.shopName))].join(', ')}`}>only in {[...new Set(s.members.map((m) => m.shopName))].join(', ')}</span>}
                      </div>
                      {s.members.length < products.length && (
                        <label className="small" style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 3 }} title="Do not write a SKU for this variant - it keeps the SKU it has now">
                          <input type="checkbox" checked={!!s.skip} onChange={(e) => setSkip(s.id, e.target.checked)} /> leave unchanged
                        </label>
                      )}
                    </td>
                    {products.map((p) => {
                      const m = memberOf(s, p.key);
                      if (!m) return <td key={p.key} className="small muted" style={{ verticalAlign: 'top' }}>—</td>;
                      const free = slots.filter((o) => o.id !== s.id && !memberOf(o, p.key));
                      return (
                        <td key={p.key} style={{ verticalAlign: 'top' }}>
                          <div className="small"><strong>{m.variation || '(single variant)'}</strong></div>
                          <div className="small muted mono">{m.sku ? `now ${m.sku}` : 'no SKU yet'}{m.sku && s.sku && m.sku.toLowerCase() !== s.sku.trim().toLowerCase() ? ' → changes' : ''}</div>
                          {problems[m.key] && <div className="small" style={{ color: 'var(--bad)' }}>{problems[m.key]}</div>}
                          {(free.length > 0 || s.members.length > 1) && (
                            <select className="select sm" style={{ marginTop: 3, maxWidth: 190 }} value={String(s.id)} onChange={(e) => move(m, e.target.value)} title="Pair this variant with a different row">
                              <option value={String(s.id)}>on this row</option>
                              {free.map((o) => <option key={o.id} value={String(o.id)}>move to: {o.label}</option>)}
                              {s.members.length > 1 && <option value="new">its own row</option>}
                            </select>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

const shopOf = (m) => m.shopKey;
const pairId = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The products worth ticking first: the strongest pair, plus others that tie to them well, one per shop. */
function defaultPick(s) {
  const byKey = new Map(s.members.map((m) => [m.key, m]));
  const edges = [...s.evidence].sort((x, y) => y.score - x.score);
  if (!edges.length) return new Set(s.members.slice(0, 2).map((m) => m.key));
  const picked = new Set([edges[0].a, edges[0].b]);
  const shops = new Set([...picked].map((k) => shopOf(byKey.get(k))));
  for (const e of edges.slice(1)) {
    if (e.score < 0.6) break;
    const inA = picked.has(e.a); const inB = picked.has(e.b);
    if (inA === inB) continue;
    const other = inA ? e.b : e.a;
    const o = byKey.get(other);
    if (shops.has(shopOf(o))) {
      // two listings of one shop only when each is one variant of the same bigger product elsewhere
      const anchor = byKey.get(inA ? e.a : e.b);
      const sameShop = [...picked].map((k) => byKey.get(k)).filter((m) => shopOf(m) === shopOf(o));
      if (!(shopOf(anchor) !== shopOf(o) && anchor.variantCount >= 2 && o.variantCount === 1 && sameShop.every((m) => m.variantCount === 1))) continue;
    }
    picked.add(other); shops.add(shopOf(o));
  }
  return picked;
}

/**
 * One suggested match. The products are ticked by a person - the suggestion only
 * says which ones look alike - and only the ticked ones go on: to the optional AI
 * look, to "not the same", or to the confirmation that opens the variant line-up.
 */
function SuggestionCard({ s, picked, onPick, inBulk, onBulk, onLink, onRejected }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [aiResults, setAiResults] = useState({});   // pair -> what the AI said just now (saved answers come with the suggestion)
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = s.members.filter((m) => picked.has(m.key));
  const shopCounts = new Map();
  for (const m of selected) shopCounts.set(m.shopName, (shopCounts.get(m.shopName) ?? 0) + 1);
  const sameShop = [...shopCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  const canConfirm = selected.length >= 2 && new Set(selected.map((m) => m.shopKey)).size >= 2;
  const byName = new Map(s.members.map((m) => [m.key, m.shopName]));

  const evidenceOf = new Map(s.evidence.map((e) => [pairId(e.a, e.b), e]));
  const pairs = [];
  for (let i = 0; i < selected.length; i += 1) for (let j = i + 1; j < selected.length; j += 1) {
    if (selected[i].shopKey === selected[j].shopKey) continue;
    const id = pairId(selected[i].key, selected[j].key);
    const ev = evidenceOf.get(id);
    const fresh = aiResults[id];
    pairs.push({ id, a: selected[i].key, b: selected[j].key, ev, ai: fresh?.ai ?? ev?.ai ?? null, aiError: fresh?.error ?? null });
  }
  const rows = pairs.filter((x) => x.ev || x.ai || x.aiError).sort((x, y) => (y.ev?.score ?? 0) - (x.ev?.score ?? 0)).slice(0, 6);
  const toAsk = [...pairs].sort((x, y) => (y.ev?.score ?? 0) - (x.ev?.score ?? 0)).slice(0, 6);
  const canAsk = toAsk.length > 0 && toAsk.some((x) => !x.ai);

  const toggle = (key, on) => { const next = new Set(picked); if (on) next.add(key); else next.delete(key); onPick(next); };

  /** Optional: one small AI look at the photos of the ticked products. Nothing runs unless this is pressed. */
  const askAi = async () => {
    setAiBusy(true);
    try {
      const ask = toAsk.filter((x) => !x.ai);
      const r = await api.post('/catalog/ai-compare', { pairs: ask.map((x) => ({ a: x.a, b: x.b })) });
      setAiResults((prev) => ({ ...prev, ...Object.fromEntries(r.results.map((x) => [pairId(x.a, x.b), x])) }));
      const failed = r.results.filter((x) => x.error);
      if (failed.length) toast({ kind: 'err', title: `${failed.length} of ${r.results.length} could not be checked`, body: failed[0].error, duration: 8000 });
    } catch (err) { showError(err, 'AI check failed'); } finally { setAiBusy(false); }
  };
  const notSame = async () => {
    if (!window.confirm(`Mark these ${selected.length} products as different products?\nThey will not be suggested together again.`)) return;
    setBusy(true);
    try {
      await api.post('/catalog/reject', { keys: selected.map((m) => m.key) });
      toast({ kind: 'ok', title: 'Marked as different products' });
      onRejected();
    } catch (err) { showError(err, 'Could not save that'); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ margin: 0, padding: 10 }} data-testid="suggestion">
      <div className="flex gap8" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        <input type="checkbox" aria-label="Include this match in the bulk action" checked={inBulk && canConfirm} disabled={!canConfirm}
               title={canConfirm ? 'Tick to confirm / reject many matches at once (see the bar above the list)' : 'Tick products of at least two shops to include this match'}
               onChange={(e) => onBulk(e.target.checked)} />
        <span className={`badge ${TIER[s.tier][0]}`}>{TIER[s.tier][1]} · {Math.round(s.score * 100)}%</span>
        {s.joinsGroup != null && <span className="badge blue">adds to group #{s.joinsGroup}</span>}
        <span className="small muted">{selected.length} of {s.members.length} ticked</span>
        {s.members.length > 2 && (
          <button className="btn xs ghost" onClick={() => onPick(selected.length === s.members.length ? new Set() : new Set(s.members.map((m) => m.key)))}>
            {selected.length === s.members.length ? 'Tick none' : 'Tick all'}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {canAsk && (
          <button className="btn xs" disabled={aiBusy} onClick={askAi}
                  title="Optional. The matching is free and uses no AI; this asks one small AI model to look at the photos of the ticked products when you are not sure. It links nothing.">
            {aiBusy ? <Spinner /> : 'Check with AI'}
          </button>
        )}
        <button className="btn xs ghost" disabled={busy || selected.length < 2} onClick={notSame}
                title="The ticked products are different products - do not suggest them together again">Not the same</button>
        <button className="btn xs primary" disabled={!canConfirm} onClick={() => onLink(selected.map((m) => m.key))}
                title={canConfirm ? 'Yes, these are the same product - go on to line up their variants (nothing is written yet)' : 'Tick products of at least two shops'}>
          Same product - confirm ({selected.length})…
        </button>
      </div>
      <div className="flex gap12" style={{ flexWrap: 'wrap' }}>
        {s.members.map((m) => <ProductCard key={m.key} p={m} pick={{ checked: picked.has(m.key), onChange: (on) => toggle(m.key, on) }} />)}
      </div>
      {sameShop.length > 0 && (
        <div className="small muted" style={{ marginTop: 6 }} data-testid="same-shop-note">
          More than one ticked product is in {sameShop.join(', ')}. That is fine when each of them is one variant of the other shop's product
          ("Desk mat - Small", "Desk mat - Large"): each is lined up with its own variant and gets its own SKU. Two copies of the same thing would not belong together - untick one of them.
        </div>
      )}
      <div className="flex col" style={{ gap: 3, marginTop: 6 }}>
        {rows.map((x) => (
          <div key={x.id} className="small muted">
            {byName.get(x.a)} ↔ {byName.get(x.b)}: <Evidence edge={{ ...(x.ev ?? {}), ai: x.ai, aiError: x.aiError }} />
          </div>
        ))}
        {selected.length >= 2 && !rows.length && !sameShop.length && <div className="small muted">Nothing in common was found between the ticked products - look at them yourself, or use "Check with AI".</div>}
      </div>
    </div>
  );
}

/** Suggested matches and the groups already made. */
export default function MatchesTab({ onChanged }) {
  const toast = useToast();
  const showError = useErrorToast();
  const [linking, setLinking] = useState(null); // product keys
  const suggestions = useAsync(() => api.get('/catalog/suggestions'), []);
  const groups = useAsync(() => api.get('/catalog/groups'), []);
  const reloadAll = useCallback(() => { suggestions.reload(); groups.reload(); onChanged?.(); }, [suggestions, groups, onChanged]);

  // what is ticked on each card (absent = the suggestion's own default), and which cards are in the bulk action
  const [picks, setPicks] = useState({});
  const [bulk, setBulk] = useState(new Set());
  const [bulkSets, setBulkSets] = useState(null);   // product-key sets being confirmed together
  const [bulkBusy, setBulkBusy] = useState(false);
  const idOf = (s) => s.members.map((m) => m.key).join('|');
  const pickedOf = (s) => picks[idOf(s)] ?? defaultPick(s);
  const chosenOf = (s) => s.members.filter((m) => pickedOf(s).has(m.key));
  const validOf = (s) => { const c = chosenOf(s); return c.length >= 2 && new Set(c.map((m) => m.shopKey)).size >= 2; };

  const unlink = async (productKey) => {
    if (!window.confirm('Take this product out of the group? Its SKUs stay as they are.')) return;
    try { await api.post('/catalog/unlink', { productKey }); reloadAll(); } catch (err) { showError(err, 'Could not unlink'); }
  };
  const dropGroup = async (g) => {
    if (!window.confirm('Remove this group? The products and their SKUs stay as they are.')) return;
    try { await api.del(`/catalog/groups/${g.id}`); reloadAll(); } catch (err) { showError(err, 'Could not remove the group'); }
  };

  const list = suggestions.data?.suggestions ?? [];
  const inBulk = list.filter((s) => bulk.has(idOf(s)) && validOf(s));
  const bulkProducts = inBulk.reduce((n, s) => n + chosenOf(s).length, 0);
  const tickBulk = (cards) => setBulk(new Set(cards.map(idOf)));
  // the pairs of the ticked products that have no AI answer yet (at most 3 per match) - asked only when the button is pressed
  const bulkAiPairs = inBulk.flatMap((s) => {
    const keys = new Set(chosenOf(s).map((m) => m.key));
    return s.evidence.filter((e) => keys.has(e.a) && keys.has(e.b) && !e.ai).slice(0, 3).map((e) => ({ a: e.a, b: e.b }));
  });
  const aiBulk = async () => {
    if (!window.confirm(`Ask the AI about ${bulkAiPairs.length} pair${bulkAiPairs.length === 1 ? '' : 's'} of products?\nOne small AI call each; nothing is linked or changed by it.`)) return;
    setBulkBusy(true);
    try {
      let failed = 0;
      for (let i = 0; i < bulkAiPairs.length; i += 6) {
        const r = await api.post('/catalog/ai-compare', { pairs: bulkAiPairs.slice(i, i + 6) }); // eslint-disable-line no-await-in-loop
        failed += r.results.filter((x) => x.error).length;
      }
      toast(failed ? { kind: 'err', title: `${failed} pair${failed === 1 ? '' : 's'} could not be checked`, duration: 8000 } : { kind: 'ok', title: 'The AI has looked at them - see the badges on the cards' });
      suggestions.reload();
    } catch (err) { showError(err, 'AI check failed'); } finally { setBulkBusy(false); }
  };
  const rejectBulk = async () => {
    if (!window.confirm(`Mark the ticked products of ${inBulk.length} match${inBulk.length === 1 ? '' : 'es'} as different products?\nThey will not be suggested together again.`)) return;
    setBulkBusy(true);
    try {
      for (const s of inBulk) await api.post('/catalog/reject', { keys: chosenOf(s).map((m) => m.key) }); // eslint-disable-line no-await-in-loop
      toast({ kind: 'ok', title: `${inBulk.length} match${inBulk.length === 1 ? '' : 'es'} marked as different products` });
      setBulk(new Set()); suggestions.reload();
    } catch (err) { showError(err, 'Could not save that'); } finally { setBulkBusy(false); }
  };
  return (
    <div style={{ padding: 16 }}>
      <div className="card mb16">
        <div className="card-head"><h3>Looks like the same product</h3></div>
        <div className="card-sub">
          Products of different shops that point at the same supplier item, already share a SKU, or have matching titles and photos.
          This matching is free - no AI is used. Press "Check with AI" on a card only when you are unsure.
          Tick the products that really are the same one, then confirm - only then do their variants get lined up,
          and nothing is linked or changed until you approve that last step.
        </div>
        {suggestions.loading && !suggestions.data ? <Spinner /> : !list.length ? (
          <Empty icon="⧉" title="No unlinked matches found">Products already linked, or marked "not the same", are left out.</Empty>
        ) : (
          <>
            <div className="selection-bar" style={{ position: 'sticky', top: 0, zIndex: 5, marginBottom: 10 }} data-testid="bulk-bar">
              <span className="small muted">Many at once:</span>
              <button className="btn xs" onClick={() => tickBulk(list.filter((x) => x.tier === 'sure' && validOf(x)))}
                      title="Tick every match the app is sure of, with the products it has ticked in each">Tick all sure ({list.filter((x) => x.tier === 'sure' && validOf(x)).length})</button>
              <button className="btn xs ghost" onClick={() => tickBulk(list.filter(validOf))}>Tick all ({list.filter(validOf).length})</button>
              <button className="btn xs ghost" disabled={!bulk.size} onClick={() => setBulk(new Set())}>Clear</button>
              <span className="count">{inBulk.length} match{inBulk.length === 1 ? '' : 'es'} · {bulkProducts} products ticked</span>
              <div className="spacer" />
              <button className="btn xs" disabled={!bulkAiPairs.length || bulkBusy} onClick={aiBulk}
                      title="Optional. The matching is free and uses no AI; this asks one small AI model to look at the photos of the ticked products when you are not sure.">Check with AI ({bulkAiPairs.length})</button>
              <button className="btn xs ghost" disabled={!inBulk.length || bulkBusy} onClick={rejectBulk}>Not the same ({inBulk.length})</button>
              <button className="btn xs primary" disabled={!inBulk.length || bulkBusy} onClick={() => setBulkSets(inBulk.map((x) => chosenOf(x).map((m) => m.key)))}
                      title="They are the same product: pair their variants, give them the same SKUs and link them - you see everything before it is written">
                Same product - confirm {inBulk.length} match{inBulk.length === 1 ? '' : 'es'}…
              </button>
            </div>
            <div className="flex col" style={{ gap: 10 }}>
              {list.map((s) => (
                <SuggestionCard key={idOf(s)} s={s} picked={pickedOf(s)} onPick={(set) => setPicks((p) => ({ ...p, [idOf(s)]: set }))}
                                inBulk={bulk.has(idOf(s))} onBulk={(on) => setBulk((b) => { const n = new Set(b); if (on) n.add(idOf(s)); else n.delete(idOf(s)); return n; })}
                                onLink={setLinking} onRejected={() => suggestions.reload()} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3>Linked products</h3></div>
        <div className="card-sub">Products you have linked. "Aligned" counts the variant rows whose shops all carry the same SKU.</div>
        {groups.loading && !groups.data ? <Spinner /> : !(groups.data?.groups ?? []).length ? (
          <Empty icon="🔗" title="Nothing linked yet" />
        ) : (
          <div className="flex col" style={{ gap: 10 }}>
            {groups.data.groups.map((g) => (
              <div key={g.id} className="card" style={{ margin: 0, padding: 10 }}>
                <div className="flex gap8" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                  <strong>#{g.id} {g.title}</strong>
                  <span className={`badge ${g.aligned === g.slots ? 'green' : 'amber'}`}>{g.aligned} of {g.slots} variant rows aligned</span>
                  {g.partial > 0 && <span className="badge grey" title="Variants that exist in some of the shops only">{g.partial} not in every shop</span>}
                  <div style={{ flex: 1 }} />
                  <button className="btn xs" onClick={() => setLinking(g.members.map((m) => m.key))}>Line up SKUs…</button>
                  <button className="btn xs ghost danger" onClick={() => dropGroup(g)}>Remove group</button>
                </div>
                <div className="flex gap12" style={{ flexWrap: 'wrap' }}>
                  {g.members.map((m) => (
                    <div key={m.key}>
                      <ProductCard p={m} />
                      <button className="btn xs ghost" style={{ marginTop: 2 }} onClick={() => unlink(m.key)}>Unlink</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {bulkSets && <AutoSkuModal matchSets={bulkSets} onClose={() => setBulkSets(null)} onDone={() => { setBulk(new Set()); reloadAll(); }} />}

      {linking && <LinkModal productKeys={linking} onClose={() => setLinking(null)} onDone={() => { setLinking(null); reloadAll(); }} />}
    </div>
  );
}
