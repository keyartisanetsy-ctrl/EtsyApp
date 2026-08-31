import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import {
  Spinner, Banner, Tabs, CopyButton, Empty, Thumb,
  useAsync, useToast, useErrorToast, fmtAgo,
} from '../components/ui.jsx';

export default function AiStudio() {
  const [tab, setTab] = useState('reply');
  const { data: status } = useAsync(() => api.get('/ai/status'), []);

  const configured = status && ['manus', 'anthropic', 'openai'].some((p) => status[p].configured);

  return (
    <Page
      title="AI studio"
      subtitle={status ? `default: ${status.active}` : ''}
      actions={
        <div className="pill-row">
          {status && ['manus', 'anthropic', 'openai'].map((p) => (
            <span key={p} className={`badge ${status[p].configured ? 'green' : 'grey'}`}>{p}</span>
          ))}
        </div>
      }
    >
      {status && !configured && (
        <Banner kind="warn">
          <div>
            <strong>No AI provider is configured.</strong> Add a key in Settings → AI.
            Manus runs as an asynchronous agent (a request can take minutes); Anthropic and OpenAI answer
            immediately and are the only two that accept images, which the screenshot reply needs.
          </div>
        </Banner>
      )}

      <Tabs
        active={tab} onChange={setTab}
        tabs={[
          { id: 'reply', label: 'Customer reply' },
          { id: 'listing', label: 'Listing writer' },
          { id: 'image', label: 'Image studio' },
          { id: 'history', label: 'History' },
        ]}
      />

      {tab === 'reply' && <ReplyDesk status={status} />}
      {tab === 'listing' && <ListingWriter status={status} />}
      {tab === 'image' && <ImageStudio status={status} />}
      {tab === 'history' && <History />}
    </Page>
  );
}

// -------------------------------------------------------------- reply desk

function ReplyDesk({ status }) {
  const [message, setMessage] = useState('');
  const [orderId, setOrderId] = useState('');
  const [tone, setTone] = useState('');
  const [extra, setExtra] = useState('');
  const [promptId, setPromptId] = useState('');
  const [manualPrompt, setManualPrompt] = useState('');
  const [useManual, setUseManual] = useState(false);
  const [provider, setProvider] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState(null);
  const [saveName, setSaveName] = useState('');

  const { data: prompts, reload: reloadPrompts } = useAsync(() => api.get('/ai/prompts', { kind: 'reply' }), []);
  const toast = useToast();
  const showError = useErrorToast();

  const uploadShots = async (files) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('purpose', 'reply-screenshot');
    try {
      const r = await api.upload('/ai/attachments', fd);
      setAttachments((a) => [...a, ...r.attachments]);
      toast({ kind: 'ok', title: `${r.attachments.length} screenshot(s) attached` });
    } catch (err) { showError(err, 'Upload failed'); }
  };

  const generate = async () => {
    setBusy(true);
    setReply(null);
    try {
      const r = await api.post('/ai/reply', {
        message,
        attachmentIds: attachments.map((a) => a.id),
        promptId: useManual ? undefined : (promptId || undefined),
        promptOverride: useManual ? manualPrompt : undefined,
        provider: provider || undefined,
        tone,
        orderId: orderId || null,
        extraContext: extra,
      });
      setReply(r);
    } catch (err) { showError(err, 'Could not draft a reply'); } finally { setBusy(false); }
  };

  const savePrompt = async () => {
    if (!saveName.trim() || !manualPrompt.trim()) return;
    try {
      await api.post('/ai/prompts', { name: saveName, kind: 'reply', body: manualPrompt });
      toast({ kind: 'ok', title: 'Prompt saved to the library' });
      setSaveName('');
      reloadPrompts();
    } catch (err) { showError(err); }
  };

  const needsImages = attachments.length > 0;
  const imageCapable = status && ['anthropic', 'openai'].some((p) => status[p].configured);

  return (
    <div className="split">
      <div className="card">
        <div className="card-head"><h3>Buyer message</h3></div>

        <div className="field">
          <label>Paste the message</label>
          <textarea className="textarea" rows={6} value={message} onChange={(e) => setMessage(e.target.value)}
                    placeholder="Hi, I ordered two weeks ago and the tracking hasn't updated…" />
        </div>

        <div className="field">
          <label>…or attach a screenshot of it</label>
          <input className="input" type="file" accept="image/*" multiple onChange={(e) => uploadShots(e.target.files)} />
          <div className="hint">
            The model reads the message out of the image. Needs Anthropic or OpenAI — Manus is text-only here.
          </div>
          {attachments.length > 0 && (
            <div className="flex wrap mt8">
              {attachments.map((a) => (
                <div key={a.id} style={{ position: 'relative' }}>
                  <Thumb src={a.url} size="lg" />
                  <button className="btn xs danger" style={{ position: 'absolute', top: -6, right: -6, padding: '0 5px' }}
                          onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>×</button>
                </div>
              ))}
            </div>
          )}
          {needsImages && !imageCapable && (
            <Banner kind="warn">No image-capable provider configured. Add an Anthropic or OpenAI key.</Banner>
          )}
        </div>

        <div className="split">
          <div className="field">
            <label>Link an order (optional)</label>
            <input className="input" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="3456789012" />
            <div className="hint">Pulls the real items, status and tracking into the context.</div>
          </div>
          <div className="field">
            <label>Tone</label>
            <select className="select" value={tone} onChange={(e) => setTone(e.target.value)}>
              <option value="">Default</option>
              <option value="warm and apologetic">Warm, apologetic</option>
              <option value="brief and factual">Brief, factual</option>
              <option value="firm but polite">Firm but polite</option>
              <option value="enthusiastic and friendly">Enthusiastic</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Extra instructions (optional)</label>
          <input className="input" value={extra} onChange={(e) => setExtra(e.target.value)}
                 placeholder="Offer a reship, do not refund yet" />
        </div>

        <div className="section-title">Prompt</div>
        <label className="checkbox mb8">
          <input type="checkbox" checked={useManual} onChange={(e) => setUseManual(e.target.checked)} />
          <span>Write a one-off prompt instead of using a saved one</span>
        </label>

        {useManual ? (
          <>
            <textarea className="textarea mono" rows={6} value={manualPrompt} onChange={(e) => setManualPrompt(e.target.value)}
                      placeholder="You are…" />
            <div className="flex mt8">
              <input className="input sm" placeholder="Save this prompt as…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              <button className="btn sm" onClick={savePrompt} disabled={!saveName.trim() || !manualPrompt.trim()}>Save</button>
            </div>
          </>
        ) : (
          <select className="select" value={promptId} onChange={(e) => setPromptId(e.target.value)}>
            <option value="">Default reply prompt</option>
            {(prompts?.prompts ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (default)' : ''}</option>
            ))}
          </select>
        )}

        <div className="flex mt16">
          <select className="select sm" style={{ width: 150 }} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">Default provider</option>
            {['manus', 'anthropic', 'openai'].map((p) => (
              <option key={p} value={p} disabled={!status?.[p]?.configured}>{p}{status?.[p]?.configured ? '' : ' (no key)'}</option>
            ))}
          </select>
          <button className="btn primary" disabled={busy || (!message.trim() && !attachments.length)} onClick={generate}>
            {busy ? <Spinner /> : '✦'} Draft reply
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Draft</h3>
          <div className="spacer" />
          {reply && <CopyButton text={reply.text} label="Copy reply" className="btn sm primary" />}
        </div>

        {busy && (
          <div className="empty">
            <Spinner />
            <p className="mt8">
              {status?.[provider || status.active]?.async
                ? 'Manus runs as an agent — this can take a few minutes.'
                : 'Generating…'}
            </p>
          </div>
        )}

        {!busy && !reply && (
          <Empty icon="✦" title="Nothing drafted yet">
            Paste a message or attach a screenshot, then press Draft reply. Edit the result before sending — it is a draft, not an auto-send.
          </Empty>
        )}

        {reply && (
          <>
            <textarea className="textarea" rows={16} value={reply.text}
                      onChange={(e) => setReply({ ...reply, text: e.target.value })} />
            <div className="flex mt8 small dim">
              <span className="badge blue">{reply.provider}</span>
              {reply.model && <span className="badge grey">{reply.model}</span>}
              <span>{Math.round((reply.durationMs ?? 0) / 100) / 10}s</span>
              {reply.externalUrl && <a href={reply.externalUrl} target="_blank" rel="noreferrer">open in Manus ↗</a>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------- listing writer

function ListingWriter({ status }) {
  const [product, setProduct] = useState({ name: '', category: '', materials: '', dimensions: '', colours: '', audience: '', occasion: '', features: '', price: '', notes: '' });
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState({});
  const toast = useToast();
  const showError = useErrorToast();

  const set = (k, v) => setProduct((p) => ({ ...p, [k]: v }));

  const run = async (what) => {
    setBusy(what);
    try {
      const body = { product, provider: provider || undefined };
      if (what === 'title') {
        const out = await api.post('/ai/title', body);
        setResult((r) => ({ ...r, title: out }));
      } else if (what === 'description') {
        const out = await api.post('/ai/description', body);
        setResult((r) => ({ ...r, description: out }));
      } else if (what === 'tags') {
        const out = await api.post('/ai/tags', body);
        setResult((r) => ({ ...r, tags: out }));
      } else {
        const full = await api.post('/ai/listing', body);
        setResult((r) => ({ ...r, full }));
        if (full.parseError) toast({ kind: 'warn', title: 'Returned text, not JSON', body: full.parseError, duration: 9000 });
      }
    } catch (err) { showError(err, `${what} generation failed`); } finally { setBusy(null); }
  };

  return (
    <div className="split">
      <div className="card">
        <div className="card-head"><h3>Product details</h3></div>
        <div className="card-sub">Only what you type here is used. The model is told not to invent measurements or materials.</div>

        {[
          ['name', 'Product name', 'Hand-poured soy candle, amber jar'],
          ['category', 'Category', 'Home & Living > Candles'],
          ['materials', 'Materials', 'soy wax, cotton wick, amber glass'],
          ['dimensions', 'Dimensions / weight', '8cm x 9cm, 220g'],
          ['colours', 'Colours / variants', 'amber, clear, frosted'],
          ['audience', 'Who is it for', 'people who like slow evenings'],
          ['occasion', 'Occasion', 'housewarming, birthday'],
          ['features', 'Key features', '45 hour burn, unscented option'],
          ['price', 'Price', '24.00'],
        ].map(([key, label, placeholder]) => (
          <div className="field" key={key}>
            <label>{label}</label>
            <input className="input" value={product[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
          </div>
        ))}

        <div className="field">
          <label>Anything else</label>
          <textarea className="textarea" rows={4} value={product.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        <select className="select mb8" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">Default provider</option>
          {['manus', 'anthropic', 'openai'].map((p) => (
            <option key={p} value={p} disabled={!status?.[p]?.configured}>{p}</option>
          ))}
        </select>

        <div className="flex wrap">
          <button className="btn" disabled={!!busy || !product.name} onClick={() => run('title')}>{busy === 'title' ? <Spinner /> : ''} Titles</button>
          <button className="btn" disabled={!!busy || !product.name} onClick={() => run('description')}>{busy === 'description' ? <Spinner /> : ''} Description</button>
          <button className="btn" disabled={!!busy || !product.name} onClick={() => run('tags')}>{busy === 'tags' ? <Spinner /> : ''} 13 tags</button>
          <button className="btn primary" disabled={!!busy || !product.name} onClick={() => run('full')}>
            {busy === 'full' ? <Spinner /> : '✦'} Whole listing
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Output</h3></div>

        {!Object.keys(result).length && (
          <Empty icon="▤" title="Nothing generated yet">
            Fill in what you know on the left. Then send the result to the Create listing screen.
          </Empty>
        )}

        {result.title && (
          <>
            <div className="section-title">Title options</div>
            {result.title.options?.map((t, i) => (
              <div key={i} className="flex mb8">
                <div style={{ flex: 1 }} className="small">{t} <span className="muted">({t.length})</span></div>
                <CopyButton text={t} label="⧉" className="btn xs" />
              </div>
            ))}
          </>
        )}

        {result.tags && (
          <>
            <div className="section-title">
              Tags <CopyButton text={result.tags.tags?.join(', ')} label="Copy all" className="btn xs" />
            </div>
            <div className="pill-row">
              {result.tags.tags?.map((t) => <span key={t} className="tag">{t}</span>)}
            </div>
          </>
        )}

        {result.description && (
          <>
            <div className="section-title">
              Description <CopyButton text={result.description.text} label="Copy" className="btn xs" />
            </div>
            <div className="copy-block">{result.description.text}</div>
          </>
        )}

        {result.full && (
          <>
            <div className="section-title">
              Full listing draft
              <CopyButton text={JSON.stringify(result.full.listing ?? result.full.text, null, 2)} label="Copy JSON" className="btn xs" />
            </div>
            {result.full.parseError && <Banner kind="warn">{result.full.parseError}</Banner>}
            <div className="copy-block">
              {result.full.listing ? JSON.stringify(result.full.listing, null, 2) : result.full.text}
            </div>
            {result.full.listing && (
              <button
                className="btn primary mt8"
                onClick={() => {
                  sessionStorage.setItem('ai-listing-draft', JSON.stringify(result.full.listing));
                  window.location.href = '/listings/new';
                }}
              >
                Send to Create listing →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ image studio

function ImageStudio({ status }) {
  const [file, setFile] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const showError = useErrorToast();

  const run = async () => {
    setBusy(true);
    setOut(null);
    try {
      const fd = new FormData();
      if (file) fd.append('image', file);
      if (prompt) fd.append('prompt', prompt);
      fd.append('size', size);
      setOut(await api.upload('/ai/image', fd));
    } catch (err) { showError(err, 'Image generation failed'); } finally { setBusy(false); }
  };

  return (
    <div className="split">
      <div className="card">
        <div className="card-head"><h3>Edit or generate a product image</h3></div>
        {!status?.openai?.configured && (
          <Banner kind="warn">Image work needs an OpenAI key (Settings → AI). Manus and Anthropic do not expose image generation here.</Banner>
        )}
        <div className="field">
          <label>Source image (leave empty to generate from scratch)</label>
          <input className="input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="field">
          <label>Instruction</label>
          <textarea className="textarea" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Clean white background, even lighting, keep the product exactly as photographed" />
          <div className="hint">Leave blank to use the default "image" prompt from the library.</div>
        </div>
        <div className="field">
          <label>Size</label>
          <select className="select" value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="1024x1024">Square 1024</option>
            <option value="1536x1024">Landscape 1536×1024</option>
            <option value="1024x1536">Portrait 1024×1536</option>
          </select>
        </div>
        <button className="btn primary" disabled={busy || !status?.openai?.configured} onClick={run}>
          {busy ? <Spinner /> : '✦'} {file ? 'Edit image' : 'Generate image'}
        </button>
      </div>

      <div className="card">
        <div className="card-head"><h3>Result</h3></div>
        {busy && <div className="empty"><Spinner /></div>}
        {!busy && !out && <Empty icon="🖼" title="No image yet" />}
        {out?.attachment && (
          <>
            <img src={out.attachment.url} alt="result" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />
            <div className="flex mt8">
              <a className="btn sm" href={out.attachment.url} download>Download</a>
              <span className="small muted">{Math.round(out.attachment.bytes / 1024)} KB</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function History() {
  const { data, loading } = useAsync(() => api.get('/ai/runs', { limit: 60 }), []);
  if (loading) return <Spinner />;
  if (!data?.length) return <Empty icon="◷" title="No AI runs yet" />;

  return (
    <div className="card">
      <table className="data">
        <thead><tr><th>When</th><th>Kind</th><th>Provider</th><th>Status</th><th>Output</th><th /></tr></thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id}>
              <td className="small">{fmtAgo(r.created_at)}</td>
              <td><span className="badge grey">{r.kind}</span></td>
              <td className="small">{r.provider}</td>
              <td><span className={`badge ${r.status === 'completed' ? 'green' : 'red'}`}>{r.status}</span></td>
              <td className="cell-title small">{r.error ? <span style={{ color: 'var(--bad)' }}>{r.error}</span> : (r.output ?? '').slice(0, 110)}</td>
              <td>{r.output && <CopyButton text={r.output} label="⧉" className="btn xs" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
