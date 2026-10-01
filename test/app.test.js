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
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
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
    clock_in: '2026-09-10T13:00:00.000Z', clock_out: '2026-09-10T21:30:00.000Z', hours: 8.5, was_active: false,
  });
  assert.equal(events.find((e) => e.action === 'pdf_exported').details.entries, 0);
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
  assert.match(csv, /entry_deleted,\d+,2026-09-10T13:00:00.000Z,2026-09-10T21:30:00.000Z,8.5/);

  // Users only see their own log, and there is no way to change it
  await call('/api/logout', { method: 'POST' });
  await call('/api/register', { method: 'POST', body: { email: 'other2@x.co', password: 'pw' } });
  assert.deepEqual((await (await call('/api/activity')).json()).events.map((e) => e.action), ['account_created']);
  assert.equal((await call('/api/activity/1', { method: 'DELETE' })).status, 404);
});
