/**
 * Live status of the optional public tunnel (Pinggy or Cloudflare), so the
 * app's own UI can show the current link and password -- previously the
 * only place either ever appeared was the terminal window that started
 * this process, which is easy to lose track of once the app has been
 * running a while (and impossible to see at all from another computer).
 *
 * In-memory only, on purpose: it describes this one running process, not
 * something to persist across restarts -- a fresh process gets a fresh
 * tunnel and a fresh status the moment it reconnects.
 */
let state = {
  enabled: false,
  provider: null,
  url: null,
  password: null,
  connecting: false,
  updatedAt: null,
};

export function setRemoteAccessStatus(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
}

export function getRemoteAccessStatus() {
  return state;
}
