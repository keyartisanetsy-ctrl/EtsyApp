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
                    'web/package.json', 'web/index.html', 'web/vite.config.js']) {
  try { archive.file(path.join(root, file), { name: file }); } catch { /* optional */ }
}

if (withDeps) {
  console.log('Including node_modules (production tree)…');
  archive.directory(path.join(root, 'node_modules'), 'node_modules');
}

archive.append(
  `Etsy Command Center v${pkg.version}
Packaged ${new Date().toISOString()}

Run:
  ${withDeps ? 'npm start' : 'npm install && npm run build && npm start'}

Then open http://127.0.0.1:4317 and connect your shop under Settings.
${withDeps ? `
node_modules is bundled, but better-sqlite3 is a native module compiled for the
packaging machine. If the server fails to start with a MODULE_VERSION or
invalid ELF header error, run: npm rebuild better-sqlite3
` : ''}
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
