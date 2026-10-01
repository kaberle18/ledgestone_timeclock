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
const toMonthInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
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

function rangeLabel({ from, to }) {
  const last = addDays(to, -1);
  const a = fmtDate.format(from), b = fmtDate.format(last);
  return a === b ? fmtDay.format(from) + ', ' + from.getFullYear() : `${a} – ${b}`;
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

function renderClock() {
  const btn = $('clock-btn');
  if (state.active) {
    $('clock-status').textContent = 'Clocked in';
    $('clock-status').className = 'status in';
    const since = new Date(state.active.clock_in);
    $('clock-since').textContent = `Since ${fmtTime.format(since)} on ${fmtDay.format(since)}`;
    $('clock-elapsed').textContent = fmtElapsed(Date.now() - since);
    btn.textContent = 'Clock Out';
    btn.className = 'btn big danger';
  } else {
    $('clock-status').textContent = 'Clocked out';
    $('clock-status').className = 'status out';
    $('clock-since').textContent = 'Press Clock In to start your shift.';
    $('clock-elapsed').textContent = '';
    btn.textContent = 'Clock In';
    btn.className = 'btn big primary';
  }
}

function renderFilters() {
  $('period-select').value = state.period;
  const isMonth = state.period === 'month';
  $('pick-date').hidden = isMonth;
  $('pick-month').hidden = !isMonth;
  $('pick-weeks').hidden = state.period !== 'weeks';
  $('pick-date').value = toDateInput(state.anchor);
  $('pick-month').value = toMonthInput(state.anchor);
  $('pick-weeks').value = String(state.weeks);
  $('range-label').textContent = rangeLabel(currentRange());
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
}

// ---------- data ----------
async function refreshStatus() {
  const { active } = await api('/api/status');
  state.active = active;
  renderClock();
}

let loadSeq = 0;
async function loadEntries() {
  renderFilters();
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

$('period-select').addEventListener('change', (e) => {
  state.period = e.target.value;
  loadEntries();
});

$('pick-date').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.anchor = parseDateInput(e.target.value);
  loadEntries();
});
$('pick-month').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.anchor = parseDateInput(e.target.value);
  loadEntries();
});
$('pick-weeks').addEventListener('change', (e) => {
  state.weeks = Number(e.target.value);
  loadEntries();
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

// Crops the chosen image to a centered square and shrinks it to 256px JPEG.
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image this browser can read")); };
    img.src = url;
  });
}

$('photo-upload').addEventListener('click', () => $('photo-input').click());
$('photo-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const photo = await resizePhoto(file);
    const { user } = await api('/api/profile/photo', { method: 'PUT', body: { photo } });
    setUser(user);
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
    : 'Confirm you want to delete all data. Every clock-in/clock-out entry will be permanently deleted and your totals will go to zero. Your account and activity log are kept. This cannot be undone.';
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
      alert(`Deleted ${deleted} ${deleted === 1 ? 'entry' : 'entries'}.`);
    }
  } catch (err) {
    $('danger-error').textContent = err.message;
    $('danger-error').hidden = false;
    dangerReady();
  }
});

// Live elapsed timer while clocked in.
setInterval(() => {
  if (!state.active) return;
  $('clock-elapsed').textContent = fmtElapsed(Date.now() - new Date(state.active.clock_in));
}, 1000);

// ---------- boot ----------
api('/api/me')
  .then(({ user }) => { state.user = user; showApp(); })
  .catch(showAuth);
