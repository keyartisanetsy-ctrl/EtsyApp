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
  console.log('First run: installing dependencies (a few minutes)...\n');
  run('npm install');
}

if (!fs.existsSync(path.join(root, 'server/src/etsy/operations.generated.js'))) {
  console.log('Generating the Etsy client...');
  run('npm run codegen');
}

if (!fs.existsSync(path.join(root, 'web/dist/index.html'))) {
  console.log('Building the web interface (first run only)...\n');
  run('npm run build');
}

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
await import('../server/src/index.js');
