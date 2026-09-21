import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Modal, Spinner, CopyButton, useErrorToast } from './ui.jsx';

/**
 * Etsy has no API to actually send a buyer a message, so this is the next
 * best thing: the saved template rendered with each order's own details,
 * one click from the clipboard. Used both as a plain "here's what to send"
 * notice (after a push to Airtable) and, with onConfirm supplied, as the
 * warning-plus-preview step before marking a parcel delivered by hand.
 */
export default function MessagePreviewModal({
  receiptIds = [], kind, title, onClose, onConfirm, confirmLabel = 'Continue', confirmBusy = false,
}) {
  const showError = useErrorToast();
  const [previews, setPreviews] = useState(null);

  useEffect(() => {
    let alive = true;
    setPreviews(null);
    Promise.all(receiptIds.map((id) =>
      api.get(`/orders/${id}/message-preview`, { kind }).catch((err) => ({ receiptId: id, error: err.message }))))
      .then((rows) => { if (alive) setPreviews(rows); })
      .catch((err) => { if (alive) showError(err, 'Could not build the message preview'); });
    return () => { alive = false; };
  }, [receiptIds.join(','), kind]);

  return (
    <Modal
      open lg onClose={onClose}
      title={title ?? `Message ready for ${receiptIds.length} order(s)`}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose}>{onConfirm ? 'Cancel' : 'Close'}</button>
          {onConfirm && (
            <button className="btn primary" onClick={onConfirm} disabled={confirmBusy}>
              {confirmBusy ? <Spinner /> : confirmLabel}
            </button>
          )}
        </>
      )}
    >
      {!previews ? <Spinner /> : (
        <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
          {previews.map((p) => (
            <div className="card" key={p.receiptId}>
              <div className="flex" style={{ justifyContent: 'space-between' }}>
                <strong>Order #{p.receiptId}</strong>
                {!p.error && <CopyButton text={p.text} label="Copy" className="btn xs primary" />}
              </div>
              {p.error
                ? <div className="small" style={{ color: 'var(--danger, #e05252)' }}>{p.error}</div>
                : <div className="copy-block mt8">{p.text}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
