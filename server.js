const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { openDb, getSecret } = require('./db');
const { renderReport } = require('./pdf');

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

  const one = async (sql, params) => (await db.query(sql, params))[0];
  const q = {
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
    deleteEntry: (userId, id) => one('DELETE FROM entries WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]),
    // Any shift (an open one counts as running until now) that overlaps [from, to).
    overlapping: (userId, from, to) => one(
      `SELECT * FROM entries
       WHERE user_id = $1 AND clock_in < $3 AND COALESCE(clock_out, $4) > $2
       ORDER BY clock_in LIMIT 1`, [userId, from, to, new Date().toISOString()]),
    range: (userId, from, to) => db.query(
      `SELECT id, clock_in, clock_out FROM entries
       WHERE user_id = $1 AND clock_in >= $2 AND clock_in < $3
       ORDER BY clock_in ASC`, [userId, from, to]),
  };

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
      ({ id } = await q.insertUser(c.email, hash));
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
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    startSession(res, user.id);
    res.json({ user: await q.userById(user.id) });
  });

  app.post('/api/logout', (req, res) => {
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
    res.status(201).json({ active: await q.clockIn(req.user.id) });
  });

  app.post('/api/clock-out', auth, async (req, res) => {
    const active = await q.active(req.user.id);
    if (!active) return res.status(409).json({ error: 'You are not clocked in' });
    res.json({ entry: await q.clockOut(active.id), active: null });
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
    res.status(201).json({ entry: await q.insertEntry(req.user.id, from, to) });
  });

  app.delete('/api/entries/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Entry not found' });
    if (!(await q.deleteEntry(req.user.id, id))) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  });

  app.get('/api/export.pdf', auth, async (req, res) => {
    const r = readRange(req.query);
    if (!r) return res.status(400).json({ error: 'Invalid date range' });
    let tz = String(req.query.tz || 'UTC');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
    const entries = await q.range(req.user.id, r.from, r.to);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="timeclock-${r.from.slice(0, 10)}.pdf"`);
    renderReport(res, { email: req.user.email, from: r.from, to: r.to, tz, entries });
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
