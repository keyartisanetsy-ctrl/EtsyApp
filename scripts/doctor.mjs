/**
 * Pre-flight check. Explains, in plain terms, why the app will not start —
 * rather than letting the browser show ERR_CONNECTION_REFUSED with no clue.
 *
 *   npm run doctor
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m, fix) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); problems.push({ m, fix }); };
const warn = (m) => { console.log(`  \x1b[33mnote\x1b[0m  ${m}`); notes.push(m); };

console.log('\nEtsy Command Center - checking your setup\n');

// 1. Node version -----------------------------------------------------------
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} is too old (need 22.5 or newer)`,
         'Install the current build from https://nodejs.org then run this again.');

// 2. Dependencies -----------------------------------------------------------
if (!fs.existsSync(path.join(root, 'node_modules'))) {
  bad('Dependencies are not installed', 'Run:  npm install');
} else {
  ok('Dependencies installed');

  // SQLite comes from Node itself; better-sqlite3 is only a fallback.
  try {
    const { openDatabase, driverKind } = await import('../server/src/db/driver.js');
    const probe = await openDatabase(':memory:');
    probe.exec('SELECT 1');
    ok(`SQLite driver works (${driverKind()})`);
  } catch (err) {
    bad(`No SQLite driver: ${err.message.split('\n')[0]}`,
        'Install Node.js 22.5 or newer from https://nodejs.org');
  }
}

// 3. Generated API client ---------------------------------------------------
if (fs.existsSync(path.join(root, 'server/src/etsy/operations.generated.js'))) ok('Etsy client generated');
else bad('Etsy client is missing', 'Run:  npm run codegen');

// 4. Web build --------------------------------------------------------------
if (fs.existsSync(path.join(root, 'web/dist/index.html'))) ok('Web interface built');
else bad('Web interface is not built (the browser would get an API-only page)', 'Run:  npm run build');

// 5. Port availability ------------------------------------------------------
const port = Number(process.env.PORT) || 4317;
const host = process.env.HOST || '127.0.0.1';
const portFree = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', (e) => resolve(e.code !== 'EADDRINUSE'));
  srv.once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port, host);
});
if (portFree) ok(`Port ${port} is free`);
else warn(`Port ${port} is already in use — the app may already be running at http://${host}:${port}, `
        + `or another program has the port. Start on a different one with:  PORT=4400 npm start`);

// 6. Writable data directory ------------------------------------------------
try {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', '.probe'), 'x');
  fs.unlinkSync(path.join(root, 'data', '.probe'));
  ok('Data folder is writable');
} catch (err) {
  bad(`Cannot write to the data folder: ${err.message}`, 'Check the folder permissions, or move the project somewhere you own.');
}

// ---------------------------------------------------------------------------
console.log('');
if (!problems.length) {
  console.log('\x1b[32mEverything checks out.\x1b[0m');
  console.log(`Start the app with:  npm start      then open  http://${host}:${port}\n`);
  process.exit(0);
}

console.log(`\x1b[31m${problems.length} thing(s) to fix:\x1b[0m\n`);
for (const p of problems) console.log(`  - ${p.m}\n    ${p.fix}\n`);
console.log('Or just run:  npm run fix\n');
process.exit(1);
