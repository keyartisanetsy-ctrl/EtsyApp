import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ------------------------------------------------------------------ toasts

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    const entry = typeof toast === 'string' ? { title: toast } : toast;
    setToasts((t) => [...t, { id, kind: 'ok', ...entry }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), entry.duration ?? 5200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Turn any thrown error into a toast that keeps Etsy's own message. */
export function useErrorToast() {
  const toast = useToast();
  return useCallback((err, title = 'Something went wrong') => {
    const details = Array.isArray(err?.details) ? err.details.join(' | ')
      : err?.details ? JSON.stringify(err.details) : null;
    const etsy = err?.etsy ? (typeof err.etsy === 'string' ? err.etsy : JSON.stringify(err.etsy)) : null;
    toast({ kind: 'err', title, body: [err?.message, details, etsy].filter(Boolean).join(' — '), duration: 9000 });
  }, [toast]);
}

// -------------------------------------------------------------- primitives

export const Spinner = () => <span className="spinner" />;

export function Banner({ kind = 'info', children, onClose }) {
  if (!children) return null;
  return (
    <div className={`banner ${kind}`}>
      <div style={{ flex: 1 }}>{children}</div>
      {onClose && <button className="close" onClick={onClose} aria-label="Dismiss">×</button>}
    </div>
  );
}

export function Empty({ icon = '∅', title, children, action }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="mt16">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, note, kind = '', onClick }) {
  return (
    <div className={`stat ${kind} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className={`drawer ${wide ? 'wide' : ''}`}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </>
  );
}

export function Modal({ open, onClose, title, children, footer, lg }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${lg ? 'lg' : ''}`}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Copy to clipboard with inline confirmation. */
export function CopyButton({ text, label = 'Copy', className = 'btn sm' }) {
  const [done, setDone] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '');
    } catch {
      // Clipboard API needs a secure context; fall back to a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = text ?? '';
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    setDone(true);
    timer.current = setTimeout(() => setDone(false), 1600);
  };

  return (
    <button className={className} onClick={copy} disabled={!text}>
      {done ? '✓ Copied' : label}
    </button>
  );
}

export function Pager({ total, limit, offset, onChange }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total === 0) return null;
  return (
    <div className="pager">
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}
      </span>
      <div className="spacer" />
      <button className="btn xs" disabled={offset === 0} onClick={() => onChange(0)}>First</button>
      <button className="btn xs" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Prev</button>
      <span>Page {page} / {pages}</span>
      <button className="btn xs" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</button>
    </div>
  );
}

/** Header cell that toggles asc/desc on the active column. */
export function SortTh({ label, field, sort, dir, onSort, className = '' }) {
  const active = sort === field;
  return (
    <th className={`sortable ${className}`} onClick={() => onSort(field, active && dir === 'asc' ? 'desc' : 'asc')}>
      {label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

export function Checkbox({ checked, onChange, label, indeterminate }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <label className="checkbox" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

/**
 * A locale-independent stand-in for <input type="number" step="0.01">.
 * Chrome and Firefox pick the accepted decimal separator for a native number
 * input from the browser's own locale -- under a Turkish (or any
 * comma-decimal) locale, the "." key is silently rejected, so a price like
 * 199.99 can never be typed. This takes either "." or "," as the separator,
 * always reports a plain "199.99"-style string upward (or "" once cleared,
 * which a native number input can also refuse to settle on), and the typed
 * text itself never gets rewritten mid-keystroke.
 */
export function DecimalInput({ value, onChange, className = 'input', placeholder, ...rest }) {
  const [local, setLocal] = useState(value == null ? '' : String(value));
  useEffect(() => { setLocal(value == null ? '' : String(value)); }, [value]);

  const onType = (raw) => {
    let cleaned = raw.replace(/[^0-9.,]/g, '');
    const firstSep = cleaned.search(/[.,]/);
    if (firstSep !== -1) {
      cleaned = cleaned.slice(0, firstSep + 1) + cleaned.slice(firstSep + 1).replace(/[.,]/g, '');
    }
    setLocal(cleaned);
    onChange(cleaned === '' ? '' : cleaned.replace(',', '.'));
  };

  return (
    <input
      {...rest}
      className={className}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      placeholder={placeholder}
      value={local}
      onChange={(e) => onType(e.target.value)}
    />
  );
}

export function Thumb({ src, alt, size = '', fallback = '□' }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div className={`thumb ${size} placeholder`}>{fallback}</div>;
  return <img className={`thumb ${size}`} src={src} alt={alt ?? ''} loading="lazy" onError={() => setBroken(true)} />;
}

export const Tabs = ({ tabs, active, onChange }) => (
  <div className="tabs">
    {tabs.map((t) => (
      <button key={t.id} className={`tab ${active === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
        {t.label}{t.count != null && <span className="dim"> ({t.count})</span>}
      </button>
    ))}
  </div>
);

/** Debounced value, so typing in a filter does not hammer the API. */
export function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Data loader with manual refresh and in-flight/error state. */
export function useAsync(fn, deps = [], { immediate = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fnRef.current());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (immediate) reload(); /* eslint-disable-next-line */ }, deps);

  // An undo rewrites rows underneath whatever is on screen, so every screen
  // that reads data has to look again. Listening here rather than in each page
  // means a new page gets this for free and can never forget it.
  useEffect(() => {
    if (!immediate) return undefined;
    const onUndone = () => reload();
    window.addEventListener('etsyapp:undone', onUndone);
    return () => window.removeEventListener('etsyapp:undone', onUndone);
  }, [immediate, reload]);

  return { data, loading, error, reload, setData };
}

// ------------------------------------------------------------------ format

export const fmtMoney = (value, currency) =>
  value == null ? '—' : `${currency ? `${currency} ` : ''}${Number(value).toFixed(2)}`;

export const fmtDate = (ts) => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts.endsWith?.('Z') ? ts : `${ts}Z`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const fmtDateTime = (ts) => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts.endsWith?.('Z') ? ts : `${ts}Z`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const fmtAgo = (ts) => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts.endsWith?.('Z') ? ts : `${ts}Z`);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
};

export const STATE_BADGE = {
  active: 'green', inactive: 'grey', draft: 'blue', expired: 'amber', sold_out: 'violet',
};

export const TRACK_BADGE = {
  delivered: 'green', in_transit: 'blue', out_for_delivery: 'blue', pre_shipped: 'grey',
  pickup_waiting: 'amber', exception: 'red', returned: 'red', not_found: 'amber', expired: 'amber',
};
