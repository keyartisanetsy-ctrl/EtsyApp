/**
 * Background work: keep tracking fresh and re-evaluate the stale alerts even
 * when nobody has the app open. Intervals are settings-driven; everything is
 * skipped while the shop is not connected.
 */
import { createLogger } from './lib/logger.js';
import config from './config.js';
import { readSetting } from './services/settings.js';
import { getStoredToken } from './etsy/client.js';
import { syncTracking, refreshStaleFlags } from './services/tracking/index.js';
import { syncReceipts } from './services/sync.js';
import { ensureRates } from './services/fx.js';

const log = createLogger('scheduler');
const timers = [];

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

  log.info(`scheduler started (tracking every ${trackingMinutes}m, orders every 30m)`);
}

export const stopScheduler = () => { for (const t of timers) clearInterval(t); timers.length = 0; };
