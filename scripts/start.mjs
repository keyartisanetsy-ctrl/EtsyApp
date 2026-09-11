/**
 * Start the app, repairing the obvious things first so that "npm start"
 * works from a fresh clone instead of failing silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`\nNode.js ${process.versions.node} is too old — this needs 20 or newer.`);
  console.error('Install the LTS build from https://nodejs.org and try again.\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.log('First run: downloading what the app needs.');
  console.log('This takes a minute or two. Please wait - it is not frozen.\n');
  run('npm install');
}

if (!fs.existsSync(path.join(root, 'server/src/etsy/operations.generated.js'))) {
  console.log('Generating the Etsy client...');
  run('npm run codegen');
}

if (!fs.existsSync(path.join(root, 'web/dist/index.html'))) {
  console.log('\nBuilding the interface (first run only)...\n');
  run('npm run build');
}

// .env is normally only read once the server module loads (server/src/config.js),
// which is too late to know here whether a public link was asked for.
const dotenv = await import('dotenv');
dotenv.default.config({ path: path.join(root, '.env') });

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
// The server opens the browser from its listen callback, once the port is
// really accepting connections. Opt out with OPEN_BROWSER=0.
process.env.OPEN_BROWSER = process.env.OPEN_BROWSER ?? '1';

console.log('Starting the server...');
await import('../server/src/index.js');

// Started after the server import resolves, so the tunnel has something to
// proxy to almost immediately -- opt in with REMOTE_ACCESS=1 in .env.
// Pinggy is the default (no binary to fetch, and it renews its own address
// automatically for as long as this process runs instead of needing a
// re-run every time its free-tier hour is up); TUNNEL_PROVIDER=cloudflare
// switches to the Cloudflare Tunnel path in remote-access.mjs instead.
if (/^(1|true|yes|on)$/i.test(process.env.REMOTE_ACCESS || '')) {
  const provider = (process.env.TUNNEL_PROVIDER || 'pinggy').trim().toLowerCase();
  const mod = provider === 'cloudflare' ? './remote-access.mjs' : './pinggy-tunnel.mjs';
  const { startRemoteAccess } = await import(mod);
  await startRemoteAccess({ root, port: Number(process.env.PORT) || 4317 });
}
