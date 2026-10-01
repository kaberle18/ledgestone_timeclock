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
const MARGIN = 50;

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
 * `from`/`to` are ISO instants (to is exclusive); `tz` is an IANA time zone.
 * `rangeText` optionally replaces the computed date-range label (used for "all time").
 */
function renderReport(stream, { email, from, to, tz, entries, now = new Date(), rangeText }) {
  const f = makeFormatters(tz);
  const rows = buildRows(entries, now);
  const total = rows.length ? rows[rows.length - 1].cumulative : 0;

  // Margins are handled manually so PDFKit never adds a second page.
  const doc = new PDFDocument({
    font: FONTS.regular, // instead of the built-in Helvetica (see FONTS above)
    size: 'LETTER',
    layout: 'portrait',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: { Title: 'Time Clock Report', Author: email },
  });
  doc.registerFont('Regular', FONTS.regular);
  doc.registerFont('Bold', FONTS.bold);
  doc.registerFont('Italic', FONTS.italic);
  doc.pipe(stream);

  const contentW = PAGE.width - MARGIN * 2;
  const text = (s, x, y, o = {}) => doc.text(s, x, y, { lineBreak: false, ...o });

  // ---- Header ----
  let y = MARGIN;
  doc.font('Bold').fontSize(20).fillColor('#111');
  text('Time Clock Report', MARGIN, y);
  doc.font('Regular').fontSize(10).fillColor('#555');
  text(email, MARGIN, y + 6, { width: contentW, align: 'right' });
  y += 34;

  const lastInstant = new Date(new Date(to).getTime() - 1);
  const startLabel = f.date.format(new Date(from));
  const endLabel = f.date.format(lastInstant);
  const rangeLabel = rangeText || (startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`);

  // Summary box: date range + total hours
  const boxH = 64;
  doc.roundedRect(MARGIN, y, contentW, boxH, 6).fillAndStroke('#f3f5f9', '#d5dbe5');
  doc.fillColor('#555').font('Regular').fontSize(9);
  text('DATE RANGE', MARGIN + 16, y + 14);
  text('TOTAL HOURS WORKED', MARGIN + contentW / 2 + 16, y + 14);
  doc.fillColor('#111').font('Bold').fontSize(16);
  text(rangeLabel, MARGIN + 16, y + 30, { width: contentW / 2 - 24, ellipsis: true });
  text(`${fmtHours(total)} hrs`, MARGIN + contentW / 2 + 16, y + 30);
  const totalW = doc.widthOfString(`${fmtHours(total)} hrs`);
  doc.font('Regular').fontSize(10).fillColor('#555');
  text(`(${fmtHM(total)}) · ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`,
    MARGIN + contentW / 2 + 22 + totalW, y + 35);
  y += boxH + 22;

  // ---- Transactions table ----
  const cols = [
    { key: 'n', label: '#', w: 0.06, align: 'left' },
    { key: 'date', label: 'Date', w: 0.28, align: 'left' },
    { key: 'in', label: 'Clock In', w: 0.17, align: 'left' },
    { key: 'out', label: 'Clock Out', w: 0.17, align: 'left' },
    { key: 'hours', label: 'Hours', w: 0.14, align: 'right' },
    { key: 'cum', label: 'Cumulative', w: 0.18, align: 'right' },
  ];
  let cx = MARGIN;
  for (const c of cols) { c.x = cx; c.px = c.w * contentW; cx += c.px; }
  const pad = 6;

  const drawCells = (vals) => {
    for (const c of cols) {
      text(String(vals[c.key]), c.x + pad, y, { width: c.px - pad * 2, align: c.align, ellipsis: true });
    }
  };

  doc.font('Bold').fontSize(10).fillColor('#111');
  text('Transactions', MARGIN, y);
  y += 18;

  // Pick a font size / row height so every row fits on the single page.
  const footerH = 30;
  const available = PAGE.height - MARGIN - footerH - y - 20; // minus header row
  let fontSize = 10;
  let rowH = 18;
  while (rows.length * rowH > available && fontSize > 6) {
    fontSize -= 0.5;
    rowH = fontSize * 1.75;
  }
  let maxRows = Math.floor(available / rowH);
  let shown = rows;
  let hidden = 0;
  if (rows.length > maxRows) {
    shown = rows.slice(0, maxRows - 1); // leave a line for the "more" note
    hidden = rows.length - shown.length;
  }

  // Header row
  doc.rect(MARGIN, y - 5, contentW, 20).fill('#1f2a44');
  doc.fillColor('#fff').font('Bold').fontSize(9);
  drawCells(Object.fromEntries(cols.map((c) => [c.key, c.label])));
  y += 20;

  doc.font('Regular').fontSize(fontSize);
  if (rows.length === 0) {
    doc.fillColor('#777');
    text('No clock-in/clock-out activity in this date range.', MARGIN + pad, y + 4);
  }
  shown.forEach((r, i) => {
    if (i % 2 === 1) doc.rect(MARGIN, y - (rowH - fontSize) / 2, contentW, rowH).fill('#f6f7fa');
    doc.fillColor('#111');
    const inD = new Date(r.clock_in);
    drawCells({
      n: i + 1,
      date: f.dayDate.format(inD),
      in: f.time.format(inD),
      out: r.active ? 'In progress' : f.time.format(new Date(r.clock_out)),
      hours: fmtHours(r.hours),
      cum: fmtHours(r.cumulative),
    });
    y += rowH;
  });
  if (hidden > 0) {
    doc.fillColor('#a33').font('Italic');
    text(`+ ${hidden} more ${hidden === 1 ? 'entry' : 'entries'} not shown (included in total above).`,
      MARGIN + pad, y);
  }

  // ---- Footer ----
  doc.font('Regular').fontSize(8).fillColor('#888');
  const generated = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
  }).format(now);
  text(`Generated ${generated} (${tz}). Hours shown in decimal hours; shifts are listed by clock-in date.`,
    MARGIN, PAGE.height - MARGIN, { width: contentW, align: 'center' });

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
