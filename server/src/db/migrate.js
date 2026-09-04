/**
 * Schema migrations for databases created by an earlier version.
 *
 * Runs in two phases around schema.sql, because schema.sql now creates
 * indexes on columns (tracking.shop_id, etc.) that an upgrading database may
 * not have yet:
 *
 *   migrateSchema(db)   -- BEFORE schema.sql: bring existing tables' shape
 *                          (columns, primary keys) up to date, so schema.sql's
 *                          CREATE INDEX statements have something to point at.
 *   <schema.sql runs>   -- creates any wholly new tables, including
 *                          etsy_accounts on the very first migration ever.
 *   migrateData(db)      -- AFTER schema.sql: moves data that depends on a
 *                          table schema.sql itself guarantees now exists
 *                          (etsy_accounts).
 *
 * Getting this ordering wrong doesn't fail loudly in testing against a fresh
 * database -- it only breaks for someone upgrading an existing one, which is
 * exactly the case worth being careful about.
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('migrate');

const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

const columns = (db, table) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  catch { return []; }
};

/** True when a table's primary key is exactly the given column list, in order. */
function isCompositePk(db, table, expectedCols) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const pkCols = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return pkCols.length === expectedCols.length && expectedCols.every((c, i) => pkCols[i] === c);
}

const addColumn = (db, table, column, type) => {
  if (!hasTable(db, table) || columns(db, table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  log.info(`added ${table}.${column}`);
  return true;
};

/**
 * Best-guess "whose data is this" for rows written before shop scoping
 * existed, without assuming etsy_accounts exists yet as a table -- on the
 * oldest possible upgrade path only the single-shop `oauth_token` table does.
 */
function legacyActiveShopId(db) {
  if (hasTable(db, 'etsy_accounts')) {
    const row = db.prepare('SELECT shop_id FROM etsy_accounts WHERE is_active = 1').get();
    if (row?.shop_id) return row.shop_id;
  }
  if (hasTable(db, 'oauth_token')) {
    const row = db.prepare('SELECT shop_id FROM oauth_token WHERE id = 1').get();
    if (row?.shop_id) return row.shop_id;
  }
  return null;
}

/** Runs BEFORE schema.sql. Table/column shape only -- never touches etsy_accounts. */
export function migrateSchema(db) {
  const active = legacyActiveShopId(db);

  addColumn(db, 'shop_sections', 'shop_id', 'INTEGER');
  addColumn(db, 'bulk_jobs', 'shop_id', 'INTEGER');
  addColumn(db, 'research_runs', 'shop_id', 'INTEGER');

  if (active) {
    for (const table of ['shop_sections', 'bulk_jobs', 'research_runs']) {
      if (!hasTable(db, table) || !columns(db, table).includes('shop_id')) continue;
      const orphans = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE shop_id IS NULL`).get().c;
      if (orphans) {
        db.prepare(`UPDATE ${table} SET shop_id = ? WHERE shop_id IS NULL`).run(active);
        log.info(`assigned ${orphans} existing ${table} row(s) to shop ${active}`);
      }
    }
  }

  // sku_meta: bare `sku` primary key -> composite (shop_id, sku), because two
  // different shops can legitimately reuse the same SKU string.
  if (hasTable(db, 'sku_meta') && !columns(db, 'sku_meta').includes('shop_id')) {
    db.transaction(() => {
      db.exec('ALTER TABLE sku_meta RENAME TO sku_meta_old');
      db.exec(`CREATE TABLE sku_meta (
        shop_id INTEGER, sku TEXT NOT NULL, supply_link TEXT DEFAULT '',
        supplier_name TEXT DEFAULT '', supply_cost REAL, supply_currency TEXT DEFAULT 'USD',
        lead_time_days INTEGER, notes TEXT DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (shop_id, sku))`);
      db.prepare(`INSERT INTO sku_meta (shop_id, sku, supply_link, supplier_name, supply_cost,
          supply_currency, lead_time_days, notes, updated_at)
        SELECT ?, sku, supply_link, supplier_name, supply_cost, supply_currency, lead_time_days, notes, updated_at
        FROM sku_meta_old`).run(active);
      db.exec('DROP TABLE sku_meta_old');
    })();
    log.info(`sku_meta rebuilt with shop scoping${active ? ` (existing rows assigned to shop ${active})` : ''}`);
  }

  // tracking: bare `tracking_code` primary key -> composite (shop_id,
  // tracking_code). A tracking number is carrier-assigned, not an Etsy id, so
  // two shops -- most plausibly sharing a 3PL or courier account -- can
  // legitimately be handed the same number for two different parcels.
  if (hasTable(db, 'tracking') && !isCompositePk(db, 'tracking', ['shop_id', 'tracking_code'])) {
    db.transaction(() => {
      if (!columns(db, 'tracking').includes('shop_id')) db.exec('ALTER TABLE tracking ADD COLUMN shop_id INTEGER');
      db.prepare('UPDATE tracking SET shop_id = ? WHERE shop_id IS NULL').run(active);
      db.exec('ALTER TABLE tracking RENAME TO tracking_old');
      db.exec(`CREATE TABLE tracking (
        shop_id INTEGER, tracking_code TEXT NOT NULL, receipt_id INTEGER, carrier_name TEXT,
        provider TEXT, status TEXT NOT NULL DEFAULT 'pre_shipped', status_detail TEXT DEFAULT '',
        origin_country TEXT, destination_country TEXT, last_event_at TEXT, last_event_text TEXT,
        last_event_location TEXT, event_count INTEGER DEFAULT 0, days_since_move INTEGER,
        is_stale INTEGER NOT NULL DEFAULT 0, alert_reason TEXT DEFAULT '', alert_ack INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')), last_checked_at TEXT,
        check_error TEXT, raw TEXT, PRIMARY KEY (shop_id, tracking_code))`);
      db.exec(`INSERT INTO tracking SELECT shop_id, tracking_code, receipt_id, carrier_name, provider, status,
        status_detail, origin_country, destination_country, last_event_at, last_event_text, last_event_location,
        event_count, days_since_move, is_stale, alert_reason, alert_ack, delivered_at, first_seen_at,
        last_checked_at, check_error, raw FROM tracking_old`);
      db.exec('DROP TABLE tracking_old');
    })();
    log.info('tracking rebuilt keyed by (shop_id, tracking_code)');
  }

  // tracking_events: add shop_id (backfilled from the now-migrated tracking
  // row by tracking_code) and widen the uniqueness constraint the same way.
  if (hasTable(db, 'tracking_events') && !columns(db, 'tracking_events').includes('shop_id')) {
    db.transaction(() => {
      db.exec('ALTER TABLE tracking_events RENAME TO tracking_events_old');
      db.exec(`CREATE TABLE tracking_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER, tracking_code TEXT NOT NULL,
        event_at TEXT, description TEXT, location TEXT, status_hint TEXT, fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (shop_id, tracking_code, fingerprint))`);
      db.exec(`INSERT INTO tracking_events (id, shop_id, tracking_code, event_at, description, location,
          status_hint, fingerprint, created_at)
        SELECT e.id, t.shop_id, e.tracking_code, e.event_at, e.description, e.location, e.status_hint,
               e.fingerprint, e.created_at
        FROM tracking_events_old e LEFT JOIN tracking t ON t.tracking_code = e.tracking_code`);
      db.exec('DROP TABLE tracking_events_old');
    })();
    log.info('tracking_events rebuilt with shop scoping');
  }

  // shipments: add shop_id for direct filtering, backfilled via the receipt
  // it belongs to (receipt_id is an Etsy id, so it is authoritative here).
  if (addColumn(db, 'shipments', 'shop_id', 'INTEGER')) {
    db.exec(`UPDATE shipments SET shop_id = (
      SELECT r.shop_id FROM receipts r WHERE r.receipt_id = shipments.receipt_id
    ) WHERE shop_id IS NULL`);
  }
}

/** Runs AFTER schema.sql, once etsy_accounts is guaranteed to exist. */
export function migrateData(db) {
  // Single-shop oauth_token -> multi-shop etsy_accounts.
  if (hasTable(db, 'oauth_token')) {
    const existing = db.prepare('SELECT * FROM oauth_token').all();
    if (existing.length) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO etsy_accounts
          (shop_id, shop_name, user_id, access_token, refresh_token, scopes, expires_at, is_active, connected_at)
        VALUES (?,?,?,?,?,?,?,1,?)`);
      db.transaction(() => {
        for (const row of existing) {
          insert.run(row.shop_id, row.shop_name, row.user_id, row.access_token,
                     row.refresh_token, row.scopes, row.expires_at, row.connected_at);
        }
      })();
      log.info(`migrated ${existing.length} connected shop(s) to the accounts table`);
    }
    db.exec('DROP TABLE oauth_token');
  }

  // Earlier builds wrote a shop's connection in two steps (an initial row
  // with no shop_id yet, then a second insert once the shop was resolved),
  // which left a permanent, useless orphan row behind on every connection.
  // A row with no shop_id can never do anything (every operation needs one),
  // so it is always safe to remove.
  const orphans = db.prepare('DELETE FROM etsy_accounts WHERE shop_id IS NULL').run();
  if (orphans.changes) log.info(`removed ${orphans.changes} incomplete shop connection(s) left by an older version`);
}

/** Convenience for callers that do not need the two phases separately. */
export function migrate(db) {
  migrateSchema(db);
  migrateData(db);
}
