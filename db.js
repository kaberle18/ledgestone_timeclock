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
`;

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
    end: () => pool.end(),
  };
}

function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  return {
    kind: 'sqlite',
    async query(sql, params = []) {
      // $1 -> ?1 (SQLite's numbered-parameter syntax)
      return db.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...params);
    },
    async migrate() {
      db.exec(SQLITE_SCHEMA);
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
