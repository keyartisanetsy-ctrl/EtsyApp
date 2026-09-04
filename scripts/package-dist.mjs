/**
 * Builds a self-contained distributable zip: source, the built web app, and
 * production node_modules, so the target machine only needs Node installed.
 *
 *   npm run package
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import archiver from 'archiver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'release');
const stamp = new Date().toISOString().slice(0, 10);
const outFile = path.join(outDir, `etsy-command-center-v${pkg.version}-${stamp}.zip`);

const withDeps = !process.argv.includes('--source-only');

console.log('Building the web app…');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

await fs.mkdir(outDir, { recursive: true });

const archive = archiver('zip', { zlib: { level: 9 } });
const output = createWriteStream(outFile);
const done = new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
  archive.on('warning', (err) => { if (err.code !== 'ENOENT') throw err; });
});
archive.pipe(output);

// Source and build output. `data/` is deliberately excluded: it holds the
// local database, the encryption key and generated workbooks.
for (const dir of ['server', 'web/src', 'web/dist', 'scripts', 'docs']) {
  archive.directory(path.join(root, dir), dir);
}
for (const file of ['package.json', 'package-lock.json', 'README.md', '.env.example', '.gitignore',
                    'web/package.json', 'web/index.html', 'web/vite.config.js',
                    'START-WINDOWS.bat', 'START-MAC-LINUX.command']) {
  try { archive.file(path.join(root, file), { name: file }); } catch { /* optional */ }
}

if (withDeps) {
  console.log('Including node_modules (production tree)…');
  archive.directory(path.join(root, 'node_modules'), 'node_modules');
}

archive.append(
  `Etsy Command Center v${pkg.version}
Packaged ${new Date().toISOString()}

Easiest way to run it:
  Windows  -> double-click START-WINDOWS.bat
  Mac      -> double-click START-MAC-LINUX.command
  Linux    -> double-click (or run) START-MAC-LINUX.command

Or from a terminal:
  ${withDeps ? 'npm start' : 'npm install && npm run build && npm start'}

The app opens your browser automatically once it's ready, at
http://localhost:4317. Connect your shop under Settings — the redirect URI
shown there is what you paste into your Etsy app's dashboard.

Storage uses Node's built-in SQLite driver, so nothing needs to be compiled
on your machine. (better-sqlite3 is only an optional fallback dependency;
if it fails to install that's fine and can be ignored.)

Docs: README.md, docs/SETUP.md, docs/etsy-api-coverage.md
`,
  { name: 'READ-ME-FIRST.txt' },
);

console.log('Compressing…');
await archive.finalize();
await done;

const { size } = await fs.stat(outFile);
const mb = size / 1024 / 1024;
console.log(`\n${path.relative(root, outFile)}`);
console.log(`${mb.toFixed(1)} MB (${size.toLocaleString()} bytes)`);
if (withDeps && mb < 50) console.log('note: smaller than expected — check node_modules was included');
