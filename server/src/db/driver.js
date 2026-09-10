/**
 * SQLite driver, chosen at runtime.
 *
 * Node ships SQLite as `node:sqlite` (stable from Node 23.4, behind
 * --experimental-sqlite on 22.x). Using it means the app installs with no
 * native compilation at all — no Visual Studio, no Python, no node-gyp, and no
 * dependence on a prebuilt binary existing for whatever Node version the user
 * happens to have. That matters: better-sqlite3 publishes prebuilds per Node
 * major, so a new Node release (25, say) leaves users compiling from source.
 *
 * better-sqlite3 is kept as an optional fallback for older Node builds where
 * node:sqlite is unavailable. This module presents the better-sqlite3 API
 * either way, so nothing above it needs to know which one is in use.
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('sqlite');

/** SQLite binds numbers, strings, bigints, buffers and null. Normalise the
 *  rest rather than letting a stray boolean throw deep inside a statement. */
function coerce(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

const coerceArgs = (args) =>
  args.map((a) => {
    if (a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a) && !(a instanceof Date)) {
      return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, coerce(v)]));
    }
    return coerce(a);
  });

/** Wraps node:sqlite's DatabaseSync in the better-sqlite3 shape. */
class NodeSqliteAdapter {
  constructor(DatabaseSync, file) {
    this.db = new DatabaseSync(file);
    this.name = 'node:sqlite';
    this.depth = 0;
  }

  pragma(statement) {
    // better-sqlite3 takes "journal_mode = WAL"; node:sqlite wants full SQL.
    return this.db.exec(`PRAGMA ${statement};`);
  }

  exec(sql) { return this.db.exec(sql); }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      run: (...args) => stmt.run(...coerceArgs(args)),
      get: (...args) => stmt.get(...coerceArgs(args)),
      all: (...args) => stmt.all(...coerceArgs(args)),
    };
  }

  /**
   * better-sqlite3's transaction() returns a callable and supports nesting.
   * Nested calls become savepoints so an inner rollback does not discard the
   * outer transaction.
   */
  transaction(fn) {
    return (...args) => {
      const nested = this.depth > 0;
      const name = `sp_${this.depth}`;
      this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      this.depth += 1;
      try {
        const result = fn(...args);
        this.depth -= 1;
        this.db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        this.depth -= 1;
        try { this.db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK'); } catch { /* already unwound */ }
        throw err;
      }
    };
  }

  close() { return this.db.close(); }
}

/**
 * Node 22 prints "SQLite is an experimental feature" on first use. The feature
 * is stable from Node 23.4 and the warning is noise to an operator, so filter
 * just that one and leave every other warning visible.
 */
function silenceSqliteWarning() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/SQLite is an experimental feature/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
}

/** Load node:sqlite if this Node build exposes it. */
async function tryNodeSqlite() {
  silenceSqliteWarning();
  try {
    const mod = await import('node:sqlite');
    if (!mod?.DatabaseSync) return null;
    // Confirm it actually opens - the module can exist but be flag-gated.
    const probe = new mod.DatabaseSync(':memory:');
    probe.exec('SELECT 1');
    probe.close();
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

async function tryBetterSqlite() {
  try {
    return (await import('better-sqlite3')).default;
  } catch {
    return null;
  }
}

let driver = null;

/** Resolve the driver once, preferring the built-in. */
export async function openDatabase(file) {
  if (!driver) {
    const DatabaseSync = await tryNodeSqlite();
    if (DatabaseSync) {
      driver = { kind: 'node:sqlite', open: (f) => new NodeSqliteAdapter(DatabaseSync, f) };
      log.info('using the built-in node:sqlite driver (no native build required)');
    } else {
      const BetterSqlite3 = await tryBetterSqlite();
      if (!BetterSqlite3) {
        throw new Error(
          'No SQLite driver available.\n'
          + `This Node build (${process.version}) does not expose node:sqlite, and better-sqlite3 is not installed.\n`
          + 'Fix: install Node.js 22 LTS or newer from https://nodejs.org, then run npm start again.',
        );
      }
      driver = {
        kind: 'better-sqlite3',
        open: (f) => {
          const db = new BetterSqlite3(f);
          db.name = 'better-sqlite3';
          return db;
        },
      };
      log.info('using the better-sqlite3 driver');
    }
  }
  return driver.open(file);
}

export const driverKind = () => driver?.kind ?? null;
