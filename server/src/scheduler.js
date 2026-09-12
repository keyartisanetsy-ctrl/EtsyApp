/**
 * Background work: keep tracking fresh and re-evaluate the stale alerts even
 * when nobody has the app open. Intervals are settings-driven; everything is
 * skipped while the shop is not connected.
 */
import { createLogger } from './lib/logger.js';
import config, { ROOT } from './config.js';
import { readSetting } from './services/settings.js';
import { getStoredToken } from './etsy/client.js';
import { syncTracking, refreshStaleFlags } from './services/tracking/index.js';
import { syncReceipts } from './services/sync.js';
import { ensureRates } from './services/fx.js';
import { scanInbox } from './services/productstudio.js';
import { checkForUpdate, applyUpdate } from '../../scripts/self-update.mjs';

const log = createLogger('scheduler');
const timers = [];

/**
 * True unless explicitly turned off. Used for the auto-update flags, which
 * default to on -- unset or blank (an existing .env from before this
 * default changed, or one that never mentioned the flag at all) reads as
 * "on", same as a fresh one. Only an explicit 0/false/no/off opts out.
 */
export const enabledByDefault = (value) => !/^(0|false|no|off)$/i.test(value ?? '');

export function startScheduler() {
  const trackingMinutes = Number(readSetting('tracking.sync_minutes')) || 180;

  // Stale flags are pure arithmetic, so run them often and cheaply.
  timers.push(setInterval(() => {
    try { refreshStaleFlags(); } catch (err) { log.warn(`stale refresh: ${err.message}`); }
  }, 15 * 60_000).unref());

  timers.push(setInterval(async () => {
    if (!getStoredToken()) return;
    try {
      const result = await syncTracking({});
      if (result.checked) log.info(`scheduled tracking sync: ${result.checked} parcels, ${result.errors.length} errors`);
    } catch (err) {
      log.warn(`scheduled tracking sync failed: ${err.message}`);
    }
  }, Math.max(15, trackingMinutes) * 60_000).unref());

  timers.push(setInterval(async () => {
    if (!getStoredToken()) return;
    try { await syncReceipts({}); } catch (err) { log.warn(`scheduled receipt sync failed: ${err.message}`); }
  }, 30 * 60_000).unref());

  if (config.features.autoSyncOnStart && getStoredToken()) {
    setTimeout(() => syncReceipts({}).catch((e) => log.warn(`startup sync: ${e.message}`)), 5000).unref();
  }

  // Exchange rates: once at startup and once a day. Cheap, and every order
  // pushed afterwards can be valued at the rate of its own day.
  if (readSetting('fx.auto_refresh') !== 'false') {
    setTimeout(() => ensureRates().catch((e) => log.warn(`rate refresh: ${e.message}`)), 3000).unref();
    timers.push(setInterval(() => {
      ensureRates().catch((e) => log.warn(`rate refresh: ${e.message}`));
    }, 24 * 60 * 60_000).unref());
  }

  // Product Studio's drop folder. This is the path for when that app cannot
  // make an HTTP request and writes a file instead - and a folder you have to
  // remember to press a button for is a folder nobody uses. Reading it is a
  // directory listing, so it costs nothing to do often.
  timers.push(setInterval(() => {
    scanInbox().then((r) => {
      if (r.created) log.info(`product studio: ${r.created} product(s) picked up from the drop folder`);
      if (r.failed) log.warn(`product studio: ${r.failed} file(s) could not be read, moved to "failed"`);
    }).catch((err) => log.warn(`product studio inbox: ${err.message}`));
  }, 20_000).unref());

  // On by default -- pull in a newer commit from this app's own branch the
  // moment this process starts, and every 30 minutes after, instead of
  // someone having to notice a fix shipped and re-run anything by hand.
  // Explicitly set AUTO_UPDATE=0 to turn this off entirely.
  // AUTO_UPDATE_RESTART is also on by default now that both START-WINDOWS.bat
  // and START-MAC-LINUX.command loop and relaunch "npm start" on their own
  // when the process exits (the VDS setup's NSSM/systemd service always did
  // this too) -- so restarting to pick up the new code is safe from every
  // launch path this app ships. Someone running "npm start" directly in a
  // terminal, without either wrapper, is the one case this is not safe for;
  // set AUTO_UPDATE_RESTART=0 there if that matters.
  if (enabledByDefault(process.env.AUTO_UPDATE)) {
    const restart = enabledByDefault(process.env.AUTO_UPDATE_RESTART);
    const runCheck = async () => {
      const status = await checkForUpdate(ROOT);
      if (!status.hasUpdate) return;
      log.info(`update available (${status.current?.slice(0, 7)} -> ${status.latest.slice(0, 7)}), installing...`);
      try {
        const r = await applyUpdate(ROOT, { restart });
        log.info(r.restarting
          ? `updated to ${r.updatedTo.slice(0, 7)}, restarting now`
          : `updated to ${r.updatedTo.slice(0, 7)} -- restart the app to use it`);
      } catch (err) {
        log.warn(`auto-update failed, still running the previous version: ${err.message}`);
      }
    };
    setTimeout(() => runCheck().catch((e) => log.warn(`update check: ${e.message}`)), 5_000).unref();
    timers.push(setInterval(() => {
      runCheck().catch((e) => log.warn(`update check: ${e.message}`));
    }, 30 * 60_000).unref());
  }

  log.info(`scheduler started (tracking every ${trackingMinutes}m, orders every 30m, drop folder every 20s)`);
}

export const stopScheduler = () => { for (const t of timers) clearInterval(t); timers.length = 0; };
