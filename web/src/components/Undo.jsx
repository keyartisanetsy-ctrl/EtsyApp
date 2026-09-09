import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Modal, Spinner, Empty, useToast, useErrorToast, fmtAgo } from './ui.jsx';

/**
 * Ctrl+Z, and a history of what it would take back.
 *
 * Sits at the top level so the shortcut works on every screen. It deliberately
 * does not fire while you are typing in a field - inside an input, Ctrl+Z means
 * "undo my typing", and stealing that would be maddening.
 *
 * Changes that went to Etsy or Airtable appear in the list but cannot be taken
 * back from here, and say so, because they are not ours to reverse.
 */
export default function UndoHost() {
  const [next, setNext] = useState(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const showError = useErrorToast();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/undo');
      setHistory(r.history ?? []);
      setNext(r.next ?? null);
    } catch { /* the app still works without a history */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Cheap enough to re-read now and then so the button label stays honest.
  useEffect(() => {
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const doUndo = useCallback(async (id = null) => {
    setBusy(true);
    try {
      const r = await api.post('/undo', { id });
      toast({ kind: 'ok', title: 'Undone', body: r.message });
      refresh();
      // Screens read their own data, so tell them all to look again.
      window.dispatchEvent(new CustomEvent('etsyapp:undone', { detail: r }));
    } catch (err) { showError(err, 'Could not undo that'); }
    finally { setBusy(false); }
  }, [toast, showError, refresh]);

  useEffect(() => {
    const onKey = (e) => {
      const key = String(e.key).toLowerCase();
      if (key !== 'z' || !(e.ctrlKey || e.metaKey)) return;

      // Inside a text field, Ctrl+Z belongs to the field.
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;

      e.preventDefault();
      if (e.shiftKey) { setOpen(true); return; }   // Ctrl+Shift+Z opens the list
      if (next) doUndo(null);
      else toast({ kind: 'info', title: 'Nothing to undo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, doUndo, toast]);

  return (
    <>
      <button
        className="undo-chip"
        onClick={() => setOpen(true)}
        title={next
          ? `Ctrl+Z takes back: ${next.label}. Ctrl+Shift+Z opens the list.`
          : 'Nothing to undo yet. Ctrl+Shift+Z opens the list.'}
      >
        <span className="ico">↶</span>
        <span className="undo-label">{next ? next.label : 'Nothing to undo'}</span>
        {next && <kbd>Ctrl Z</kbd>}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} lg title="What you changed">
        <p className="dim small">
          The most recent change is at the top. Ctrl+Z takes back the newest one that can be taken back.
          Anything already sent to Etsy or Airtable is listed for the record, but has to be changed there.
        </p>
        {!history.length ? <Empty icon="↶" title="Nothing yet" /> : (
          <table className="data">
            <thead><tr><th>What</th><th>When</th><th className="right">Rows</th><th /></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className={h.undone ? 'dim' : ''}>
                  <td>
                    <div>{h.label}</div>
                    {h.note && <div className="small dim">{h.note}</div>}
                  </td>
                  <td className="small dim">{fmtAgo(h.at)}</td>
                  <td className="num small">{h.affected ?? '—'}</td>
                  <td>
                    {h.undone
                      ? <span className="badge grey">undone</span>
                      : h.canUndo
                        ? <button className="btn xs" disabled={busy} onClick={() => doUndo(h.id)}>
                            {busy ? <Spinner /> : 'Take back'}
                          </button>
                        : <span className="badge amber" title={h.note || 'This went to another service.'}>elsewhere</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </>
  );
}
