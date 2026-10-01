const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

// Fonts ship with the app (Liberation Sans, SIL OFL 1.1, metric-compatible with
// Helvetica). PDFKit's built-in fonts are loaded with a dynamic require that
// Vercel's bundler can't see, so on Vercel they're missing ("Cannot find module
// .../standard-fonts/Helvetica.cjs"). Reading these with plain path.join keeps
// them in the bundle, and passing one as the default font means PDFKit never
// touches its built-in fonts at all.
const FONTS = {
  regular: fs.readFileSync(path.join(__dirname, 'fonts', 'LiberationSans-Regular.ttf')),
  bold: fs.readFileSync(path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf')),
  italic: fs.readFileSync(path.join(__dirname, 'fonts', 'LiberationSans-Italic.ttf')),
};

const PAGE = { width: 612, height: 792 }; // US Letter, portrait (points)
const MARGIN = 56;

function makeFormatters(tz) {
  const opts = (o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o });
  return {
    date: opts({ month: 'short', day: 'numeric', year: 'numeric' }),
    dayDate: opts({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    time: opts({ hour: 'numeric', minute: '2-digit' }),
  };
}

function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / 3_600_000;
}

function fmtHours(h) {
  return h.toFixed(2);
}

function fmtHM(h) {
  const totalMin = Math.round(h * 60);
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`;
}

/**
 * Builds the entry rows with per-shift and running (cumulative) hours.
 * Open shifts (still clocked in) are counted up to `now`.
 */
function buildRows(entries, now = new Date()) {
  let cumulative = 0;
  return entries.map((e) => {
    const end = e.clock_out || now.toISOString();
    const hours = Math.max(0, hoursBetween(e.clock_in, end));
    cumulative += hours;
    return { ...e, hours, cumulative, active: !e.clock_out };
  });
}

/**
 * Renders a single-page US Letter portrait PDF and pipes it to `stream`.
 * `name` is shown at the top (falls back to `email`).
 * `from`/`to` are ISO instants (to is exclusive); `tz` is an IANA time zone.
 * `rangeText` optionally replaces the computed date-range label (used for "all time").
 */
function renderReport(stream, { name, email, from, to, tz, entries, now = new Date(), rangeText }) {
  const f = makeFormatters(tz);
  const rows = buildRows(entries, now);
  const total = rows.length ? rows[rows.length - 1].cumulative : 0;
  const title = (name && name.trim()) || email;

  // Margins are handled manually so PDFKit never adds a second page.
  const doc = new PDFDocument({
    font: FONTS.regular, // instead of the built-in Helvetica (see FONTS above)
    size: 'LETTER',
    layout: 'portrait',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: { Title: `${title} – Time report`, Author: title },
  });
  doc.registerFont('Regular', FONTS.regular);
  doc.registerFont('Bold', FONTS.bold);
  doc.registerFont('Italic', FONTS.italic);
  doc.pipe(stream);

  const INK = '#111111';
  const MUTED = '#8a8f98';
  const RULE = '#e4e6ea';
  const M = MARGIN;
  const W = PAGE.width - M * 2;
  const text = (str, x, y, o = {}) => doc.text(str, x, y, { lineBreak: false, ...o });
  const label = (str, x, y, o = {}) => {
    doc.font('Regular').fontSize(7.5).fillColor(MUTED);
    text(str.toUpperCase(), x, y, { characterSpacing: 0.8, ...o });
  };
  const rule = (y, color = RULE, width = 0.75) => {
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(width).strokeColor(color).stroke();
  };

  // ---- Header: name, then period (left) and total (right) ----
  let y = M;
  doc.font('Bold').fontSize(22).fillColor(INK);
  text(title, M, y, { width: W, ellipsis: true });
  y += 30;
  doc.font('Regular').fontSize(10).fillColor(MUTED);
  text('Time report', M, y);
  y += 34;

  const lastInstant = new Date(new Date(to).getTime() - 1);
  const startLabel = f.date.format(new Date(from));
  const endLabel = f.date.format(lastInstant);
  const rangeLabel = rangeText || (startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`);

  label('Period', M, y);
  label('Total hours', M, y, { width: W, align: 'right' });
  y += 13;
  doc.font('Regular').fontSize(12).fillColor(INK);
  text(rangeLabel, M, y + 4, { width: W * 0.6, ellipsis: true });
  doc.font('Bold').fontSize(18);
  text(fmtHours(total), M, y, { width: W, align: 'right' });
  y += 24;
  doc.font('Regular').fontSize(8.5).fillColor(MUTED);
  text(`${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`, M, y);
  text(fmtHM(total), M, y, { width: W, align: 'right' });
  y += 22;
  rule(y, '#cfd3d9');
  y += 22;

  // ---- Table ----
  const cols = [
    { key: 'date', label: 'Date', w: 0.34, align: 'left' },
    { key: 'in', label: 'Clock in', w: 0.18, align: 'left' },
    { key: 'out', label: 'Clock out', w: 0.18, align: 'left' },
    { key: 'hours', label: 'Hours', w: 0.14, align: 'right' },
    { key: 'cum', label: 'Cumulative', w: 0.16, align: 'right' },
  ];
  let cx = M;
  for (const c of cols) { c.x = cx; c.px = c.w * W; cx += c.px; }
  const cell = (c, str, y0, o = {}) => text(String(str), c.x, y0, { width: c.px, align: c.align, ellipsis: true, ...o });

  for (const c of cols) { label(c.label, c.x, y, { width: c.px, align: c.align }); }
  y += 14;
  rule(y);

  // Pick a font size / row height so every row (plus the total line) fits on the page.
  const footerY = PAGE.height - M + 4;
  const available = footerY - 24 - y - 30; // keep room for the total line
  let fontSize = 9.5;
  let rowH = 20;
  while (rows.length * rowH > available && fontSize > 6) {
    fontSize -= 0.5;
    rowH = fontSize * 1.9;
  }
  const maxRows = Math.floor(available / rowH);
  let shown = rows;
  let hidden = 0;
  if (rows.length > maxRows) {
    shown = rows.slice(0, maxRows - 1); // leave a line for the "more" note
    hidden = rows.length - shown.length;
  }

  if (rows.length === 0) {
    doc.font('Regular').fontSize(10).fillColor(MUTED);
    text('No time recorded in this period.', M, y + 14);
    y += 36;
  }
  const textOffset = (rowH - fontSize) / 2;
  for (const r of shown) {
    const inD = new Date(r.clock_in);
    doc.font('Regular').fontSize(fontSize).fillColor(INK);
    cell(cols[0], f.dayDate.format(inD), y + textOffset);
    cell(cols[1], f.time.format(inD), y + textOffset);
    if (r.active) doc.fillColor(MUTED);
    cell(cols[2], r.active ? 'In progress' : f.time.format(new Date(r.clock_out)), y + textOffset);
    doc.fillColor(INK);
    cell(cols[3], fmtHours(r.hours), y + textOffset);
    doc.fillColor(MUTED);
    cell(cols[4], fmtHours(r.cumulative), y + textOffset);
    y += rowH;
    rule(y, '#f0f1f3', 0.5);
  }
  if (hidden > 0) {
    doc.font('Italic').fontSize(8.5).fillColor(MUTED);
    text(`+ ${hidden} more ${hidden === 1 ? 'entry' : 'entries'} not shown (included in the total)`, M, y + 6);
    y += 20;
  }

  // Total line
  if (rows.length) {
    rule(y, '#cfd3d9');
    y += 9;
    doc.font('Bold').fontSize(Math.max(fontSize, 9)).fillColor(INK);
    cell(cols[0], 'Total', y);
    cell(cols[4], fmtHours(total), y);
  }

  // ---- Footer ----
  const generated = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(now);
  doc.font('Regular').fontSize(7.5).fillColor('#a3a8b0');
  text(`Generated ${generated}`, M, footerY);
  text(`Times in ${tz.replace(/_/g, ' ')} · decimal hours`, M, footerY, { width: W, align: 'right' });

  doc.end();
  return { total, count: rows.length };
}

// Renders the report fully in memory. Sending a complete buffer (with a
// Content-Length) is more reliable on serverless hosts than streaming, and
// means a failure can still be reported as a normal error.
function renderReportBuffer(opts) {
  return new Promise((resolve, reject) => {
    const { PassThrough } = require('node:stream');
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', (c) => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      renderReport(sink, opts);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderReport, renderReportBuffer, buildRows, fmtHM };
