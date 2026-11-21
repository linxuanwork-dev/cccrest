// Every list and report can be given as Excel, CSV and PDF (core/: the same three for every module).
//   table = { title, subtitle, company, header: ['Date', ...], rows: [[...], ...], total: [...]?, notes: [...]?, widths: [...]?, sheet: 'Sheet name'? }
const ExcelJS = require('exceljs');
const { buildTablePdf } = require('../lib/tablePdf');

const FORMATS = {
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
  pdf: { ext: 'pdf', mime: 'application/pdf' }
};
const isFormat = (f) => Object.prototype.hasOwnProperty.call(FORMATS, f);

const cell = (v) => (v == null ? '' : v);

// CSV: UTF-8 with a byte order mark (so Excel shows Chinese correctly), CRLF, every text quoted, numbers as they are
function toCsv(header, rows) {
  const q = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '"' + String(cell(v)).replace(/"/g, '""') + '"');
  const lines = [header, ...rows].map((r) => r.map(q).join(','));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

async function toXlsx(t) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(t.sheet || t.title || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  let r0 = 1;
  if (t.company || t.title) {
    if (t.company) ws.addRow([t.company]).font = { bold: true, size: 12 };
    if (t.title) ws.addRow([t.title + (t.subtitle ? '  ·  ' + t.subtitle : '')]).font = { bold: true };
    ws.addRow([]); r0 = ws.rowCount + 1;
  }
  const h = ws.addRow(t.header); h.font = { bold: true };
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0F6' } }; });
  t.rows.forEach((r) => ws.addRow(r.map(cell)));
  if (t.total) { const tr = ws.addRow(t.total.map(cell)); tr.font = { bold: true }; }
  (t.notes || []).forEach((n, i) => { if (!i) ws.addRow([]); ws.addRow([n]); });
  ws.columns.forEach((c, i) => { c.width = (t.widths && t.widths[i]) || Math.min(40, Math.max(10, String(t.header[i] || '').length + 4)); });
  ws.views = [{ state: 'frozen', ySplit: r0 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(t) {
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(cell(v)));
  const doc = buildTablePdf({
    company: t.company, title: t.title, subtitle: t.subtitle, notes: t.notes,
    sections: [{ columns: t.header, rows: t.rows.map((r) => r.map(fmt)), total: t.total ? t.total.map(fmt) : undefined }]
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.end();
  });
}

/* the file in the format asked for: { buffer, mime, ext } */
async function render(format, t) {
  if (!isFormat(format)) throw Object.assign(new Error('Format must be xlsx, csv or pdf'), { status: 400 });
  const buffer = format === 'csv' ? toCsv(t.header, t.rows.concat(t.total ? [t.total] : [])) : format === 'xlsx' ? await toXlsx(t) : await toPdf(t);
  return { buffer, mime: FORMATS[format].mime, ext: FORMATS[format].ext };
}

module.exports = { FORMATS, isFormat, toCsv, toXlsx, toPdf, render };
