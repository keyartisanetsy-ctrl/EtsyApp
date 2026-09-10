import React, { useState } from 'react';
import api from '../lib/api.js';
import Page from '../components/Page.jsx';
import { Spinner, Empty, Modal, Banner, useAsync, useToast, useErrorToast, Tabs, CopyButton } from '../components/ui.jsx';

const KIND_LABEL = {
  reply: 'Customer replies', title: 'Titles', description: 'Descriptions', tags: 'Tags',
  listing: 'Whole listings', image: 'Image editing', research: 'Research analysis', custom: 'Custom',
};

/** The saved-prompt library: defaults per kind, plus anything the shop adds. */
export default function Prompts() {
  const [kind, setKind] = useState('reply');
  const [editing, setEditing] = useState(null);
  const { data, loading, reload } = useAsync(() => api.get('/ai/prompts'), []);
  const toast = useToast();
  const showError = useErrorToast();

  const prompts = (data?.prompts ?? []).filter((p) => p.kind === kind);
  const kinds = data?.kinds ?? Object.keys(KIND_LABEL);

  const makeDefault = async (id) => {
    try { await api.post(`/ai/prompts/${id}/default`, {}); toast({ kind: 'ok', title: 'Default updated' }); reload(); }
    catch (err) { showError(err); }
  };

  const remove = async (p) => {
    if (!confirm(`Delete the prompt "${p.name}"?`)) return;
    try { await api.del(`/ai/prompts/${p.id}`); toast({ kind: 'ok', title: 'Deleted' }); reload(); }
    catch (err) { showError(err, 'Could not delete'); }
  };

  return (
    <Page
      title="Prompt library"
      subtitle="Defaults, saved prompts, and one-off overrides"
      actions={<button className="btn sm primary" onClick={() => setEditing({ kind, name: '', body: '' })}>＋ New prompt</button>}
    >
      <Banner kind="info">
        Each kind has one default, used whenever you do not pick something else. The AI screens can also take a
        manual prompt and save it back here.
      </Banner>

      <Tabs
        active={kind} onChange={setKind}
        tabs={kinds.map((k) => ({
          id: k, label: KIND_LABEL[k] ?? k,
          count: (data?.prompts ?? []).filter((p) => p.kind === k).length,
        }))}
      />

      {loading ? <Spinner /> : prompts.length === 0 ? (
        <Empty icon="❝" title={`No ${KIND_LABEL[kind] ?? kind} prompts`}
               action={<button className="btn primary" onClick={() => setEditing({ kind, name: '', body: '' })}>Create one</button>} />
      ) : (
        <div className="grid c2">
          {prompts.map((p) => (
            <div className="card" key={p.id}>
              <div className="card-head">
                <h3>{p.name}</h3>
                {p.is_default === 1 && <span className="badge green">default</span>}
                {p.is_system === 1 && <span className="badge grey">built-in</span>}
                <div className="spacer" />
                <span className="small muted">used {p.usage_count}×</span>
              </div>
              <div className="copy-block" style={{ maxHeight: 170 }}>{p.body}</div>
              <div className="flex mt8">
                <button className="btn xs" onClick={() => setEditing(p)}>Edit</button>
                {p.is_default !== 1 && <button className="btn xs" onClick={() => makeDefault(p.id)}>Make default</button>}
                <CopyButton text={p.body} label="Copy" className="btn xs" />
                <div className="spacer" />
                {p.is_system !== 1 && <button className="btn xs danger" onClick={() => remove(p)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      <PromptEditor prompt={editing} kinds={kinds} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </Page>
  );
}

function PromptEditor({ prompt, kinds, onClose, onSaved }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  React.useEffect(() => {
    setForm(prompt ? { name: prompt.name ?? '', kind: prompt.kind, body: prompt.body ?? '', isDefault: prompt.is_default === 1 } : {});
  }, [prompt]);

  if (!prompt) return null;

  const save = async () => {
    setBusy(true);
    try {
      if (prompt.id) await api.put(`/ai/prompts/${prompt.id}`, form);
      else await api.post('/ai/prompts', form);
      toast({ kind: 'ok', title: 'Prompt saved' });
      onSaved();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} lg title={prompt.id ? `Edit "${prompt.name}"` : 'New prompt'}
           footer={<><button className="btn primary" onClick={save} disabled={busy || !form.name || !form.body}>
                      {busy ? <Spinner /> : 'Save'}</button>
                     <label className="checkbox">
                       <input type="checkbox" checked={!!form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
                       <span>Make this the default for its kind</span>
                     </label></>}>
      <div className="field">
        <label>Name</label>
        <input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label>Kind</label>
        <select className="select" value={form.kind ?? 'reply'} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Prompt body</label>
        <textarea className="textarea mono" rows={16} value={form.body ?? ''} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <div className="hint">
          This becomes the system instruction. The buyer message or product details are supplied separately as input.
        </div>
      </div>
    </Modal>
  );
}
