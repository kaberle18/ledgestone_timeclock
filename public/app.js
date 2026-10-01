// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${res.status})`), { status: res.status });
  return data;
}

const pad2 = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDateInput = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d) => addDays(d, -d.getDay()); // weeks start Sunday

const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const hoursBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / 3_600_000);
function fmtHM(h) {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

// ---------- state ----------
const state = {
  user: null,
  active: null,      // open entry while clocked in
  period: 'day',     // day | week | weeks | month
  anchor: new Date(),
  weeks: 2,
  entries: [],
};

// Computes [from, to) in local time for the current filter.
function currentRange() {
  const a = state.anchor;
  let from, to;
  switch (state.period) {
    case 'day':
      from = new Date(a.getFullYear(), a.getMonth(), a.getDate());
      to = addDays(from, 1);
      break;
    case 'week':
      from = startOfWeek(a);
      to = addDays(from, 7);
      break;
    case 'weeks':
      from = startOfWeek(a);
      to = addDays(from, 7 * state.weeks);
      break;
    case 'month':
      from = new Date(a.getFullYear(), a.getMonth(), 1);
      to = new Date(a.getFullYear(), a.getMonth() + 1, 1);
      break;
  }
  return { from, to };
}

const fmtMonthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fmtMonthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

// Friendly label for the selected period, e.g. "October 2026" or "Sep 27 – Oct 3, 2026".
function rangeLabel({ from, to }) {
  const last = addDays(to, -1);
  if (state.period === 'month') return fmtMonthYear.format(from);
  if (state.period === 'day') return `${fmtDay.format(from)}, ${from.getFullYear()}`;
  if (from.getFullYear() === last.getFullYear()) {
    return `${fmtMonthDay.format(from)} – ${fmtMonthDay.format(last)}, ${last.getFullYear()}`;
  }
  return `${fmtDate.format(from)} – ${fmtDate.format(last)}`;
}

function shiftAnchor(dir) {
  const a = state.anchor;
  const step = { day: 1, week: 7, weeks: 7 * state.weeks }[state.period];
  state.anchor = step ? addDays(a, dir * step) : new Date(a.getFullYear(), a.getMonth() + dir, 1);
  loadEntries();
}

// ---------- views ----------
function showAuth() {
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
}

function showApp() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  renderUser();
  refreshStatus();
  route(); // loads the current tab's data
}

// ---------- top-bar sections (Dashboard / Data) ----------
function route() {
  const view = { '#data': 'data', '#profile': 'profile' }[location.hash] || 'dashboard';
  $('dashboard-view').hidden = view !== 'dashboard';
  $('data-view').hidden = view !== 'data';
  $('profile-view').hidden = view !== 'profile';
  document.querySelectorAll('.nav-tab').forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (!state.user) return;
  if (view === 'data') loadActivity();
  else if (view === 'profile') renderProfile();
  else loadEntries();
}
window.addEventListener('hashchange', route);

const fmtClockTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtLongDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const ICON_PLAY = '<path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>';
const ICON_STOP = '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>';

// Today's hours (local day), including the shift in progress.
function todayHours() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = addDays(start, 1);
  const now = Date.now();
  return (state.todayEntries || []).reduce((sum, e) => {
    const a = Math.max(new Date(e.clock_in).getTime(), start.getTime());
    const b = Math.min(e.clock_out ? new Date(e.clock_out).getTime() : now, end.getTime());
    return sum + Math.max(0, b - a) / 3_600_000;
  }, 0);
}

// Updates the parts of the clock card that change every second.
function tickClock() {
  const now = new Date();
  if (state.active) {
    $('clock-big').textContent = fmtElapsed(now - new Date(state.active.clock_in));
  } else {
    $('clock-big').textContent = fmtClockTime.format(now);
    $('clock-sub').textContent = fmtLongDate.format(now);
  }
  $('today-hours').textContent = todayHours().toFixed(2);
}

function renderClock() {
  const btn = $('clock-btn');
  const on = !!state.active;
  $('clock-card').dataset.state = on ? 'in' : 'out';
  $('clock-status').textContent = on ? 'On the clock' : 'Clocked out';
  if (on) {
    const since = new Date(state.active.clock_in);
    const sameDay = since.toDateString() === new Date().toDateString();
    $('clock-sub').textContent = `Started ${fmtTime.format(since)}${sameDay ? '' : ` on ${fmtDay.format(since)}`}`;
  }
  $('clock-btn-text').textContent = on ? 'Clock Out' : 'Clock In';
  $('clock-icon').innerHTML = on ? ICON_STOP : ICON_PLAY;
  btn.className = `clock-btn ${on ? 'out' : 'in'}`;
  tickClock();
}

// Loads entries that touch today (a shift from last night can run into today).
async function loadToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const qs = new URLSearchParams({ from: addDays(start, -1).toISOString(), to: addDays(start, 1).toISOString() });
  try {
    state.todayEntries = (await api(`/api/entries?${qs}`)).entries;
  } catch { /* the card still works without it */ }
  tickClock();
}

function renderFilters() {
  $('period-select').value = state.period === 'weeks' ? `weeks:${state.weeks}` : state.period;
  $('pick-date').value = toDateInput(state.anchor);
  const range = currentRange();
  $('range-label').textContent = rangeLabel(range);
  // "Back to today" only shows once you've moved away from the current period.
  const now = new Date();
  $('today').hidden = now >= range.from && now < range.to;
  $('today-text').textContent = { day: 'Today', week: 'This week', weeks: 'This week', month: 'This month' }[state.period];
  $('today').title = 'Jump back to the current period';
}

function renderEntries() {
  const tbody = $('entries');
  tbody.innerHTML = '';
  let cumulative = 0;
  const now = new Date().toISOString();
  for (const e of state.entries) {
    const hours = hoursBetween(e.clock_in, e.clock_out || now);
    cumulative += hours;
    const tr = document.createElement('tr');
    const cells = [
      fmtDay.format(new Date(e.clock_in)),
      fmtTime.format(new Date(e.clock_in)),
      e.clock_out ? fmtTime.format(new Date(e.clock_out)) : 'In progress',
      hours.toFixed(2),
      cumulative.toFixed(2),
    ];
    // Column classes double as grid areas for the stacked mobile layout.
    const classes = ['c-date', 'c-in', 'c-out', 'c-hours num', 'c-cum num'];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      td.className = classes[i] + (i === 2 && !e.clock_out ? ' active' : '');
      if (i === 0 && e.source === 'manual') {
        const tag = document.createElement('span');
        tag.className = 'tag-manual';
        tag.textContent = 'Manual';
        tag.title = 'Logged by hand (not a live clock in/out)';
        td.appendChild(tag);
      }
      tr.appendChild(td);
    });
    const actions = document.createElement('td');
    actions.className = 'actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn delete';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete entry from ${cells[0]}, ${cells[1]}`);
    del.addEventListener('click', () => deleteEntry(e));
    actions.appendChild(del);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  $('empty').hidden = state.entries.length > 0;
  $('total-hours').textContent = cumulative.toFixed(2);
  $('total-hm').textContent = `(${fmtHM(cumulative)})`;
  $('entry-count').textContent = String(state.entries.length);
}

// ---------- data ----------
async function refreshStatus() {
  const { active } = await api('/api/status');
  state.active = active;
  renderClock();
  loadToday();
}

let loadSeq = 0;
async function loadEntries() {
  renderFilters();
  loadToday(); // entries may have changed today's total
  const { from, to } = currentRange();
  const seq = ++loadSeq;
  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const { entries } = await api(`/api/entries?${qs}`);
  if (seq !== loadSeq) return; // a newer request superseded this one
  state.entries = entries;
  renderEntries();
}

// ---------- events ----------
let authMode = 'login';
document.querySelectorAll('#auth-view .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll('#auth-view .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('auth-submit').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
    $('auth-form').password.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    $('auth-error').hidden = true;
  });
});

$('auth-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  $('auth-error').hidden = true;
  $('auth-submit').disabled = true;
  try {
    const { user } = await api(authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      body: { email: form.email.value, password: form.password.value },
    });
    state.user = user;
    form.reset();
    showApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  state.user = null;
  state.active = null;
  history.replaceState(null, '', location.pathname); // next sign-in starts on the Dashboard
  showAuth();
});

$('clock-btn').addEventListener('click', async () => {
  const btn = $('clock-btn');
  btn.disabled = true;
  try {
    const res = await api(state.active ? '/api/clock-out' : '/api/clock-in', { method: 'POST' });
    state.active = res.active;
  } catch (err) {
    if (err.status === 401) return showAuth();
    alert(err.message);
    await refreshStatus();
  } finally {
    btn.disabled = false;
  }
  renderClock();
  loadEntries();
});

// Values are "day", "week", "month" or "weeks:<n>" (a multi-week span).
$('period-select').addEventListener('change', (e) => {
  const [period, n] = e.target.value.split(':');
  state.period = period;
  if (n) state.weeks = Number(n);
  loadEntries();
});

$('pick-date').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.anchor = parseDateInput(e.target.value);
  loadEntries();
});
// The range label opens the browser's calendar (via a hidden date input).
// In month mode any day picked selects that month.
const pickDate = $('pick-date');
const canShowPicker = typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;
if (!canShowPicker) pickDate.classList.add('overlay'); // older browsers: tap the input directly
$('range-button').addEventListener('click', () => {
  try {
    pickDate.showPicker();
  } catch {
    pickDate.focus();
    pickDate.click();
  }
});
$('prev').addEventListener('click', () => shiftAnchor(-1));
$('next').addEventListener('click', () => shiftAnchor(1));
$('today').addEventListener('click', () => { state.anchor = new Date(); loadEntries(); });

$('export').addEventListener('click', () => {
  const { from, to } = currentRange();
  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), tz });
  window.location.href = `/api/export.pdf?${qs}`;
});

// Shows the in-app delete confirmation; resolves true only if "Delete entry" is clicked.
function confirmDelete(e) {
  const inD = new Date(e.clock_in);
  const end = e.clock_out || new Date().toISOString();
  $('delete-date').textContent = fmtDay.format(inD) + ', ' + inD.getFullYear();
  $('delete-times').textContent = `${fmtTime.format(inD)} → ${e.clock_out ? fmtTime.format(new Date(e.clock_out)) : 'In progress'}`;
  $('delete-hours').textContent = `${hoursBetween(e.clock_in, end).toFixed(2)} hrs`;
  $('delete-warning').hidden = !!e.clock_out;
  const dialog = $('delete-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  $('delete-cancel').focus(); // safe default: Enter cancels
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true });
  });
}

async function deleteEntry(e) {
  if (!(await confirmDelete(e))) return;
  try {
    await api(`/api/entries/${e.id}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status === 401) return showAuth();
    alert(err.message);
  }
  await refreshStatus();
  loadEntries();
}

// ---------- add past entry ----------
// Reads the dialog's date + times (local time) into ISO instants.
function readEntryForm() {
  const f = $('entry-form');
  if (!f.date.value || !f.in.value || !f.out.value) return null;
  const [y, m, d] = f.date.value.split('-').map(Number);
  const at = (hhmm, dayOffset) => {
    const [h, min] = hhmm.split(':').map(Number);
    return new Date(y, m - 1, d + dayOffset, h, min);
  };
  const clockIn = at(f.in.value, 0);
  let clockOut = at(f.out.value, 0);
  if (clockOut <= clockIn) clockOut = at(f.out.value, 1); // overnight shift
  return { clockIn, clockOut };
}

function updateEntryPreview() {
  const r = readEntryForm();
  $('entry-preview').textContent = r
    ? `${fmtDay.format(r.clockIn)} ${fmtTime.format(r.clockIn)} → ${fmtDay.format(r.clockOut)} ${fmtTime.format(r.clockOut)} · ${hoursBetween(r.clockIn, r.clockOut).toFixed(2)} hrs`
    : '';
}

$('add-entry').addEventListener('click', () => {
  const f = $('entry-form');
  f.reset();
  // Default to the day being viewed (or today if that's in the future).
  const day = state.anchor > new Date() ? new Date() : state.anchor;
  f.date.value = toDateInput(day);
  f.date.max = toDateInput(new Date());
  $('entry-error').hidden = true;
  updateEntryPreview();
  $('entry-dialog').showModal();
});
$('entry-cancel').addEventListener('click', () => $('entry-dialog').close());
$('entry-form').addEventListener('input', updateEntryPreview);
$('entry-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = readEntryForm();
  if (!r) return;
  $('entry-error').hidden = true;
  $('entry-save').disabled = true;
  try {
    await api('/api/entries', {
      method: 'POST',
      body: { clock_in: r.clockIn.toISOString(), clock_out: r.clockOut.toISOString() },
    });
    $('entry-dialog').close();
    state.anchor = r.clockIn; // jump to the period containing the new entry
    loadEntries();
  } catch (err) {
    if (err.status === 401) { $('entry-dialog').close(); return showAuth(); }
    $('entry-error').textContent = err.message;
    $('entry-error').hidden = false;
  } finally {
    $('entry-save').disabled = false;
  }
});

// ---------- activity log (Data tab) ----------
const fmtStamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtStampTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// [badge label, badge color, small line under the badge]
const ACTION_INFO = {
  account_created: ['Account created', 'account'],
  signed_in: ['Signed in', 'account'],
  sign_in_failed: ['Failed sign-in', 'failed'],
  signed_out: ['Signed out', 'account'],
  clocked_in: ['Clock in', 'time', 'Live clock'],
  clocked_out: ['Clock out', 'time', 'Live clock'],
  entry_added: ['Manual entry', 'manual', 'Logged by hand'],
  entry_deleted: ['Entry deleted', 'deleted'],
  all_data_deleted: ['All data deleted', 'deleted'],
  pdf_exported: ['PDF exported', 'export'],
  name_changed: ['Name changed', 'account'],
  email_changed: ['Email changed', 'account'],
  password_changed: ['Password changed', 'account'],
  photo_updated: ['Photo updated', 'account'],
  photo_removed: ['Photo removed', 'account'],
};
const sourceLabel = (src) => (src === 'manual' ? 'manual (logged by hand)' : 'live clock');

function shiftText(d) {
  if (!d.clock_in) return '';
  const inD = new Date(d.clock_in);
  const out = d.clock_out ? fmtTime.format(new Date(d.clock_out)) : 'in progress';
  const outDay = d.clock_out && new Date(d.clock_out).toDateString() !== inD.toDateString()
    ? ` (${fmtDay.format(new Date(d.clock_out))})` : '';
  const hrs = d.hours != null ? ` · ${Number(d.hours).toFixed(2)} hrs` : '';
  return `${fmtDay.format(inD)}, ${inD.getFullYear()} · ${fmtTime.format(inD)} → ${out}${outDay}${hrs}`;
}

function describe(ev) {
  const d = ev.details || {};
  switch (ev.action) {
    case 'account_created': return `Account created for ${d.email || state.user.email}`;
    case 'signed_in': return 'Signed in';
    case 'sign_in_failed': return 'Someone tried to sign in with the wrong password';
    case 'signed_out': return 'Signed out';
    case 'clocked_in': return `Clocked in live at ${fmtTime.format(new Date(d.clock_in))} on ${fmtDay.format(new Date(d.clock_in))}`;
    case 'clocked_out': return `Clocked out live. Shift: ${shiftText(d)}`;
    case 'entry_added': return `Logged a past shift by hand: ${shiftText(d)}`;
    case 'entry_deleted':
      return `Deleted a ${d.source ? sourceLabel(d.source) + ' ' : ''}entry: ${shiftText(d)}${d.was_active ? ' (was the current shift)' : ''}`;
    case 'all_data_deleted':
      return `Deleted all time data: ${d.entries} ${d.entries === 1 ? 'entry' : 'entries'}, `
        + `${Number(d.total_hours).toFixed(2)} hrs (a copy of every deleted entry is kept in the CSV download)`;
    case 'name_changed': return d.to ? `Name changed from "${d.from || '(none)'}" to "${d.to}"` : `Name "${d.from}" removed`;
    case 'email_changed': return `Email changed from ${d.from} to ${d.to}`;
    case 'password_changed': return 'Password changed (other devices signed out)';
    case 'photo_updated': return 'Profile photo updated';
    case 'photo_removed': return 'Profile photo removed';
    case 'pdf_exported': {
      const first = fmtDate.format(new Date(d.from));
      const last = fmtDate.format(new Date(new Date(d.to).getTime() - 1));
      return `Exported PDF for ${first === last ? first : `${first} – ${last}`} · `
        + `${d.entries} ${d.entries === 1 ? 'entry' : 'entries'} · ${Number(d.total_hours).toFixed(2)} hrs`;
    }
    default: return ev.action;
  }
}

// Rough "Browser on OS" from the user-agent string.
function deviceText(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

const activity = { events: [], hasMore: false, seq: 0 };

async function loadActivity({ more = false } = {}) {
  const seq = ++activity.seq;
  const qs = new URLSearchParams({ limit: '100' });
  const filter = $('activity-filter').value;
  if (filter) qs.set('action', filter);
  if (more && activity.events.length) qs.set('before', activity.events[activity.events.length - 1].id);
  try {
    const { events, has_more } = await api(`/api/activity?${qs}`);
    if (seq !== activity.seq) return;
    activity.events = more ? activity.events.concat(events) : events;
    activity.hasMore = has_more;
    renderActivity();
  } catch (err) {
    if (err.status === 401) return showAuth();
    alert(err.message);
  }
}

function renderActivity() {
  const tbody = $('activity-rows');
  tbody.innerHTML = '';
  for (const ev of activity.events) {
    const tr = document.createElement('tr');
    const at = new Date(ev.at);
    const [label, kind] = ACTION_INFO[ev.action] || [ev.action, 'account'];

    const when = document.createElement('td');
    when.className = 'a-when';
    when.textContent = fmtStamp.format(at);
    const t = document.createElement('span');
    t.className = 'muted';
    t.textContent = fmtStampTime.format(at);
    when.appendChild(t);

    const action = document.createElement('td');
    action.className = 'a-action';
    const badge = document.createElement('span');
    badge.className = `badge ${kind}`;
    badge.textContent = label;
    action.appendChild(badge);
    if (ACTION_INFO[ev.action]?.[2]) {
      const sub = document.createElement('span');
      sub.className = 'badge-sub';
      sub.textContent = ACTION_INFO[ev.action][2];
      action.appendChild(sub);
    }

    const details = document.createElement('td');
    details.className = 'a-details';
    details.textContent = describe(ev);
    if (ev.entry_id != null) {
      const ref = document.createElement('span');
      ref.className = 'entry-ref';
      ref.textContent = ` · Entry #${ev.entry_id}`;
      details.appendChild(ref);
    }

    const device = document.createElement('td');
    device.className = 'a-device';
    device.textContent = deviceText(ev.user_agent);
    if (ev.ip) {
      const ip = document.createElement('span');
      ip.className = 'muted';
      ip.textContent = `IP ${ev.ip}`;
      device.appendChild(ip);
    }

    tr.append(when, action, details, device);
    tbody.appendChild(tr);
  }
  $('activity-empty').hidden = activity.events.length > 0;
  $('activity-more').hidden = !activity.hasMore;
}

$('activity-filter').addEventListener('change', () => loadActivity());
$('activity-more').addEventListener('click', () => loadActivity({ more: true }));
$('activity-csv').addEventListener('click', () => {
  window.location.href = `/api/activity.csv?${new URLSearchParams({ tz })}`;
});

// ---------- profile ----------
function paintAvatar(el, user) {
  if (user.avatar) {
    el.style.backgroundImage = `url("${user.avatar}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (user.name || user.email || '?').trim().charAt(0);
  }
}

// Top bar shows the photo (or initial) and name instead of the email.
function renderUser() {
  const u = state.user;
  $('top-name').textContent = u.name || '';
  paintAvatar($('top-avatar'), u);
  document.querySelector('.user-chip').title = `${u.name ? u.name + ' · ' : ''}${u.email}`;
}

function setUser(user) {
  state.user = user;
  renderUser();
  if (!$('profile-view').hidden) renderProfile();
}

function renderProfile() {
  const u = state.user;
  paintAvatar($('profile-avatar'), u);
  $('photo-remove').hidden = !u.avatar;
  $('name-form').name.value = u.name || '';
  $('current-email').textContent = u.email;
  $('member-since').textContent = `Member since ${fmtDate.format(new Date(u.created_at))}`;
}

function formMessage(form, text, ok) {
  const msg = form.querySelector('.form-msg');
  msg.textContent = text;
  msg.className = `form-msg ${ok ? 'ok' : 'err'}`;
  msg.hidden = !text;
}

// Wires a profile form: disables its button while saving and shows the result.
function profileForm(id, handler) {
  const form = $(id);
  form.addEventListener('input', () => formMessage(form, '', true));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      formMessage(form, await handler(form), true);
    } catch (err) {
      if (err.status === 401 && /signed in/i.test(err.message)) return showAuth();
      formMessage(form, err.message, false);
    } finally {
      btn.disabled = false;
    }
  });
}

profileForm('name-form', async (f) => {
  const { user } = await api('/api/profile', { method: 'PATCH', body: { name: f.name.value } });
  setUser(user);
  return 'Name saved.';
});

profileForm('email-form', async (f) => {
  const { user } = await api('/api/profile/email', {
    method: 'POST', body: { email: f.email.value, current_password: f.current_password.value },
  });
  f.reset();
  setUser(user);
  return `Email changed to ${user.email}.`;
});

profileForm('password-form', async (f) => {
  if (f.new_password.value !== f.confirm_password.value) throw new Error('New passwords do not match');
  await api('/api/profile/password', {
    method: 'POST', body: { current_password: f.current_password.value, new_password: f.new_password.value },
  });
  f.reset();
  return 'Password changed. Other devices have been signed out.';
});

// ----- Photo cropper: drag to position, zoom, circle shows the final avatar -----
const OUTPUT_SIZE = 256;   // saved avatar is 256x256 JPEG
const MAX_ZOOM = 4;
const crop = { img: null, url: null, view: 0, base: 1, zoom: 1, x: 0, y: 0, pointers: new Map(), pinch: null };

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image this browser can read")); };
    img.src = url;
  });
}

const cropScale = () => crop.base * crop.zoom;

// Keep the image covering the whole crop area (no empty edges inside the circle).
function clampCrop() {
  const s = cropScale();
  const w = crop.img.naturalWidth * s;
  const h = crop.img.naturalHeight * s;
  crop.x = Math.min(0, Math.max(crop.view - w, crop.x));
  crop.y = Math.min(0, Math.max(crop.view - h, crop.y));
}

// Zoom while keeping the point (px, py) of the crop area fixed (default: center).
function setZoom(zoom, px = crop.view / 2, py = crop.view / 2) {
  const before = cropScale();
  crop.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
  const after = cropScale();
  crop.x = px - ((px - crop.x) / before) * after;
  crop.y = py - ((py - crop.y) / before) * after;
  $('crop-zoom').value = String(crop.zoom);
  drawCrop();
}

// Source rectangle (in image pixels) that ends up inside the circle.
function cropSource() {
  const s = cropScale();
  return { sx: -crop.x / s, sy: -crop.y / s, size: crop.view / s };
}

function paintCanvas(canvas, size) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  const { sx, sy, size: ss } = cropSource();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.img, sx, sy, ss, ss, 0, 0, canvas.width, canvas.height);
}

let cropFrame = 0;
function drawCrop() {
  clampCrop();
  $('crop-img').style.transform = `translate(${crop.x}px, ${crop.y}px) scale(${cropScale()})`;
  cancelAnimationFrame(cropFrame);
  cropFrame = requestAnimationFrame(() => {
    paintCanvas($('crop-preview-lg'), 72);
    paintCanvas($('crop-preview-sm'), 34);
  });
}

function openCropper({ img, url }) {
  crop.img = img;
  crop.url = url;
  const el = $('crop-img');
  el.src = url;
  el.style.width = `${img.naturalWidth}px`;
  el.style.height = `${img.naturalHeight}px`;
  $('crop-error').hidden = true;
  $('crop-dialog').showModal();
  crop.view = $('crop-stage').clientWidth;
  crop.base = crop.view / Math.min(img.naturalWidth, img.naturalHeight);
  crop.zoom = 1;
  $('crop-zoom').value = '1';
  // start centered
  crop.x = (crop.view - img.naturalWidth * crop.base) / 2;
  crop.y = (crop.view - img.naturalHeight * crop.base) / 2;
  drawCrop();
  $('crop-stage').focus();
}

function closeCropper() {
  $('crop-dialog').close();
}
$('crop-dialog').addEventListener('close', () => {
  if (crop.url) URL.revokeObjectURL(crop.url);
  crop.url = null;
  crop.img = null;
  crop.pointers.clear();
  $('crop-img').removeAttribute('src');
});

// Dragging (mouse/touch/pen) and two-finger pinch zoom.
// Listeners sit on the frame (stage + dimmed margin) so you can drag from anywhere;
// coordinates are measured relative to the circle's square.
const stage = $('crop-stage');
const frame = $('crop-frame');
const stagePoint = (e) => {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (crop.view / r.width), y: (e.clientY - r.top) * (crop.view / r.height) };
};
frame.addEventListener('pointerdown', (e) => {
  if (!crop.img) return;
  frame.setPointerCapture(e.pointerId);
  crop.pointers.set(e.pointerId, stagePoint(e));
  crop.pinch = null;
  frame.classList.add('dragging');
});
frame.addEventListener('pointermove', (e) => {
  if (!crop.pointers.has(e.pointerId)) return;
  const prev = crop.pointers.get(e.pointerId);
  const now = stagePoint(e);
  crop.pointers.set(e.pointerId, now);
  if (crop.pointers.size === 1) {
    crop.x += now.x - prev.x;
    crop.y += now.y - prev.y;
    drawCrop();
  } else if (crop.pointers.size === 2) {
    const [a, b] = [...crop.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (crop.pinch) setZoom(crop.zoom * (dist / crop.pinch), mid.x, mid.y);
    crop.pinch = dist;
  }
});
const endPointer = (e) => {
  crop.pointers.delete(e.pointerId);
  crop.pinch = null;
  if (!crop.pointers.size) frame.classList.remove('dragging');
};
frame.addEventListener('pointerup', endPointer);
frame.addEventListener('pointercancel', endPointer);
frame.addEventListener('wheel', (e) => {
  if (!crop.img) return;
  e.preventDefault();
  const p = stagePoint(e);
  setZoom(crop.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
}, { passive: false });
// Arrow keys nudge, +/- zoom (keyboard users)
stage.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 20 : 5;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[e.key]) {
    crop.x += moves[e.key][0];
    crop.y += moves[e.key][1];
    drawCrop();
  } else if (e.key === '+' || e.key === '=') setZoom(crop.zoom * 1.1);
  else if (e.key === '-') setZoom(crop.zoom / 1.1);
  else return;
  e.preventDefault();
});
$('crop-zoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
$('crop-zoom-out').addEventListener('click', () => setZoom(crop.zoom / 1.2));
$('crop-zoom-in').addEventListener('click', () => setZoom(crop.zoom * 1.2));
$('crop-cancel').addEventListener('click', closeCropper);
$('crop-choose').addEventListener('click', () => $('photo-input').click());

$('crop-save').addEventListener('click', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  const { sx, sy, size } = cropSource();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.img, sx, sy, size, size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  const photo = canvas.toDataURL('image/jpeg', 0.88);
  $('crop-save').disabled = true;
  try {
    const { user } = await api('/api/profile/photo', { method: 'PUT', body: { photo } });
    setUser(user);
    closeCropper();
  } catch (err) {
    $('crop-error').textContent = err.message;
    $('crop-error').hidden = false;
  } finally {
    $('crop-save').disabled = false;
  }
});

$('photo-upload').addEventListener('click', () => $('photo-input').click());
$('photo-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const loaded = await loadImage(file);
    if ($('crop-dialog').open) closeCropper(); // "Choose another photo" from inside the cropper
    openCropper(loaded);
  } catch (err) {
    alert(err.message);
  }
});
$('photo-remove').addEventListener('click', async () => {
  try {
    const { user } = await api('/api/profile/photo', { method: 'DELETE' });
    setUser(user);
  } catch (err) {
    alert(err.message);
  }
});

// ----- Delete all data / delete account (typed confirmation) -----
let dangerAction = null;

function openDanger(kind) {
  const f = $('danger-form');
  f.reset();
  dangerAction = kind;
  const account = kind === 'account';
  $('danger-title').textContent = account ? 'Delete your account?' : 'Delete all data?';
  $('danger-text').textContent = account
    ? 'This permanently deletes your account, every clock-in/clock-out entry and your activity log, then signs you out. This cannot be undone.'
    : 'Confirm you want to delete all data. Every clock-in/clock-out entry and everything on the Data tab will be permanently deleted. Your account, name and photo are kept. This cannot be undone.';
  $('danger-password-label').hidden = !account;
  f.password.required = account;
  $('danger-confirm').textContent = account ? 'Delete account' : 'Delete all data';
  $('danger-confirm').disabled = true;
  $('danger-error').hidden = true;
  $('danger-dialog').showModal();
  f.confirm.focus();
}

function dangerReady() {
  const f = $('danger-form');
  const typed = f.confirm.value.trim() === 'DELETE';
  $('danger-confirm').disabled = !(typed && (dangerAction !== 'account' || f.password.value));
}

$('delete-data').addEventListener('click', () => openDanger('data'));
$('delete-account').addEventListener('click', () => openDanger('account'));
$('danger-cancel').addEventListener('click', () => $('danger-dialog').close());
$('danger-form').addEventListener('input', () => { $('danger-error').hidden = true; dangerReady(); });
$('danger-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  dangerReady();
  if ($('danger-confirm').disabled) return;
  const f = $('danger-form');
  $('danger-confirm').disabled = true;
  try {
    if (dangerAction === 'account') {
      await api('/api/profile/delete-account', { method: 'POST', body: { confirm: 'DELETE', password: f.password.value } });
      $('danger-dialog').close();
      state.user = null;
      state.active = null;
      history.replaceState(null, '', location.pathname);
      showAuth();
      alert('Your account has been deleted.');
    } else {
      const { deleted } = await api('/api/profile/delete-data', { method: 'POST', body: { confirm: 'DELETE' } });
      $('danger-dialog').close();
      await refreshStatus();
      alert(`All data deleted (${deleted} ${deleted === 1 ? 'entry' : 'entries'} and the activity log).`);
    }
  } catch (err) {
    $('danger-error').textContent = err.message;
    $('danger-error').hidden = false;
    dangerReady();
  }
});

// Live clock / elapsed timer and today's hours.
setInterval(() => { if (state.user) tickClock(); }, 1000);

// ---------- boot ----------
api('/api/me')
  .then(({ user }) => { state.user = user; showApp(); })
  .catch(showAuth);
