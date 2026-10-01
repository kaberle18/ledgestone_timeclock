const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { openDb, getSecret } = require('./db');
const { renderReport } = require('./pdf');

const ACTIONS = [
  'account_created', 'signed_in', 'sign_in_failed', 'signed_out',
  'clocked_in', 'clocked_out', 'entry_added', 'entry_deleted', 'pdf_exported',
];

function clientIp(req) {
  const fwd = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || null;
}

function parseEvent(row) {
  let details = {};
  try { details = JSON.parse(row.details || '{}'); } catch { /* keep {} */ }
  return { ...row, details };
}

const COOKIE = 'tc_session';
const SESSION_DAYS = 30;

function createApp(providedDb) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  // The database is opened, migrated and the session secret loaded on the
  // first API request (once per process / warm serverless instance), so a
  // misconfiguration shows up as a readable error instead of a crash.
  // A failure isn't cached, so the next request retries.
  let db = providedDb;
  let secret;
  let ready = null;
  async function setup() {
    if (!db) {
      if (process.env.VERCEL && !process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set in Vercel. Add it under Settings → Environment Variables, then redeploy.');
      }
      db = openDb();
    }
    await db.migrate();
    secret = await getSecret(db);
  }
  app.use('/api', async (req, res, next) => {
    ready ||= setup().catch((err) => { ready = null; throw err; });
    try {
      await ready;
      next();
    } catch (err) {
      console.error('[db] setup failed:', err);
      res.status(500).json({ error: `Server is not ready: ${err.message}` });
    }
  });

  // Quick diagnostics: open /api/health in a browser.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, database: db.kind, node: process.version });
  });

  // Queries run against either the database or an open transaction (tx).
  function queries(x) {
    const one = async (sql, params) => (await x.query(sql, params))[0];
    return {
      userByEmail: (email) => one('SELECT * FROM users WHERE email = $1', [email]),
      userById: (id) => one('SELECT id, email, created_at FROM users WHERE id = $1', [id]),
      insertUser: (email, hash) => one(
        'INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
        [email, hash, new Date().toISOString()]),
      active: (userId) => one(
        'SELECT * FROM entries WHERE user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1', [userId]),
      clockIn: (userId) => one(
        'INSERT INTO entries (user_id, clock_in) VALUES ($1, $2) RETURNING *', [userId, new Date().toISOString()]),
      clockOut: (id) => one(
        'UPDATE entries SET clock_out = $1 WHERE id = $2 RETURNING *', [new Date().toISOString(), id]),
      insertEntry: (userId, clockIn, clockOut) => one(
        'INSERT INTO entries (user_id, clock_in, clock_out) VALUES ($1, $2, $3) RETURNING *', [userId, clockIn, clockOut]),
      deleteEntry: (userId, id) => one('DELETE FROM entries WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]),
      // Any shift (an open one counts as running until now) that overlaps [from, to).
      overlapping: (userId, from, to) => one(
        `SELECT * FROM entries
         WHERE user_id = $1 AND clock_in < $3 AND COALESCE(clock_out, $4) > $2
         ORDER BY clock_in LIMIT 1`, [userId, from, to, new Date().toISOString()]),
      range: (userId, from, to) => x.query(
        `SELECT id, clock_in, clock_out FROM entries
         WHERE user_id = $1 AND clock_in >= $2 AND clock_in < $3
         ORDER BY clock_in ASC`, [userId, from, to]),
      // Append-only paper trail. There is intentionally no update/delete for it.
      log: (req, userId, action, { entryId = null, details = {} } = {}) => x.query(
        `INSERT INTO activity (user_id, at, action, entry_id, details, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, new Date().toISOString(), action, entryId, JSON.stringify(details),
          clientIp(req), String(req.get('user-agent') || '').slice(0, 300)]),
      activity: (userId, { beforeId, action, limit }) => x.query(
        `SELECT id, at, action, entry_id, details, ip, user_agent FROM activity
         WHERE user_id = $1 AND id < $2 AND ($3 = '' OR action = $3)
         ORDER BY id DESC LIMIT $4`, [userId, beforeId, action, limit]),
    };
  }
  const q = queries({ query: (sql, params) => db.query(sql, params) });
  // Runs fn(q) in a transaction so an action and its log record are saved together.
  const inTx = (fn) => db.transaction((tx) => fn(queries(tx)));

  const hours = (a, b) => Math.round(((new Date(b) - new Date(a)) / 3_600_000) * 100) / 100;
  const entryDetails = (e) => ({
    clock_in: e.clock_in,
    clock_out: e.clock_out,
    hours: e.clock_out ? hours(e.clock_in, e.clock_out) : null,
  });

  function startSession(res, userId) {
    const token = jwt.sign({ sub: userId }, secret, { expiresIn: `${SESSION_DAYS}d` });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1' || !!process.env.VERCEL,
      maxAge: SESSION_DAYS * 86_400_000,
    });
  }

  async function auth(req, res, next) {
    try {
      const { sub } = jwt.verify(req.cookies[COOKIE] || '', secret);
      const user = await q.userById(sub);
      if (!user) throw new Error('no user');
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Not signed in' });
    }
  }

  function readCredentials(body) {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!email || !password) return { error: 'Email and password are required' };
    return { email, password };
  }

  // Parses ?from=&to= (ISO instants, to exclusive). Returns null if invalid.
  function readRange(query) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (isNaN(from) || isNaN(to) || to <= from) return null;
    return { from: from.toISOString(), to: to.toISOString() };
  }

  // ---- Auth ----
  app.post('/api/register', async (req, res) => {
    const c = readCredentials(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    if (await q.userByEmail(c.email)) return res.status(409).json({ error: 'An account with that email already exists' });
    const hash = await bcrypt.hash(c.password, 10);
    let id;
    try {
      id = await inTx(async (t) => {
        const { id } = await t.insertUser(c.email, hash);
        await t.log(req, id, 'account_created', { details: { email: c.email } });
        return id;
      });
    } catch {
      // Lost a race with a simultaneous sign-up for the same email.
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    startSession(res, id);
    res.status(201).json({ user: await q.userById(id) });
  });

  app.post('/api/login', async (req, res) => {
    const c = readCredentials(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    const user = await q.userByEmail(c.email);
    if (!user || !(await bcrypt.compare(c.password, user.password_hash))) {
      // Failed attempts on a real account go in that account's log.
      if (user) await q.log(req, user.id, 'sign_in_failed');
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    await q.log(req, user.id, 'signed_in');
    startSession(res, user.id);
    res.json({ user: await q.userById(user.id) });
  });

  app.post('/api/logout', async (req, res) => {
    try {
      const { sub } = jwt.verify(req.cookies[COOKIE] || '', secret);
      if (await q.userById(sub)) await q.log(req, sub, 'signed_out');
    } catch { /* not signed in: nothing to log */ }
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

  // ---- Clock ----
  app.get('/api/status', auth, async (req, res) => {
    res.json({ active: (await q.active(req.user.id)) || null });
  });

  app.post('/api/clock-in', auth, async (req, res) => {
    if (await q.active(req.user.id)) return res.status(409).json({ error: 'You are already clocked in' });
    const active = await inTx(async (t) => {
      const e = await t.clockIn(req.user.id);
      await t.log(req, req.user.id, 'clocked_in', { entryId: e.id, details: { clock_in: e.clock_in } });
      return e;
    });
    res.status(201).json({ active });
  });

  app.post('/api/clock-out', auth, async (req, res) => {
    const active = await q.active(req.user.id);
    if (!active) return res.status(409).json({ error: 'You are not clocked in' });
    const entry = await inTx(async (t) => {
      const e = await t.clockOut(active.id);
      await t.log(req, req.user.id, 'clocked_out', { entryId: e.id, details: entryDetails(e) });
      return e;
    });
    res.json({ entry, active: null });
  });

  // ---- History / export ----
  app.get('/api/entries', auth, async (req, res) => {
    const r = readRange(req.query);
    if (!r) return res.status(400).json({ error: 'Invalid date range' });
    res.json({ entries: await q.range(req.user.id, r.from, r.to) });
  });

  // Manually log a past shift.
  app.post('/api/entries', auth, async (req, res) => {
    const clockIn = new Date(req.body?.clock_in);
    const clockOut = new Date(req.body?.clock_out);
    if (isNaN(clockIn) || isNaN(clockOut)) return res.status(400).json({ error: 'Clock in and clock out times are required' });
    if (clockOut <= clockIn) return res.status(400).json({ error: 'Clock out must be after clock in' });
    if (clockOut > new Date()) return res.status(400).json({ error: 'Manual entries must be in the past' });
    const from = clockIn.toISOString();
    const to = clockOut.toISOString();
    if (await q.overlapping(req.user.id, from, to)) {
      return res.status(409).json({ error: 'That time overlaps a shift you already have' });
    }
    const entry = await inTx(async (t) => {
      const e = await t.insertEntry(req.user.id, from, to);
      await t.log(req, req.user.id, 'entry_added', { entryId: e.id, details: entryDetails(e) });
      return e;
    });
    res.status(201).json({ entry });
  });

  app.delete('/api/entries/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Entry not found' });
    const deleted = await inTx(async (t) => {
      const e = await t.deleteEntry(req.user.id, id);
      // Keep a full copy of the deleted record in the log.
      if (e) await t.log(req, req.user.id, 'entry_deleted', { entryId: e.id, details: { ...entryDetails(e), was_active: !e.clock_out } });
      return e;
    });
    if (!deleted) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  });

  app.get('/api/export.pdf', auth, async (req, res) => {
    const r = readRange(req.query);
    if (!r) return res.status(400).json({ error: 'Invalid date range' });
    let tz = String(req.query.tz || 'UTC');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
    const entries = await q.range(req.user.id, r.from, r.to);
    const total = entries.reduce((sum, e) => sum + hours(e.clock_in, e.clock_out || new Date().toISOString()), 0);
    await q.log(req, req.user.id, 'pdf_exported', {
      details: { from: r.from, to: r.to, tz, entries: entries.length, total_hours: Math.round(total * 100) / 100 },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="timeclock-${r.from.slice(0, 10)}.pdf"`);
    renderReport(res, { email: req.user.email, from: r.from, to: r.to, tz, entries });
  });

  // ---- Activity log (read-only) ----
  app.get('/api/activity', auth, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const beforeId = Number(req.query.before) || 2_147_483_647;
    const action = ACTIONS.includes(req.query.action) ? req.query.action : '';
    const rows = await q.activity(req.user.id, { beforeId, action, limit: limit + 1 });
    res.json({ events: rows.slice(0, limit).map(parseEvent), has_more: rows.length > limit });
  });

  app.get('/api/activity.csv', auth, async (req, res) => {
    let tz = String(req.query.tz || 'UTC');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
    const rows = (await q.activity(req.user.id, { beforeId: 2_147_483_647, action: '', limit: 1_000_000 }))
      .map(parseEvent);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' });
    const cell = (v) => {
      const str = v == null ? '' : String(v);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [['Event #', 'Time (UTC)', `Time (${tz})`, 'Action', 'Entry #', 'Clock In (UTC)', 'Clock Out (UTC)', 'Hours', 'Details', 'IP', 'Device']];
    for (const e of rows) {
      const { clock_in, clock_out, hours: h, ...rest } = e.details;
      lines.push([e.id, e.at, local.format(new Date(e.at)), e.action, e.entry_id, clock_in, clock_out, h,
        Object.keys(rest).length ? JSON.stringify(rest) : '', e.ip, e.user_agent]);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="timeclock-activity-log.csv"');
    res.send(lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n');
  });

  // Anything unexpected still comes back as JSON the UI can show.
  app.use((err, req, res, next) => {
    console.error('[api] error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Time Clock running at http://localhost:${port}`));
}

module.exports = { createApp };
