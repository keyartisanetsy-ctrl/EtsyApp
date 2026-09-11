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
import { spawn, execSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

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

/** Launch a quick tunnel and resolve once its public URL is known. */
export function startQuickTunnel(exePath, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let found = false;

    const onData = (buf) => {
      if (found) return;
      const m = buf.toString('utf8').match(TRYCLOUDFLARE_RE);
      if (m) { found = true; clearTimeout(timer); resolve({ url: m[0], process: child }); }
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
 * The whole opt-in flow: make sure a password exists, get cloudflared, open
 * the tunnel, print the link. Never throws -- a failure here should not stop
 * the app from running locally, so callers get `null` on any problem along
 * with a printed reason.
 */
export async function startRemoteAccess({ root, port }) {
  try {
    const password = ensureAppPassword(path.join(root, '.env'));
    const exePath = await ensureCloudflared(path.join(root, '.tools'));
    if (!exePath) {
      console.log(`No public-link support for this platform (${process.platform}/${process.arch}) yet. Running locally only.`);
      return null;
    }
    console.log('\nStarting a temporary public link (Cloudflare Tunnel)...');
    const { url } = await startQuickTunnel(exePath, port);
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
    console.log(`\nCould not start the public link: ${err.message}`);
    console.log('The app still runs normally on this machine.\n');
    return null;
  }
}
