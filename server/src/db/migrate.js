/**
 * Schema migrations for databases created by an earlier version.
 *
 * Each step is guarded so running it repeatedly is harmless, and each is
 * wrapped so one failure cannot leave the database half-changed.
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('migrate');

const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

const columns = (db, table) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  catch { return []; }
};

const addColumn = (db, table, column, type) => {
  if (!hasTable(db, table) || columns(db, table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  log.info(`added ${table}.${column}`);
  return true;
};

export function migrate(db) {
  // Single-shop oauth_token -> multi-shop etsy_accounts.
  if (hasTable(db, 'oauth_token') && hasTable(db, 'etsy_accounts')) {
    const existing = db.prepare('SELECT * FROM oauth_token').all();
    const already = db.prepare('SELECT COUNT(*) AS c FROM etsy_accounts').get().c;
    if (existing.length && !already) {
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

  // Shop scoping on tables that predate multi-shop.
  addColumn(db, 'tracking', 'shop_id', 'INTEGER');
  addColumn(db, 'shop_sections', 'shop_id', 'INTEGER');

  // Rows written before scoping existed belong to the first shop connected.
  const active = hasTable(db, 'etsy_accounts')
    ? db.prepare('SELECT shop_id FROM etsy_accounts WHERE is_active = 1').get()?.shop_id
    : null;
  if (active) {
    for (const [table, column] of [['tracking', 'shop_id'], ['shop_sections', 'shop_id']]) {
      if (!hasTable(db, table) || !columns(db, table).includes(column)) continue;
      const orphans = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} IS NULL`).get().c;
      if (orphans) {
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} IS NULL`).run(active);
        log.info(`assigned ${orphans} existing ${table} row(s) to shop ${active}`);
      }
    }
  }
}
