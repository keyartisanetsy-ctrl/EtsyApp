/**
 * Optional, opt-in: the app checks its own source branch on GitHub and pulls
 * in a newer commit on its own, instead of someone having to re-run the VDS
 * setup script (or redownload a zip) by hand every time a fix ships.
 *
 * Off by default -- set AUTO_UPDATE=1 in .env to turn it on. Nothing here
 * runs unless the scheduler is told to call it.
 *
 * How "newer" is known without a git checkout: the zip this app is
 * distributed as (same one setup-vds.ps1 downloads) is a snapshot of the
 * branch, not a git clone, so there is no local history to compare against.
 * Instead, the commit sha this copy was installed from is written to
 * data/.installed-commit right after a successful update (or left absent
 * on a copy that was never auto-updated, e.g. one just unzipped by hand);
 * GitHub's own commits API says what the newest sha on the branch is right
 * now, and the two are compared.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const REPO = 'keyartisanetsy-ctrl/EtsyApp';
const BRANCH = 'claude/etsy-bulk-management-app-q3enu5';
const API_URL = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
const ZIP_URL = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`;

const markerPath = (root) => path.join(root, 'data', '.installed-commit');

/** The commit sha this copy last updated itself to, or null if never. */
export function installedCommit(root) {
  try { return fs.readFileSync(markerPath(root), 'utf8').trim() || null; } catch { return null; }
}

/** GitHub's current head sha for the branch this app ships from. */
async function latestCommit() {
  const res = await fetch(API_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EtsyCommandCenter' } });
  if (!res.ok) throw new Error(`GitHub commits API returned ${res.status}`);
  const body = await res.json();
  if (!body?.sha) throw new Error('GitHub commits API response had no sha');
  return body.sha;
}

/** Is a newer commit available? Never throws -- a check that fails just says no update. */
export async function checkForUpdate(root) {
  try {
    const latest = await latestCommit();
    const current = installedCommit(root);
    // No marker at all (a copy set up before this feature existed, or one
    // unzipped by hand rather than through the VDS script) is treated as
    // needing an update too, so it gets a marker the first time it checks
    // rather than silently never syncing again.
    return { hasUpdate: current !== latest, latest, current };
  } catch (err) {
    return { hasUpdate: false, error: err.message };
  }
}

/**
 * Download the branch zip, copy it over `root` (never touching .env or
 * data/, since neither exists in the git branch this zip is built from),
 * rebuild, and record the new commit. Runs entirely in a scratch temp
 * directory until the copy step, so a failed download or a bad zip never
 * touches the live app.
 */
export async function applyUpdate(root, { restart = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-cc-update-'));
  try {
    const latest = await latestCommit();
    const zipPath = path.join(scratch, 'app.zip');
    const res = await fetch(ZIP_URL);
    if (!res.ok) throw new Error(`Could not download the update (${res.status})`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

    const extractDir = path.join(scratch, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    await unzip(zipPath, extractDir);

    const inner = fs.readdirSync(extractDir).map((name) => path.join(extractDir, name))
      .find((p) => fs.statSync(p).isDirectory());
    if (!inner) throw new Error('The downloaded update zip had no app folder inside it');

    copyOver(inner, root);

    execFileSync('npm', ['run', 'setup'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

    fs.mkdirSync(path.dirname(markerPath(root)), { recursive: true });
    fs.writeFileSync(markerPath(root), latest);

    if (restart) {
      // NSSM (or whatever is supervising this process) restarts it on exit;
      // running without a supervisor and this flag set would just stop the
      // app dead, so callers only pass it when that restart is guaranteed.
      setTimeout(() => process.exit(0), 500);
    }
    return { ok: true, updatedTo: latest, restarting: restart };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Node has no built-in unzip; shell out to the platform's own tool. */
async function unzip(zipPath, destDir) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`]);
  } else {
    execFileSync('unzip', ['-oq', zipPath, '-d', destDir]);
  }
}

/** Copy every file from the update over the live app, in place. */
function copyOver(fromDir, toDir) {
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyOver(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

export const _internal = { markerPath, latestCommit, unzip, copyOver };
