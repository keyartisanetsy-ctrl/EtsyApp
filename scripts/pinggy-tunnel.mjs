/**
 * A public link via Pinggy instead of Cloudflare -- no binary to download,
 * no account, not even an API key: Pinggy's free tier is a plain outbound
 * SSH connection, and it hands back a random https://*.pinggy.link address
 * the moment that connection is up.
 *
 * The one thing that makes this different from the Cloudflare path in
 * remote-access.mjs: Pinggy's free tier closes that SSH connection on its
 * own after about an hour, on purpose. Rather than making that someone's
 * problem to notice and fix by re-running a script, this reconnects on its
 * own -- every time the connection ends, for any reason, a fresh one opens
 * automatically and its (new) address is printed here again -- for as long
 * as this app keeps running. Opened once, renews itself from then on.
 *
 * Same privacy note as the Cloudflare path: this never changes where Etsy
 * calls come from. Every Etsy API request still leaves from THIS machine's
 * own connection; opening the tunnel link from another device only reaches
 * this app, never Etsy directly.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureAppPassword, waitForPort, isReachable } from './remote-access.mjs';

// Pinggy's own subdomain shape has changed more than once (plain
// *.free.pinggy.link, region-prefixed *.a.free.pinggy.link...) -- matching
// broadly on the domain itself rather than a specific subdomain pattern
// means this keeps working across that, and "https" is required so an
// insecure http:// line Pinggy also prints is never the one picked up.
const PINGGY_URL_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.pinggy\.(?:link|io)\b/i;

/** The first matching link in a chunk of ssh's own output, or null. */
export function findPinggyUrl(text) {
  const m = String(text ?? '').match(PINGGY_URL_RE);
  return m ? m[0] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One SSH connection attempt. Resolves with either { url, child } once
 * Pinggy has printed an address, or { error } if the process could not
 * even start, was rejected, or exited before printing one.
 */
function connectOnce(port) {
  return new Promise((resolve) => {
    const args = [
      '-p', '443',
      '-R', `0:localhost:${port}`,
      // Non-interactive on purpose: without this, the very first connection
      // to a host this machine has never seen would sit forever on a
      // yes/no host-key prompt nothing is reading stdin to answer.
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      'free.pinggy.io',
    ];
    let child;
    try {
      child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ error: err });
      return;
    }

    // Captured at spawn time, not after the caller gets the URL back --
    // the reachability check that runs in between can take longer than a
    // short-lived connection does, and 'exit' only ever fires once. A
    // listener attached after it already fired would wait forever.
    const exited = new Promise((res) => child.once('exit', res));

    let settled = false;
    const onData = (buf) => {
      if (settled) return;
      const url = findPinggyUrl(buf.toString('utf8'));
      if (url) { settled = true; resolve({ url, child, exited }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { if (!settled) { settled = true; resolve({ error: err }); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; resolve({ error: new Error(`ssh exited (code ${code}) before printing a link`) }); }
    });
  });
}

function printBanner(url, password) {
  const width = Math.min(78, url.length + 22);
  const rule = '='.repeat(width);
  console.log(`\n${rule}`);
  console.log(`  Open from anywhere:  ${url}`);
  console.log(`  Password:            ${password}`);
  console.log(rule);
  console.log('  This renews itself automatically (Pinggy\'s free tier closes the connection');
  console.log('  after about an hour) -- watch this window for the next address when it does.');
  console.log('  Anyone with this link and password can open the app. Do not share one without the other.\n');
}

/**
 * Runs until `stop()` is called or the process exits. Every reconnect --
 * the first one and every renewal after it -- reprints the banner with
 * whatever address Pinggy handed back that time.
 */
export function runForever(port, password) {
  let stopped = false;
  let child = null;
  let sawEnoent = false;

  const loop = async (onFirst) => {
    while (!stopped) {
      const result = await connectOnce(port);
      if (result.error) {
        if (result.error.code === 'ENOENT') {
          sawEnoent = true;
          console.log('\nCould not start the public link: no "ssh" command found on this machine.');
          console.log('Pinggy needs an SSH client -- Windows 10/11 include one (OpenSSH Client, on by');
          console.log('default since 2018), or install Git for Windows, which bundles its own.');
          console.log('The app still runs normally on this machine.\n');
          onFirst?.(null);
          return;
        }
        console.log(`[Pinggy] could not connect (${result.error.message}). Retrying in 5s...`);
        await sleep(5000);
        continue;
      }

      child = result.child;
      const ok = await isReachable(result.url);
      if (!ok) console.log(`[Pinggy] warning: ${result.url} did not answer yet -- it may still need a moment.`);
      printBanner(result.url, password);
      onFirst?.(result.url);
      onFirst = null;

      // Runs until this connection ends -- the ~60 minute free-tier cutoff,
      // a network blip, anything -- then loops straight back to reconnect.
      await result.exited;
      if (!stopped) console.log('\n[Pinggy] the tunnel closed -- reconnecting automatically...');
    }
  };

  const firstUrl = new Promise((resolve) => { loop(resolve); });

  const stop = () => { stopped = true; try { child?.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return { firstUrl, stop, sawEnoent: () => sawEnoent };
}

/**
 * The whole opt-in flow, matching remote-access.mjs's Cloudflare one:
 * make sure a password exists, wait for the app itself to be accepting
 * connections, open the tunnel, and keep it renewing itself for as long as
 * this process runs. Resolves once the first connection is up (or once it
 * is clear one cannot be); never throws -- a failure here should not stop
 * the app from running locally.
 */
export async function startRemoteAccess({ root, port }) {
  try {
    const password = ensureAppPassword(path.join(root, '.env'));

    const up = await waitForPort(port);
    if (!up) {
      console.log(`\nCould not start the public link: nothing answered on 127.0.0.1:${port} within 15s.`);
      console.log('The app still runs normally on this machine.\n');
      return null;
    }

    console.log('\nStarting a temporary public link (Pinggy), auto-renewing for as long as this stays open...');
    const { firstUrl } = runForever(port, password);
    const url = await firstUrl;
    return url ? { url, password } : null;
  } catch (err) {
    console.log(`\nCould not start the public link: ${err.message}`);
    console.log('The app still runs normally on this machine.\n');
    return null;
  }
}
