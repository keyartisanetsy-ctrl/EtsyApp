/**
 * Optional, opt-in: a temporary public link to this same running app via a
 * Cloudflare "quick" tunnel, so it can be opened from another computer, a
 * different VDS, or a phone, without exposing this machine's own port or
 * touching its firewall/router -- cloudflared only ever makes an outbound
 * connection.
 *
 * This does not change where Etsy calls come from. Every Etsy API request
 * this app makes still happens from THIS machine's own outbound connection,
 * wherever this process happens to be running -- a browser opening the
 * tunnel link from a different city, network or device never talks to Etsy
 * directly, so no other location's IP address is ever seen by Etsy. Only
 * wherever you double-click "start" decides that.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

// Cloudflare's quick-tunnel hostnames are always several dictionary words
// joined by hyphens (e.g. "warm-glass-cats-slowly.trycloudflare.com") -- a
// bare domain match here used to also catch api.trycloudflare.com, the
// internal endpoint cloudflared itself talks to while registering the
// tunnel, which some versions echo into their own log output on a retry or
// warning line. That string looks exactly like a real link but is not one --
// requiring the hyphenated multi-word shape rules it out structurally,
// backed up by an explicit blocklist of the short technical subdomains
// Cloudflare actually runs under this domain.
const TRYCLOUDFLARE_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;
const RESERVED_SUBDOMAINS = new Set(['api', 'www', 'update', 'updates', 'login', 'dash', 'support', 'status', 'blog', 'developers', 'community', 'help']);

function isRealTunnelUrl(url, hostname) {
  const name = hostname.toLowerCase();
  if (RESERVED_SUBDOMAINS.has(name)) return false;
  if (!name.includes('-')) return false; // real ones are always multiple words
  return true;
}

/** Every candidate *.trycloudflare.com URL in a chunk of output, filtered to the ones that could actually be the tunnel. */
export function findTunnelUrl(text) {
  for (const m of text.matchAll(TRYCLOUDFLARE_RE)) {
    if (isRealTunnelUrl(m[0], m[1])) return m[0];
  }
  return null;
}

function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', exe: 'cloudflared.exe', archive: null };
  }
  if (platform === 'darwin') {
    // Cloudflare ships one universal macOS binary under this name regardless
    // of Intel vs Apple Silicon.
    return { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz', exe: 'cloudflared', archive: 'tgz' };
  }
  if (platform === 'linux') {
    const file = arch === 'arm64' || arch === 'aarch64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
    return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/${file}`, exe: 'cloudflared', archive: null };
  }
  return null;
}

async function download(url, destFile) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  await pipeline(res.body, fs.createWriteStream(destFile));
}

/** Fetch cloudflared once and cache it under toolsDir; reused on every later start. */
export async function ensureCloudflared(toolsDir) {
  const asset = assetFor();
  if (!asset) return null;

  fs.mkdirSync(toolsDir, { recursive: true });
  const exePath = path.join(toolsDir, asset.exe);
  if (fs.existsSync(exePath)) return exePath;

  console.log('First time: downloading cloudflared for the public link (one-time, ~40MB)...');
  if (asset.archive === 'tgz') {
    const tgzPath = path.join(toolsDir, 'cloudflared.tgz');
    await download(asset.url, tgzPath);
    execSync(`tar -xzf "${tgzPath}" -C "${toolsDir}"`);
    fs.unlinkSync(tgzPath);
  } else {
    await download(asset.url, exePath);
  }
  if (!fs.existsSync(exePath)) throw new Error('cloudflared did not end up where expected after download');
  if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755);
  return exePath;
}

/**
 * Wait for something to actually be listening on 127.0.0.1:port before
 * pointing a tunnel at it. `npm start` used to hand off to cloudflared the
 * moment the server module finished loading, not once it was actually
 * accepting connections -- usually the same instant, but not guaranteed to
 * be, since `.listen()`'s own callback fires on a later tick than the
 * import that triggered it. A tunnel that starts proxying before the port
 * is bound gets a link that 502s for its first requests instead of one
 * that just works from the moment it is printed.
 */
export function waitForPort(port, { host = '127.0.0.1', timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const attempt = () => new Promise((resolve) => {
    const sock = net.connect({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
  });
  return (async () => {
    while (Date.now() < deadline) {
      if (await attempt()) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  })();
}

/** Launch a quick tunnel and resolve once its public URL is known. */
export function startQuickTunnel(exePath, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let found = false;

    const onData = (buf) => {
      if (found) return;
      const url = findTunnelUrl(buf.toString('utf8'));
      if (url) { found = true; clearTimeout(timer); resolve({ url, process: child }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { if (!found) reject(err); });
    child.on('exit', (code) => { if (!found) reject(new Error(`cloudflared exited (code ${code}) before printing a link`)); });

    const timer = setTimeout(() => {
      if (!found) { child.kill(); reject(new Error('cloudflared did not print a link within 25s')); }
    }, 25_000);

    // A tunnel spawned for one run has no reason to outlive it.
    const cleanup = () => { try { child.kill(); } catch { /* already gone */ } };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

/**
 * A freshly created quick tunnel can take a moment to actually route through
 * Cloudflare's edge, even after cloudflared has printed its URL -- checking
 * it here is the difference between "here is a link" and "here is a link
 * that works", which is the whole point of handing it to someone on another
 * machine. Any HTTP response at all (even the app's own 401 for no
 * password) counts as reachable; only a network-level failure does not.
 */
export async function isReachable(url, { attempts = 6, delayMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (res) return true;
    } catch { /* try again below */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/** An exposed app needs a password before anything is public. Generate one if none is set. */
export function ensureAppPassword(envPath) {
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const match = text.match(/^APP_PASSWORD=(.*)$/m);
  if (match && match[1].trim()) return match[1].trim();

  const generated = crypto.randomBytes(18).toString('base64url');
  text = match
    ? text.replace(/^APP_PASSWORD=.*$/m, `APP_PASSWORD=${generated}`)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}APP_PASSWORD=${generated}\n`;
  fs.writeFileSync(envPath, text);
  process.env.APP_PASSWORD = generated;
  return generated;
}

/**
 * One attempt: start a fresh cloudflared process, get a URL out of it, and
 * confirm the URL actually answers. Everything about a quick tunnel is
 * disposable -- a new process gets a brand new random hostname -- so a
 * tunnel that never becomes reachable is simply killed and retried rather
 * than handed to the user with fingers crossed.
 */
async function attemptTunnel(exePath, port) {
  const { url, process: child } = await startQuickTunnel(exePath, port);
  const ok = await isReachable(url);
  if (!ok) {
    try { child.kill(); } catch { /* already gone */ }
    throw new Error(`${url} never became reachable`);
  }
  return { url, process: child };
}

/**
 * The whole opt-in flow: make sure a password exists, get cloudflared, wait
 * for the app itself to be accepting connections, open the tunnel, confirm
 * it actually works, print the link. Never throws -- a failure here should
 * not stop the app from running locally, so callers get `null` on any
 * problem along with a printed reason.
 */
export async function startRemoteAccess({ root, port }) {
  try {
    const password = ensureAppPassword(path.join(root, '.env'));
    const exePath = await ensureCloudflared(path.join(root, '.tools'));
    if (!exePath) {
      console.log(`No public-link support for this platform (${process.platform}/${process.arch}) yet. Running locally only.`);
      return null;
    }

    const up = await waitForPort(port);
    if (!up) {
      console.log(`\nCould not start the public link: nothing answered on 127.0.0.1:${port} within 15s.`);
      console.log('The app still runs normally on this machine.\n');
      return null;
    }

    console.log('\nStarting a temporary public link (Cloudflare Tunnel)...');
    let last = null;
    const MAX_ATTEMPTS = 3;
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      try {
        const { url } = await attemptTunnel(exePath, port);
        const width = Math.min(78, url.length + 22);
        const rule = '='.repeat(width);
        console.log(`\n${rule}`);
        console.log(`  Open from anywhere:  ${url}`);
        console.log(`  Password:            ${password}`);
        console.log(rule);
        console.log('  This address changes every time the app restarts -- check this window if it stops working.');
        console.log('  Anyone with this link and password can open the app. Do not share one without the other.\n');
        return { url, password };
      } catch (err) {
        last = err;
        if (i < MAX_ATTEMPTS) console.log(`  Attempt ${i} of ${MAX_ATTEMPTS} did not work (${err.message}), trying a fresh tunnel...`);
      }
    }
    throw last ?? new Error('could not open a working tunnel');
  } catch (err) {
    console.log(`\nCould not start the public link: ${err.message}`);
    console.log('The app still runs normally on this machine.\n');
    return null;
  }
}
