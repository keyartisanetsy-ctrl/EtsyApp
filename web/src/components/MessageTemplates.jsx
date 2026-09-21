import React, { useState } from 'react';
import api from '../lib/api.js';
import { Modal, Spinner, Empty, useAsync, useToast, useErrorToast, CopyButton } from './ui.jsx';

const KIND_LABEL = { airtable_pushed: 'After sending to Airtable', delivered: 'Once delivered' };
const PLACEHOLDERS = '{buyerName} {orderNumber} {shopName} {trackingCode} {carrier}';

/**
 * The canned-message library: one saved text per moment (order sent to
 * Airtable, parcel delivered), placeholders filled in per order when it is
 * actually used. Etsy's API cannot send these itself - this only keeps the
 * wording ready to copy - so there is nothing here to configure beyond the
 * words themselves.
 */
export default function MessageTemplatesModal({ onClose }) {
  const [kind, setKind] = useState('airtable_pushed');
  const [editing, setEditing] = useState(null);
  const { data, loading, reload } = useAsync(() => api.get('/orders/message-templates'), []);
  const toast = useToast();
  const showError = useErrorToast();

  const templates = (data ?? []).filter((t) => t.kind === kind);

  const makeDefault = async (id) => {
    try { await api.post(`/orders/message-templates/${id}/default`, {}); toast({ kind: 'ok', title: 'Default updated' }); reload(); }
    catch (err) { showError(err); }
  };

  const remove = async (t) => {
    if (!confirm(`Delete "${t.name}"?`)) return;
    try { await api.del(`/orders/message-templates/${t.id}`); toast({ kind: 'ok', title: 'Deleted' }); reload(); }
    catch (err) { showError(err, 'Could not delete'); }
  };

  if (editing) {
    return (
      <TemplateEditor
        template={editing} kind={kind}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); }}
      />
    );
  }

  return (
    <Modal
      open lg onClose={onClose}
      title="Message templates"
      footer={<button className="btn primary" onClick={() => setEditing({ kind, name: '', body: '' })}>＋ New template</button>}
    >
      <div className="tabs mb16">
        {Object.entries(KIND_LABEL).map(([k, label]) => (
          <button key={k} className={`tab ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>

      {loading ? <Spinner /> : templates.length === 0 ? (
        <Empty icon="✉" title={`No "${KIND_LABEL[kind]}" template yet`}
               action={<button className="btn primary" onClick={() => setEditing({ kind, name: '', body: '' })}>Create one</button>} />
      ) : (
        <div className="flex" style={{ flexDirection: 'column', gap: 10 }}>
          {templates.map((t) => (
            <div className="card" key={t.id}>
              <div className="card-head">
                <h3>{t.name}</h3>
                {t.isDefault && <span className="badge green">default</span>}
                <div className="spacer" />
              </div>
              <div className="copy-block">{t.body}</div>
              <div className="flex mt8">
                <button className="btn xs" onClick={() => setEditing(t)}>Edit</button>
                {!t.isDefault && <button className="btn xs" onClick={() => makeDefault(t.id)}>Make default</button>}
                <CopyButton text={t.body} label="Copy" className="btn xs" />
                <div className="spacer" />
                <button className="btn xs danger" onClick={() => remove(t)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function TemplateEditor({ template, kind, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: template.name ?? '', kind: template.kind ?? kind, body: template.body ?? '', isDefault: !!template.isDefault,
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const save = async () => {
    setBusy(true);
    try {
      if (template.id) await api.put(`/orders/message-templates/${template.id}`, form);
      else await api.post('/orders/message-templates', form);
      toast({ kind: 'ok', title: 'Template saved' });
      onSaved();
    } catch (err) { showError(err, 'Could not save'); } finally { setBusy(false); }
  };

  return (
    <Modal
      open lg onClose={onClose}
      title={template.id ? `Edit "${template.name}"` : 'New template'}
      footer={(
        <>
          <label className="checkbox">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
            <span>Make this the default for "{KIND_LABEL[form.kind]}"</span>
          </label>
          <div className="spacer" />
          <button className="btn primary" onClick={save} disabled={busy || !form.name.trim() || !form.body.trim()}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label>When</label>
        <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          {Object.entries(KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Message</label>
        <textarea className="textarea" rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <div className="hint">Placeholders, filled in per order: <code>{PLACEHOLDERS}</code></div>
      </div>
    </Modal>
  );
}
