const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Two interchangeable backends behind one tiny async interface:
//   query(sql, params) -> rows     (SQL uses $1, $2 ... placeholders)
//   migrate()                       (idempotent schema setup)
// Postgres is used whenever DATABASE_URL is set (Vercel + Neon, Railway, ...).
// Otherwise a local SQLite file is used so the app runs with zero setup.

// Timestamps are stored as ISO 8601 UTC text in both backends. Postgres uses
// COLLATE "C" so text comparison is plain byte order (= chronological order).
// Entries logged by hand before the source column existed are identified
// from the activity log. Idempotent.
const BACKFILL_SOURCE = `UPDATE entries SET source = 'manual'
  WHERE source = 'clock' AND id IN (SELECT entry_id FROM activity WHERE action = 'entry_added')`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clock_in TEXT COLLATE "C" NOT NULL,
    clock_out TEXT COLLATE "C"
  );
  CREATE INDEX IF NOT EXISTS entries_user_in ON entries(user_id, clock_in);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Append-only activity log (paper trail). entry_id is deliberately not a
  -- foreign key: the log must outlive entries that get deleted.
  CREATE TABLE IF NOT EXISTS activity (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at TEXT COLLATE "C" NOT NULL,
    action TEXT NOT NULL,
    entry_id INTEGER,
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS activity_user_id ON activity(user_id, id);
  -- Profile fields (added after the first release)
  ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
  -- How an entry was created: 'clock' (live clock in/out) or 'manual'
  ALTER TABLE entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'clock';
  ${BACKFILL_SOURCE};
`;

// Columns added to existing tables after the first release. SQLite has no
// ADD COLUMN IF NOT EXISTS, so these are checked one by one.
const SQLITE_ADDED_COLUMNS = [
  ['users', 'name', 'TEXT'],
  ['users', 'avatar', 'TEXT'],
  ['users', 'token_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['entries', 'source', "TEXT NOT NULL DEFAULT 'clock'"],
];

const SQLITE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clock_in TEXT NOT NULL,
    clock_out TEXT
  );
  CREATE INDEX IF NOT EXISTS entries_user_in ON entries(user_id, clock_in);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    entry_id INTEGER,
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS activity_user_id ON activity(user_id, id);
`;

function openPostgres(url) {
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL must start with postgresql:// — paste only the connection string (no "psql", quotes or spaces).');
  }
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    // Neon and Railway Postgres require SSL; set PGSSL=false for a local Postgres.
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    // Serverless instances each get their own small pool.
    max: Number(process.env.PG_POOL_MAX) || 5,
    keepAlive: true,
  });
  return {
    kind: 'postgres',
    async query(sql, params = []) {
      return (await pool.query(sql, params)).rows;
    },
    async migrate() {
      await pool.query(PG_SCHEMA);
    },
    // Runs fn(tx) inside BEGIN/COMMIT on one connection; rolls back on error.
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (sql, params = []) => (await client.query(sql, params)).rows });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // $1 -> ?1 (SQLite's numbered-parameter syntax)
  const query = async (sql, params = []) => db.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...params);
  let txQueue = Promise.resolve(); // one transaction at a time on the single connection
  return {
    kind: 'sqlite',
    query,
    transaction(fn) {
      const run = txQueue.then(async () => {
        db.exec('BEGIN');
        try {
          const result = await fn({ query });
          db.exec('COMMIT');
          return result;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
      txQueue = run.catch(() => {});
      return run;
    },
    async migrate() {
      db.exec(SQLITE_SCHEMA);
      for (const [table, column, type] of SQLITE_ADDED_COLUMNS) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      db.exec(BACKFILL_SOURCE);
    },
    end: async () => db.close(),
  };
}

function openDb({
  url = process.env.DATABASE_URL,
  file = process.env.DB_FILE || path.join(__dirname, 'data', 'timeclock.db'),
} = {}) {
  return url ? openPostgres(url) : openSqlite(file);
}

// Session-signing secret: JWT_SECRET if set, otherwise generated once and kept
// in the database so logins survive restarts / new serverless instances.
async function getSecret(db) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const fresh = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['jwt_secret', fresh]);
  const [row] = await db.query('SELECT value FROM meta WHERE key = $1', ['jwt_secret']);
  return row.value;
}

module.exports = { openDb, getSecret };
