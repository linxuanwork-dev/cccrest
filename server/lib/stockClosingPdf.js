// Closing Stock report as a formal PDF (Stock Count page): a SUMMARY (totals, by group, by account, comparison with the
// previous month with bar charts, and the trend of the last months) and an ALL ITEMS list (grouped, with subtotals).
// The page sends the numbers it shows; this only lays them out.
const path = require('path');
const PDFDocument = require('pdfkit');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
const MARGIN = 40;
const FOOTER = 56;
const INK = '#1a1a1a', MUTED = '#5b6470', LINE = '#d0d5da', SHADE = '#f1f3f5', HEAD = '#1a4376', PREV = '#a9b3bf', UP = '#b42318', DOWN = '#157f3d';

const money = (n) => (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (n) => Math.round(Number(n) || 0).toLocaleString('en-MY');
const signed = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + money(Math.abs(n));
const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev * 100).toFixed(1) + '%' : '—');
const s = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function font(doc, text, bold, size) {
  doc.font(CJK_RE.test(String(text)) ? 'CJK' : bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
}
const usable = (doc) => doc.page.width - MARGIN * 2;
const room = (doc) => doc.page.height - MARGIN - FOOTER - doc.y;

// cleans what the page sent
function clean(p) {
  p = p || {};
  const list = (a, max) => (Array.isArray(a) ? a.slice(0, max) : []);
  return {
    type: p.type === 'items' ? 'items' : 'summary',
    company: s(p.company, 120), asAt: s(p.asAt, 20), monthLabel: s(p.monthLabel, 30), countDate: s(p.countDate, 20),
    status: p.status === 'CLOSED' ? 'CLOSED' : 'NOT CLOSED (DRAFT)', imported: !!p.imported,
    total: num(p.total), counted: num(p.counted), itemCount: num(p.itemCount),
    prev: p.prev && typeof p.prev === 'object' ? { label: s(p.prev.label, 30), total: num(p.prev.total) } : null,
    groups: list(p.groups, 60).map((g) => ({ name: s(g.name, 80), total: num(g.total), prev: g.prev == null ? null : num(g.prev) })).filter((g) => g.total || g.prev),   // groups with nothing in them (e.g. "no count" groups) are left out
    accounts: list(p.accounts, 60).map((a) => ({ name: s(a.name, 80), total: num(a.total) })),
    trend: list(p.trend, 24).map((t) => ({ label: s(t.label, 20), total: num(t.total), current: !!t.current })),
    items: list(p.items, 4000).map((i) => ({ group: s(i.group, 80), name: s(i.name, 200), qty: num(i.qty), unit: s(i.unit, 12), price: num(i.price), amount: num(i.amount), detail: s(i.detail, 60) }))
  };
}

function header(doc, d, title) {
  font(doc, d.company, true, 15);
  doc.fillColor(INK).text(d.company, MARGIN, MARGIN);
  font(doc, title, true, 12);
  doc.fillColor(HEAD).text(title, MARGIN, doc.y + 2);
  font(doc, 'x', false, 9);
  doc.fillColor(MUTED).text('As at ' + d.asAt + '   ·   Month: ' + d.monthLabel + '   ·   Stock count date: ' + (d.countDate || '-') + '   ·   Status: ' + d.status + (d.imported ? ' (imported report)' : ''), MARGIN, doc.y + 2);
  doc.moveDown(0.5);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + usable(doc), doc.y).lineWidth(1).strokeColor(HEAD).stroke();
  doc.moveDown(0.6);
}

function section(doc, text) {
  if (room(doc) < 90) doc.addPage();
  doc.moveDown(0.7);
  font(doc, text, true, 11);
  doc.fillColor(INK).text(text, MARGIN, doc.y);
  doc.moveDown(0.3);
}

// columns: [{ label, w (weight), align }]; rows: arrays of strings, or { cells, kind: 'group' | 'sub' | 'total' }
function table(doc, columns, rows, opts) {
  opts = opts || {};
  const size = opts.size || 8.5;
  const W = usable(doc), tw = columns.reduce((a, c) => a + (c.w || 1), 0);
  const widths = columns.map((c) => (W * (c.w || 1)) / tw);
  const height = (cells, bold) => {
    let h = 0;
    cells.forEach((v, i) => { font(doc, v, bold, size); h = Math.max(h, doc.heightOfString(String(v == null ? '' : v), { width: widths[i] - 8 })); });
    return h + 7;
  };
  const drawHead = () => {
    const h = height(columns.map((c) => c.label), true), y = doc.y;
    doc.rect(MARGIN, y, W, h).fill(HEAD);
    let x = MARGIN;
    columns.forEach((c, i) => { font(doc, c.label, true, size); doc.fillColor('#ffffff').text(c.label, x + 4, y + 3.5, { width: widths[i] - 8, align: c.align || 'left' }); x += widths[i]; });
    doc.y = y + h;
  };
  if (room(doc) < 60) doc.addPage();
  drawHead();
  rows.forEach((r) => {
    const kind = Array.isArray(r) ? '' : r.kind, cells = Array.isArray(r) ? r : r.cells;
    const bold = kind === 'sub' || kind === 'total' || kind === 'group';
    let h;
    if (kind === 'group') { font(doc, cells[0], true, size); h = doc.heightOfString(String(cells[0]), { width: W - 8 }) + 7; }   // a group title spans the whole row
    else h = height(cells, bold);
    if (room(doc) < h + 4) { doc.addPage(); drawHead(); }
    const y = doc.y;
    if (kind === 'group') doc.rect(MARGIN, y, W, h).fill('#e4eaf2');
    else if (kind === 'sub') doc.rect(MARGIN, y, W, h).fill(SHADE);
    else if (kind === 'total') doc.rect(MARGIN, y, W, h).fill('#d9e2ee');
    doc.fillColor(INK);
    if (kind === 'group') { font(doc, cells[0], true, size); doc.fillColor(HEAD).text(cells[0], MARGIN + 4, y + 3.5, { width: W - 8 }); }
    else {
      let x = MARGIN;
      cells.forEach((v, i) => {
        const t = String(v == null ? '' : v);
        font(doc, t, bold, size);
        doc.fillColor(columns[i].color ? columns[i].color(t, r) || INK : INK).text(t, x + 4, y + 3.5, { width: widths[i] - 8, align: columns[i].align || 'left' });
        x += widths[i];
      });
    }
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + W, y + h).lineWidth(0.4).strokeColor(LINE).stroke();
    doc.y = y + h;
  });
}

function kpis(doc, cards) {
  const gap = 8, W = (usable(doc) - gap * (cards.length - 1)) / cards.length, y = doc.y, h = 50;
  cards.forEach((c, i) => {
    const x = MARGIN + i * (W + gap);
    doc.roundedRect(x, y, W, h, 4).lineWidth(0.8).strokeColor(LINE).stroke();
    font(doc, c.label, false, 8); doc.fillColor(MUTED).text(c.label, x + 8, y + 7, { width: W - 16 });
    font(doc, c.value, true, 13); doc.fillColor(c.color || INK).text(c.value, x + 8, y + 21, { width: W - 16 });
    if (c.note) { font(doc, c.note, false, 7.5); doc.fillColor(MUTED).text(c.note, x + 8, y + 38, { width: W - 16 }); }
  });
  doc.y = y + h + 6;
}

// horizontal bars: every group, this month against the previous month
function groupChart(doc, d) {
  const rows = d.groups.filter((g) => g.total || g.prev);
  if (!rows.length) return;
  const labelW = 150, valW = 62, barH = 8, rowH = 24, top = 22;
  const chartH = top + rows.length * rowH + 6;
  if (room(doc) < chartH + 10) doc.addPage();
  const x0 = MARGIN + labelW, W = usable(doc) - labelW - valW, y0 = doc.y;
  const max = Math.max(1, ...rows.map((g) => Math.max(g.total, g.prev || 0)));
  // legend
  doc.rect(MARGIN, y0 + 3, 9, 9).fill(HEAD); font(doc, 'x', false, 8); doc.fillColor(INK).text(d.monthLabel, MARGIN + 13, y0 + 3.5, { lineBreak: false });
  const lx = MARGIN + 13 + doc.widthOfString(d.monthLabel) + 16;
  doc.rect(lx, y0 + 3, 9, 9).fill(PREV); doc.fillColor(INK).text(d.prev ? d.prev.label : 'Previous month', lx + 13, y0 + 3.5, { lineBreak: false });
  rows.forEach((g, i) => {
    const y = y0 + top + i * rowH;
    font(doc, g.name, false, 8); doc.fillColor(INK).text(g.name, MARGIN, y + 3, { width: labelW - 8, height: 18, ellipsis: true });
    const w1 = Math.max(g.total > 0 ? 1 : 0, (g.total / max) * W), w2 = Math.max(g.prev > 0 ? 1 : 0, ((g.prev || 0) / max) * W);
    doc.rect(x0, y, w1, barH).fill(HEAD);
    font(doc, 'x', false, 7.5); doc.fillColor(INK).text(whole(g.total), x0 + w1 + 4, y, { lineBreak: false });
    if (g.prev != null) { doc.rect(x0, y + barH + 2, w2, barH).fill(PREV); doc.fillColor(MUTED).text(whole(g.prev), x0 + w2 + 4, y + barH + 2, { lineBreak: false }); }
  });
  doc.moveTo(x0, y0 + top - 2).lineTo(x0, y0 + top + rows.length * rowH).lineWidth(0.6).strokeColor(MUTED).stroke();
  doc.y = y0 + chartH;
}

// vertical bars: the closing stock of each month
function trendChart(doc, d) {
  const pts = d.trend;
  if (pts.length < 2) return;
  const h = 130, plotTop = 16, plotH = h - 36;
  if (room(doc) < h + 10) doc.addPage();
  const y0 = doc.y, W = usable(doc), slot = W / pts.length, bw = Math.min(34, slot * 0.6);
  const max = Math.max(1, ...pts.map((p) => p.total));
  const base = y0 + plotTop + plotH;
  doc.moveTo(MARGIN, base).lineTo(MARGIN + W, base).lineWidth(0.6).strokeColor(MUTED).stroke();
  pts.forEach((p, i) => {
    const bh = Math.max(p.total > 0 ? 1 : 0, (p.total / max) * plotH), x = MARGIN + i * slot + (slot - bw) / 2;
    doc.rect(x, base - bh, bw, bh).fill(p.current ? HEAD : PREV);
    font(doc, 'x', false, 7); doc.fillColor(INK).text(whole(p.total), MARGIN + i * slot, base - bh - 10, { width: slot, align: 'center', lineBreak: false });
    doc.fillColor(MUTED).text(p.label, MARGIN + i * slot, base + 4, { width: slot, align: 'center', lineBreak: false });
  });
  doc.y = y0 + h;
}

function footer(doc, d) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 38;
    doc.moveTo(MARGIN, y - 6).lineTo(MARGIN + usable(doc), y - 6).lineWidth(0.4).strokeColor(LINE).stroke();
    font(doc, d.company, false, 8); doc.fillColor(MUTED).text(d.company + '  ·  Closing Stock ' + d.monthLabel, MARGIN, y, { width: 330, lineBreak: false });
    font(doc, 'x', false, 8); doc.text('Page ' + (i - range.start + 1) + ' / ' + range.count, MARGIN + usable(doc) - 80, y, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function summaryPdf(doc, d) {
  header(doc, d, 'CLOSING STOCK REPORT — SUMMARY');
  const diff = d.prev ? d.total - d.prev.total : null;
  kpis(doc, [
    { label: 'TOTAL CLOSING STOCK (RM)', value: money(d.total), note: d.itemCount + ' items in stock' },
    { label: d.prev ? 'PREVIOUS MONTH (' + d.prev.label + ')' : 'PREVIOUS MONTH', value: d.prev ? money(d.prev.total) : '—', note: d.prev ? '' : 'not closed / no report' },
    { label: 'CHANGE', value: diff == null ? '—' : signed(diff), note: diff == null ? '' : pct(d.total, d.prev.total) }
  ]);

  section(doc, '1. Closing stock by group');
  const gRows = d.groups.map((g) => [g.name, money(g.total), g.prev == null ? '—' : money(g.prev), g.prev == null ? '—' : signed(g.total - g.prev), g.prev == null ? '—' : pct(g.total, g.prev)]);
  gRows.push({ kind: 'total', cells: ['TOTAL', money(d.total), d.prev ? money(d.prev.total) : '—', diff == null ? '—' : signed(diff), d.prev ? pct(d.total, d.prev.total) : '—'] });
  const chg = () => INK;
  table(doc, [
    { label: 'Group', w: 4 }, { label: d.monthLabel + ' (RM)', w: 2.2, align: 'right' }, { label: (d.prev ? d.prev.label : 'Previous') + ' (RM)', w: 2.2, align: 'right' },
    { label: 'Change (RM)', w: 2, align: 'right', color: chg }, { label: '%', w: 1.2, align: 'right', color: chg }
  ], gRows);

  section(doc, '2. Comparison with the previous month (chart)');
  groupChart(doc, d);

  section(doc, '3. Closing stock by account');
  const aRows = d.accounts.map((a) => [a.name, money(a.total), d.total ? (a.total / d.total * 100).toFixed(1) + '%' : '—']);
  aRows.push({ kind: 'total', cells: ['TOTAL', money(d.accounts.reduce((x, a) => x + a.total, 0)), ''] });
  table(doc, [{ label: 'Account', w: 6 }, { label: 'Amount (RM)', w: 2.5, align: 'right' }, { label: '% of total', w: 1.5, align: 'right' }], aRows);

  if (d.trend.length >= 2) {
    section(doc, '4. Closing stock trend (last ' + d.trend.length + ' months)');
    trendChart(doc, d);
    doc.moveDown(0.4);
    const tRows = d.trend.map((t, i) => [t.label, money(t.total), i ? signed(t.total - d.trend[i - 1].total) : '—', i ? pct(t.total, d.trend[i - 1].total) : '—']);
    table(doc, [{ label: 'Month', w: 3 }, { label: 'Closing stock (RM)', w: 3, align: 'right' }, { label: 'Change vs the month before (RM)', w: 3.5, align: 'right', color: chg }, { label: '%', w: 1.5, align: 'right', color: chg }], tRows);
  }
}

function itemsPdf(doc, d) {
  header(doc, d, 'CLOSING STOCK REPORT — ALL ITEMS');
  const rows = [];
  let cur = null, sub = 0, n = 0;
  const flush = () => { if (cur !== null) rows.push({ kind: 'sub', cells: ['', cur + ' — subtotal', '', '', '', money(sub), ''] }); };
  d.items.forEach((it) => {
    if (it.group !== cur) { flush(); cur = it.group; sub = 0; rows.push({ kind: 'group', cells: [cur] }); }
    sub += it.amount; n++;
    rows.push([String(n), it.name, it.qty ? String(Math.round(it.qty * 10000) / 10000) : '0', it.unit, it.price > 0 ? money(it.price) : '—', money(it.amount), it.detail]);
  });
  flush();
  rows.push({ kind: 'total', cells: ['', 'TOTAL CLOSING STOCK (RM)', '', '', '', money(d.total), ''] });
  table(doc, [
    { label: 'No.', w: 0.9 }, { label: 'Product', w: 7 }, { label: 'Qty', w: 1.3, align: 'right' }, { label: 'Unit', w: 1.2 },
    { label: 'Price (RM)', w: 1.6, align: 'right' }, { label: 'Amount (RM)', w: 2, align: 'right' }, { label: 'Count detail', w: 2.6 }
  ], rows, { size: 8 });
  doc.moveDown(0.6);
  font(doc, 'x', false, 8);
  doc.fillColor(MUTED).text(n + ' items listed' + (d.counted ? ' · ' + d.counted + ' counted' : ''), MARGIN, doc.y);
}

function buildClosingPdf(payload) {
  const d = clean(payload);
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: 'Closing Stock ' + d.monthLabel + ' - ' + d.company } });
  doc.registerFont('CJK', CJK_FONT_PATH);
  if (d.type === 'items') itemsPdf(doc, d); else summaryPdf(doc, d);
  footer(doc, d);
  return { doc, data: d };
}

module.exports = { buildClosingPdf };
