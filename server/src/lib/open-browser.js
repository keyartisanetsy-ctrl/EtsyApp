/**
 * Open the app in the default browser, once the server is genuinely listening.
 *
 * The launcher scripts used to fire the browser before `npm install` had even
 * finished, so the first thing a user saw was ERR_CONNECTION_REFUSED and they
 * had to guess when to reload. Opening from the listen callback removes the
 * guesswork: by then the port is accepting connections.
 */
import { spawn } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('browser');

/** Per-platform openers, tried in order until one launches. */
function candidates(url) {
  if (process.platform === 'win32') {
    // The empty "" is start's window-title argument; without it a quoted URL
    // is treated as the title and nothing opens.
    return [['cmd', ['/c', 'start', '""', url]]];
  }
  if (process.platform === 'darwin') return [['open', [url]]];
  return [['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]], ['x-www-browser', [url]]];
}

export function openBrowser(url) {
  const list = candidates(url);

  const attempt = (index) => {
    if (index >= list.length) {
      log.warn(`could not open a browser automatically - open ${url} yourself`);
      return;
    }
    const [command, args] = list[index];
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      attempt(index + 1);
      return;
    }
    // A missing binary surfaces as an async 'error' event, not a throw. Without
    // this listener Node treats it as unhandled and takes the whole server down
    // moments after it reported being ready.
    child.on('error', () => attempt(index + 1));
    child.unref();
  };

  attempt(0);
  return true;
}

/** Honour an explicit opt-out; otherwise open when the launcher asked us to. */
export const shouldOpenBrowser = () =>
  !/^(0|false|no)$/i.test(String(process.env.OPEN_BROWSER ?? '')) && process.env.OPEN_BROWSER != null;
