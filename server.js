const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { openDb, getSecret } = require('./db');
const { renderReportBuffer } = require('./pdf');

const ACTIONS = [
  'account_created', 'signed_in', 'sign_in_failed', 'signed_out',
  'clocked_in', 'clocked_out', 'entry_added', 'entry_deleted', 'pdf_exported',
  'name_changed', 'email_changed', 'password_changed', 'photo_updated', 'photo_removed', 'all_data_deleted',
];

const MAX_NAME = 80;
// Profile photos are resized in the browser to a small JPEG and stored inline.
const MAX_AVATAR_CHARS = 400_000;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

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
  app.use(express.json({ limit: '1mb' }));
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
      userById: (id) => one(
        'SELECT id, email, name, avatar, token_version, created_at FROM users WHERE id = $1', [id]),
      passwordHash: async (id) => (await one('SELECT password_hash FROM users WHERE id = $1', [id]))?.password_hash,
      setName: (id, name) => x.query('UPDATE users SET name = $1 WHERE id = $2', [name, id]),
      setAvatar: (id, avatar) => x.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, id]),
      setEmail: (id, email) => x.query('UPDATE users SET email = $1 WHERE id = $2', [email, id]),
      // Bumping token_version signs out every other session.
      setPassword: (id, hash) => one(
        'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version',
        [hash, id]),
      allEntries: (userId) => x.query(
        'SELECT id, clock_in, clock_out, source FROM entries WHERE user_id = $1 ORDER BY clock_in', [userId]),
      deleteAllEntries: (userId) => x.query('DELETE FROM entries WHERE user_id = $1', [userId]),
      deleteUser: (userId) => x.query('DELETE FROM users WHERE id = $1', [userId]),
      deleteActivity: (userId) => x.query('DELETE FROM activity WHERE user_id = $1', [userId]),
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
        "INSERT INTO entries (user_id, clock_in, clock_out, source) VALUES ($1, $2, $3, 'manual') RETURNING *",
        [userId, clockIn, clockOut]),
      deleteEntry: (userId, id) => one('DELETE FROM entries WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]),
      // Any shift (an open one counts as running until now) that overlaps [from, to).
      overlapping: (userId, from, to) => one(
        `SELECT * FROM entries
         WHERE user_id = $1 AND clock_in < $3 AND COALESCE(clock_out, $4) > $2
         ORDER BY clock_in LIMIT 1`, [userId, from, to, new Date().toISOString()]),
      range: (userId, from, to) => x.query(
        `SELECT id, clock_in, clock_out, source FROM entries
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
  // source: 'clock' = live clock in/out, 'manual' = logged by hand afterwards
  const entryDetails = (e) => ({
    source: e.source || 'clock',
    clock_in: e.clock_in,
    clock_out: e.clock_out,
    hours: e.clock_out ? hours(e.clock_in, e.clock_out) : null,
  });

  // What the browser gets to see about the signed-in user.
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name || '', avatar: u.avatar || null, created_at: u.created_at });

  function startSession(res, userId, tokenVersion = 0) {
    const token = jwt.sign({ sub: userId, v: tokenVersion }, secret, { expiresIn: `${SESSION_DAYS}d` });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1' || !!process.env.VERCEL,
      maxAge: SESSION_DAYS * 86_400_000,
    });
  }

  async function auth(req, res, next) {
    try {
      const { sub, v = 0 } = jwt.verify(req.cookies[COOKIE] || '', secret);
      const user = await q.userById(sub);
      if (!user || user.token_version !== v) throw new Error('no user / session revoked');
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
    res.status(201).json({ user: publicUser(await q.userById(id)) });
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
    startSession(res, user.id, user.token_version);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', async (req, res) => {
    try {
      const { sub } = jwt.verify(req.cookies[COOKIE] || '', secret);
      if (await q.userById(sub)) await q.log(req, sub, 'signed_out');
    } catch { /* not signed in: nothing to log */ }
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  // ---- Profile ----
  async function checkPassword(userId, password) {
    const hash = await q.passwordHash(userId);
    return !!hash && bcrypt.compare(String(password || ''), hash);
  }

  app.patch('/api/profile', auth, async (req, res) => {
    const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length > MAX_NAME) return res.status(400).json({ error: `Name must be ${MAX_NAME} characters or less` });
    const before = req.user.name || '';
    if (name !== before) {
      await inTx(async (t) => {
        await t.setName(req.user.id, name || null);
        await t.log(req, req.user.id, 'name_changed', { details: { from: before, to: name } });
      });
    }
    res.json({ user: publicUser(await q.userById(req.user.id)) });
  });

  app.put('/api/profile/photo', auth, async (req, res) => {
    const photo = String(req.body?.photo || '');
    if (!AVATAR_RE.test(photo)) return res.status(400).json({ error: 'Please choose a JPEG, PNG or WebP image' });
    if (photo.length > MAX_AVATAR_CHARS) return res.status(400).json({ error: 'That image is too large' });
    await inTx(async (t) => {
      await t.setAvatar(req.user.id, photo);
      await t.log(req, req.user.id, 'photo_updated');
    });
    res.json({ user: publicUser(await q.userById(req.user.id)) });
  });

  app.delete('/api/profile/photo', auth, async (req, res) => {
    if (req.user.avatar) {
      await inTx(async (t) => {
        await t.setAvatar(req.user.id, null);
        await t.log(req, req.user.id, 'photo_removed');
      });
    }
    res.json({ user: publicUser(await q.userById(req.user.id)) });
  });

  app.post('/api/profile/email', auth, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Enter a new email' });
    if (!(await checkPassword(req.user.id, req.body?.current_password))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (email === req.user.email) return res.status(400).json({ error: 'That is already your email' });
    if (await q.userByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists' });
    try {
      await inTx(async (t) => {
        await t.setEmail(req.user.id, email);
        await t.log(req, req.user.id, 'email_changed', { details: { from: req.user.email, to: email } });
      });
    } catch {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    res.json({ user: publicUser(await q.userById(req.user.id)) });
  });

  app.post('/api/profile/password', auth, async (req, res) => {
    const next = String(req.body?.new_password || '');
    if (!next) return res.status(400).json({ error: 'Enter a new password' });
    if (!(await checkPassword(req.user.id, req.body?.current_password))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(next, 10);
    const { token_version } = await inTx(async (t) => {
      const r = await t.setPassword(req.user.id, hash);
      await t.log(req, req.user.id, 'password_changed');
      return r;
    });
    startSession(res, req.user.id, token_version); // keep this device signed in
    res.json({ ok: true });
  });

  // Wipes all of the user's data: every time entry and the whole activity log.
  // The account itself (email, password, name, photo) is kept.
  app.post('/api/profile/delete-data', auth, async (req, res) => {
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
    const count = await inTx(async (t) => {
      const entries = await t.allEntries(req.user.id);
      await t.deleteAllEntries(req.user.id);
      await t.deleteActivity(req.user.id);
      return entries.length;
    });
    res.json({ ok: true, deleted: count });
  });

  // Permanently deletes the account and everything in it (entries + log).
  app.post('/api/profile/delete-account', auth, async (req, res) => {
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
    if (!(await checkPassword(req.user.id, req.body?.password))) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }
    await inTx(async (t) => {
      await t.deleteActivity(req.user.id);
      await t.deleteAllEntries(req.user.id);
      await t.deleteUser(req.user.id);
    });
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

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
    const nowIso = new Date().toISOString();
    const total = entries.reduce((sum, e) => sum + hours(e.clock_in, e.clock_out || nowIso), 0);
    // "All time": the header shows the span actually covered by the entries.
    const all = req.query.all === '1';
    let rangeText;
    if (all) {
      const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' });
      if (!entries.length) rangeText = 'All time';
      else {
        const first = day.format(new Date(entries[0].clock_in));
        const last = day.format(new Date(entries.reduce((m, e) => ((e.clock_out || nowIso) > m ? e.clock_out || nowIso : m), '')));
        rangeText = first === last ? first : `${first} – ${last}`;
      }
    }
    // Build the whole PDF first: if anything fails, the client gets a JSON error
    // instead of a half-written file, and no export is logged.
    const pdf = await renderReportBuffer({ name: req.user.name, email: req.user.email, from: r.from, to: r.to, tz, entries, rangeText });
    await q.log(req, req.user.id, 'pdf_exported', {
      details: { from: r.from, to: r.to, tz, all, entries: entries.length, total_hours: Math.round(total * 100) / 100 },
    });
    const name = all ? 'timeclock-all-time.pdf' : `timeclock-${r.from.slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdf);
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
    const lines = [['Event #', 'Time (UTC)', `Time (${tz})`, 'Action', 'Entry #', 'Entry Type', 'Clock In (UTC)', 'Clock Out (UTC)', 'Hours', 'Details', 'IP', 'Device']];
    const typeLabel = { clock: 'Live clock', manual: 'Manual' };
    for (const e of rows) {
      const { source, clock_in, clock_out, hours: h, ...rest } = e.details;
      lines.push([e.id, e.at, local.format(new Date(e.at)), e.action, e.entry_id, typeLabel[source] || '', clock_in, clock_out, h,
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
