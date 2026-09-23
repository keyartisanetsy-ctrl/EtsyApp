/**
 * Whether a Dashboard sync ("Sync everything" / Orders / Tracking) is
 * currently running, kept outside React state.
 *
 * The fetch behind a sync keeps running on the network no matter which
 * component is mounted - only the on-screen spinner was ever tied to the
 * Dashboard's own local state, so navigating away and back mid-sync used to
 * make it look like nothing was happening (and let a second click start a
 * duplicate sync). Module-scope state survives that unmount/remount, and
 * useSyncExternalStore (in Dashboard.jsx) reads the current value the
 * instant a fresh Dashboard mounts, so the button picks up exactly where it
 * left off.
 */
let active = null; // { kind: 'all' | 'orders' | 'tracking' } | null
const listeners = new Set();

const notify = () => { for (const l of listeners) l(); };

export function beginSync(kind) {
  active = { kind };
  notify();
}

export function endSync() {
  active = null;
  notify();
}

export function getActiveSync() {
  return active;
}

export function subscribeSync(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
