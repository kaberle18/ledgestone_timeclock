const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../db');
const { createApp } = require('../server');

// Runs against in-memory SQLite by default; set TEST_DATABASE_URL to run the
// same tests against a (throwaway!) Postgres database.
async function startServer() {
  const url = process.env.TEST_DATABASE_URL || '';
  const db = openDb({ url, file: ':memory:' });
  if (url) await db.query('DROP TABLE IF EXISTS activity, entries, users, meta');
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, { method = 'GET', body, cookie: useCookie } = {}) => {
    const c = useCookie ?? cookie;
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(c ? { Cookie: c } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  call.cookie = () => cookie;
  return { db, server, call };
}

const pageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

test('register, clock in/out, list, export', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });

  assert.equal((await call('/api/me')).status, 401);
  let res = await call('/api/register', { method: 'POST', body: { email: 'Worker@Example.com', password: 'pw' } });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).user.email, 'worker@example.com');
  assert.equal((await call('/api/register', { method: 'POST', body: { email: 'worker@example.com', password: 'x' } })).status, 409);

  assert.equal((await call('/api/clock-out', { method: 'POST' })).status, 409);
  assert.equal((await call('/api/clock-in', { method: 'POST' })).status, 201);
  assert.equal((await call('/api/clock-in', { method: 'POST' })).status, 409);
  assert.ok((await (await call('/api/status')).json()).active);
  assert.equal((await call('/api/clock-out', { method: 'POST' })).status, 200);
  assert.equal((await (await call('/api/status')).json()).active, null);

  // Logout / login round trip
  await call('/api/logout', { method: 'POST' });
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'worker@example.com', password: 'bad' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'worker@example.com', password: 'pw' } })).status, 200);

  // Seed known shifts: 8h on Sep 1, 4.5h on Sep 2, one outside the range
  const ins = { run: (a, b) => db.query('INSERT INTO entries (user_id, clock_in, clock_out) VALUES (1, $1, $2)', [a, b]) };
  await ins.run('2026-09-01T13:00:00.000Z', '2026-09-01T21:00:00.000Z');
  await ins.run('2026-09-02T13:00:00.000Z', '2026-09-02T17:30:00.000Z');
  await ins.run('2026-08-20T13:00:00.000Z', '2026-08-20T14:00:00.000Z');

  const range = 'from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z';
  const { entries } = await (await call(`/api/entries?${range}`)).json();
  assert.equal(entries.length, 2);
  assert.equal((await call('/api/entries?from=bad&to=worse')).status, 400);

  res = await call(`/api/export.pdf?${range}&tz=America/Chicago`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(pdf), 1);
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 612 792\]/);
});

test('PDF stays one page with many entries', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'a@b.c', password: 'pw' } });
  const ins = { run: (a, b) => db.query('INSERT INTO entries (user_id, clock_in, clock_out) VALUES (1, $1, $2)', [a, b]) };
  for (let i = 0; i < 150; i++) {
    const start = Date.UTC(2026, 8, 1) + i * 4 * 3_600_000;
    await ins.run(new Date(start).toISOString(), new Date(start + 2 * 3_600_000).toISOString());
  }
  const res = await call('/api/export.pdf?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&tz=UTC');
  assert.equal(pageCount(Buffer.from(await res.arrayBuffer())), 1);
});

test('unauthenticated requests are rejected', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  for (const p of ['/api/status', '/api/entries?from=2026-01-01&to=2026-02-01', '/api/export.pdf?from=2026-01-01&to=2026-02-01']) {
    assert.equal((await call(p)).status, 401, p);
  }
});

test('manually add and delete entries', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'm@x.co', password: 'pw' } });
  const add = (clock_in, clock_out) => call('/api/entries', { method: 'POST', body: { clock_in, clock_out } });

  let res = await add('2026-09-10T13:00:00.000Z', '2026-09-10T21:00:00.000Z');
  assert.equal(res.status, 201);
  const { entry } = await res.json();
  assert.equal(entry.clock_out, '2026-09-10T21:00:00.000Z');

  assert.equal((await add('2026-09-10T20:00:00.000Z', '2026-09-10T22:00:00.000Z')).status, 409, 'overlap');
  assert.equal((await add('2026-09-10T21:00:00.000Z', '2026-09-10T22:00:00.000Z')).status, 201, 'touching is fine');
  assert.equal((await add('2026-09-11T10:00:00.000Z', '2026-09-11T09:00:00.000Z')).status, 400, 'out before in');
  assert.equal((await add('2999-01-01T10:00:00.000Z', '2999-01-01T11:00:00.000Z')).status, 400, 'future');
  assert.equal((await add('nope', '')).status, 400);

  // An open (current) shift blocks a manual entry that overlaps "now"-ish ranges
  await call('/api/clock-in', { method: 'POST' });
  const recent = Date.now() - 60_000;
  assert.equal((await add(new Date(recent - 3_600_000).toISOString(), new Date(recent).toISOString())).status, 201);
  const { active } = await (await call('/api/status')).json();

  // Another user can't delete my entry
  await call('/api/logout', { method: 'POST' });
  await call('/api/register', { method: 'POST', body: { email: 'other@x.co', password: 'pw' } });
  assert.equal((await call(`/api/entries/${entry.id}`, { method: 'DELETE' })).status, 404);
  await call('/api/logout', { method: 'POST' });
  await call('/api/login', { method: 'POST', body: { email: 'm@x.co', password: 'pw' } });

  assert.equal((await call(`/api/entries/${entry.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/entries/${entry.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await call('/api/entries/abc', { method: 'DELETE' })).status, 404);

  // Deleting the open shift clocks you out
  assert.equal((await call(`/api/entries/${active.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await call('/api/status')).json()).active, null);

  const range = 'from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z';
  const { entries } = await (await call(`/api/entries?${range}`)).json();
  assert.deepEqual(entries.map((e) => e.clock_in), ['2026-09-10T21:00:00.000Z']);
});

test('activity log records every action, including deleted records', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'log@x.co', password: 'pw' } });
  await call('/api/clock-in', { method: 'POST' });
  await call('/api/clock-out', { method: 'POST' });
  const { entry } = await (await call('/api/entries', {
    method: 'POST', body: { clock_in: '2026-09-10T13:00:00.000Z', clock_out: '2026-09-10T21:30:00.000Z' },
  })).json();
  await call(`/api/entries/${entry.id}`, { method: 'DELETE' });
  await call('/api/export.pdf?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&tz=UTC');
  await call('/api/logout', { method: 'POST' });
  await call('/api/login', { method: 'POST', body: { email: 'log@x.co', password: 'wrong' } });
  await call('/api/login', { method: 'POST', body: { email: 'log@x.co', password: 'pw' } });

  const { events, has_more } = await (await call('/api/activity')).json();
  assert.equal(has_more, false);
  assert.deepEqual(events.map((e) => e.action), [
    'signed_in', 'sign_in_failed', 'signed_out', 'pdf_exported', 'entry_deleted',
    'entry_added', 'clocked_out', 'clocked_in', 'account_created',
  ]);
  const deleted = events.find((e) => e.action === 'entry_deleted');
  assert.equal(deleted.entry_id, entry.id);
  assert.deepEqual(deleted.details, {
    source: 'manual', clock_in: '2026-09-10T13:00:00.000Z', clock_out: '2026-09-10T21:30:00.000Z', hours: 8.5, was_active: false,
  });
  assert.equal(events.find((e) => e.action === 'pdf_exported').details.entries, 0);
  assert.equal(events.find((e) => e.action === 'clocked_out').details.source, 'clock');
  assert.equal(events.find((e) => e.action === 'entry_added').details.source, 'manual');
  assert.ok(events[0].ip);

  // Paging and filtering
  const page1 = await (await call('/api/activity?limit=4')).json();
  assert.equal(page1.events.length, 4);
  assert.equal(page1.has_more, true);
  const page2 = await (await call(`/api/activity?limit=100&before=${page1.events.at(-1).id}`)).json();
  assert.equal(page2.events.length, 5);
  const onlyDeletes = await (await call('/api/activity?action=entry_deleted')).json();
  assert.deepEqual(onlyDeletes.events.map((e) => e.action), ['entry_deleted']);

  // CSV export
  const csv = await (await call('/api/activity.csv?tz=America/Chicago')).text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 10);
  assert.match(lines[0], /^Event #,Time \(UTC\),Time \(America\/Chicago\),Action/);
  assert.match(csv, /entry_deleted,\d+,Manual,2026-09-10T13:00:00.000Z,2026-09-10T21:30:00.000Z,8.5/);
  assert.match(csv, /clocked_out,\d+,Live clock,/);

  // Users only see their own log, and there is no way to change it
  await call('/api/logout', { method: 'POST' });
  await call('/api/register', { method: 'POST', body: { email: 'other2@x.co', password: 'pw' } });
  assert.deepEqual((await (await call('/api/activity')).json()).events.map((e) => e.action), ['account_created']);
  assert.equal((await call('/api/activity/1', { method: 'DELETE' })).status, 404);
});

test('profile: name, photo, email, password, delete data, delete account', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'p@x.co', password: 'pw' } });
  const json = async (res) => ({ status: res.status, ...(await res.json()) });

  // Name
  let r = await json(await call('/api/profile', { method: 'PATCH', body: { name: '  Kamden   Aberle ' } }));
  assert.equal(r.user.name, 'Kamden Aberle');
  assert.equal((await call('/api/profile', { method: 'PATCH', body: { name: 'x'.repeat(81) } })).status, 400);

  // Photo
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await json(await call('/api/profile/photo', { method: 'PUT', body: { photo: png } }));
  assert.equal(r.user.avatar, png);
  assert.equal((await call('/api/profile/photo', { method: 'PUT', body: { photo: 'data:text/html;base64,PGI+' } })).status, 400);
  assert.equal((await call('/api/profile/photo', { method: 'PUT', body: { photo: 'data:image/png;base64,' + 'A'.repeat(400_001) } })).status, 400);
  assert.equal((await json(await call('/api/me'))).user.avatar, png);
  r = await json(await call('/api/profile/photo', { method: 'DELETE' }));
  assert.equal(r.user.avatar, null);

  // Email
  await call('/api/logout', { method: 'POST' });
  await call('/api/register', { method: 'POST', body: { email: 'taken@x.co', password: 'pw' } });
  await call('/api/logout', { method: 'POST' });
  await call('/api/login', { method: 'POST', body: { email: 'p@x.co', password: 'pw' } });
  assert.equal((await call('/api/profile/email', { method: 'POST', body: { email: 'new@x.co', current_password: 'bad' } })).status, 401);
  assert.equal((await call('/api/profile/email', { method: 'POST', body: { email: 'taken@x.co', current_password: 'pw' } })).status, 409);
  r = await json(await call('/api/profile/email', { method: 'POST', body: { email: 'New@X.co', current_password: 'pw' } }));
  assert.equal(r.user.email, 'new@x.co');

  // Password: wrong current rejected; success keeps this session, revokes old cookies
  const oldCookie = call.cookie();
  assert.equal((await call('/api/profile/password', { method: 'POST', body: { current_password: 'bad', new_password: 'pw2' } })).status, 401);
  assert.equal((await call('/api/profile/password', { method: 'POST', body: { current_password: 'pw', new_password: 'pw2' } })).status, 200);
  assert.equal((await call('/api/me')).status, 200, 'current device stays signed in');
  assert.equal((await call('/api/me', { cookie: oldCookie })).status, 401, 'other sessions signed out');
  await call('/api/logout', { method: 'POST' });
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'new@x.co', password: 'pw' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'new@x.co', password: 'pw2' } })).status, 200);

  // Check the profile changes were logged before wiping
  const { events } = await json(await call('/api/activity'));
  for (const a of ['name_changed', 'photo_updated', 'photo_removed', 'email_changed', 'password_changed']) {
    assert.ok(events.some((e) => e.action === a), a);
  }
  assert.deepEqual(events.find((e) => e.action === 'email_changed').details, { from: 'p@x.co', to: 'new@x.co' });

  // Delete all data: entries AND activity log wiped, account kept
  await call('/api/clock-in', { method: 'POST' });
  await call('/api/clock-out', { method: 'POST' });
  await call('/api/entries', { method: 'POST', body: { clock_in: '2026-09-10T13:00:00.000Z', clock_out: '2026-09-10T17:00:00.000Z' } });
  assert.equal((await call('/api/profile/delete-data', { method: 'POST', body: { confirm: 'yes' } })).status, 400);
  r = await json(await call('/api/profile/delete-data', { method: 'POST', body: { confirm: 'DELETE' } }));
  assert.equal(r.deleted, 2);
  const all = 'from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z';
  assert.equal((await json(await call(`/api/entries?${all}`))).entries.length, 0);
  assert.equal((await json(await call('/api/activity'))).events.length, 0, 'activity log wiped');
  assert.equal((await json(await call('/api/me'))).user.name, 'Kamden Aberle', 'account kept');
  // Logging carries on afterwards
  await call('/api/clock-in', { method: 'POST' });
  assert.deepEqual((await json(await call('/api/activity'))).events.map((e) => e.action), ['clocked_in']);

  // Delete account
  await call('/api/clock-in', { method: 'POST' });
  assert.equal((await call('/api/profile/delete-account', { method: 'POST', body: { confirm: 'DELETE', password: 'bad' } })).status, 401);
  assert.equal((await call('/api/profile/delete-account', { method: 'POST', body: { confirm: 'no', password: 'pw2' } })).status, 400);
  assert.equal((await call('/api/profile/delete-account', { method: 'POST', body: { confirm: 'DELETE', password: 'pw2' } })).status, 200);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'new@x.co', password: 'pw2' } })).status, 401);
  const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM activity a JOIN users u ON u.id = a.user_id WHERE u.email = 'new@x.co'");
  assert.equal(Number(n), 0);
  const left = await db.query('SELECT COUNT(*) AS n FROM entries WHERE user_id NOT IN (SELECT id FROM users)');
  assert.equal(Number(left[0].n), 0, 'no orphaned entries');
  // the other account is untouched
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'taken@x.co', password: 'pw' } })).status, 200);
});

test('PDF export for "all time" uses the span of the entries', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'all@x.co', password: 'pw' } });
  await call('/api/entries', { method: 'POST', body: { clock_in: '2026-03-02T15:00:00.000Z', clock_out: '2026-03-02T20:00:00.000Z' } });
  await call('/api/entries', { method: 'POST', body: { clock_in: '2026-09-10T13:00:00.000Z', clock_out: '2026-09-10T17:00:00.000Z' } });
  const res = await call('/api/export.pdf?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z&tz=UTC&all=1');
  assert.equal(res.status, 200);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pageCount(pdf), 1);
  const { events } = await (await call('/api/activity?action=pdf_exported')).json();
  assert.equal(events[0].details.all, true);
  assert.equal(events[0].details.entries, 2);
  assert.equal(events[0].details.total_hours, 9);
});

test('dashboard period preference is saved to the account', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'pref@x.co', password: 'pw' } });
  assert.deepEqual((await (await call('/api/me')).json()).user.prefs, {});
  const put = (body) => call('/api/profile/prefs', { method: 'PUT', body });
  assert.equal((await put({ period: 'week' })).status, 200);
  assert.deepEqual((await (await call('/api/me')).json()).user.prefs, { period: 'week' });
  assert.equal((await put({ period: 'weeks:9' })).status, 400);
  assert.equal((await put({ period: 'custom', custom_from: '2026-09-30', custom_to: '2026-09-01' })).status, 400);
  assert.equal((await put({ period: 'custom', custom_from: '2026-09-01', custom_to: '2026-09-30', extra: 1 })).status, 200);
  // survives signing out and back in (e.g. another device)
  await call('/api/logout', { method: 'POST' });
  const { user } = await (await call('/api/login', { method: 'POST', body: { email: 'pref@x.co', password: 'pw' } })).json();
  assert.deepEqual(user.prefs, { period: 'custom', custom_from: '2026-09-01', custom_to: '2026-09-30' });
});

test('edit an entry: fix a forgotten clock-out; becomes manual and is logged', async (t) => {
  const { db, server, call } = await startServer();
  t.after(() => { server.close(); db.end(); });
  await call('/api/register', { method: 'POST', body: { email: 'edit@x.co', password: 'pw' } });
  // A live shift that was never clocked out (simulate: started yesterday)
  const start = new Date(Date.now() - 30 * 3_600_000).toISOString();
  await db.query("INSERT INTO entries (user_id, clock_in, source) VALUES (1, $1, 'clock')", [start]);
  const [{ id }] = await db.query('SELECT id FROM entries');
  const other = await (await call('/api/entries', { method: 'POST', body: {
    clock_in: new Date(Date.now() - 50 * 3_600_000).toISOString(), clock_out: new Date(Date.now() - 45 * 3_600_000).toISOString() } })).json();
  const patch = (eid, body) => call(`/api/entries/${eid}`, { method: 'PATCH', body });
  const out = new Date(Date.parse(start) + 8.5 * 3_600_000).toISOString();

  assert.equal((await patch(id, { clock_in: start, clock_out: start })).status, 400);
  assert.equal((await patch(id, { clock_in: start, clock_out: new Date(Date.now() + 3_600_000).toISOString() })).status, 400, 'future');
  assert.equal((await patch(id, { clock_in: other.entry.clock_in, clock_out: out })).status, 409, 'overlaps the other shift');
  assert.equal((await patch(99999, { clock_in: start, clock_out: out })).status, 404);

  const res = await patch(id, { clock_in: start, clock_out: out });
  assert.equal(res.status, 200);
  const { entry } = await res.json();
  assert.equal(entry.clock_out, out);
  assert.equal(entry.source, 'manual');
  assert.equal((await (await call('/api/status')).json()).active, null, 'no longer clocked in');
  // Editing its own time range does not count as overlapping itself
  assert.equal((await patch(id, { clock_in: start, clock_out: new Date(Date.parse(out) - 600_000).toISOString() })).status, 200);

  const { events } = await (await call('/api/activity?action=entry_edited')).json();
  assert.equal(events.length, 2);
  const first = events[1];
  assert.equal(first.entry_id, id);
  assert.equal(first.details.before.source, 'clock');
  assert.equal(first.details.before.was_active, true);
  assert.equal(first.details.before.clock_out, null);
  assert.equal(first.details.clock_out, out);
  assert.equal(first.details.hours, 8.5);
  assert.equal(first.details.source, 'manual');

  // Someone else can't edit it
  await call('/api/logout', { method: 'POST' });
  await call('/api/register', { method: 'POST', body: { email: 'edit2@x.co', password: 'pw' } });
  assert.equal((await patch(id, { clock_in: start, clock_out: out })).status, 404);
});
