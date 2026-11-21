// Reading files in (core/): Excel and CSV (any table), PDF (what can be read as text: Public Bank statements and QC GROUP HQ bills).
// A picture / a scan can not be read without OCR: the person is told to enter it by hand (SPEC instruction 18).
const ExcelJS = require('exceljs');

const iso = (d) => d.toISOString().slice(0, 10);
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return iso(v);
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellValue(v.result);                  // a formula: its result
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);                          // a link
    return String(v);
  }
  return typeof v === 'number' ? v : String(v).trim();
}

// CSV text -> rows (quotes, commas / semicolons / tabs, BOM, CRLF)
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', inq = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inq) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inq = false; } else cur += ch; }
    else if (ch === '"') inq = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => r.map((c) => String(c).trim()));
}

/* An Excel (.xlsx) or CSV file -> { header: [...], rows: [[...]] } (the first non-empty row is the header) */
async function readTable(buffer, fileName) {
  const name = String(fileName || '').toLowerCase();
  let grid;
  if (/\.csv$|\.txt$/.test(name)) grid = parseCsv(buffer.toString('utf8'));
  else if (/\.xlsx$/.test(name) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0]; if (!ws) throw Object.assign(new Error('The file has no sheets'), { status: 422 });
    grid = []; ws.eachRow({ includeEmpty: false }, (row) => { const vals = []; for (let c = 1; c <= row.cellCount; c++) vals.push(cellValue(row.getCell(c).value)); grid.push(vals); });
  } else if (/\.xls$/.test(name)) throw Object.assign(new Error('Old .xls files are not supported: save the file as .xlsx or .csv'), { status: 422 });
  else if (/\.pdf$/.test(name)) throw Object.assign(new Error('This is a PDF: use the PDF reader'), { status: 422 });
  else grid = parseCsv(buffer.toString('utf8'));
  grid = grid.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!grid.length) throw Object.assign(new Error('The file is empty'), { status: 422 });
  return { header: grid[0].map((h) => String(h).trim()), rows: grid.slice(1) };
}

/* A PDF -> { kind: 'bank_statement', ...parsed } or { kind: 'hq_bill', bill } ; throws when it is a picture or something else */
async function readPdf(buffer, fileName, opts) {
  const cannot = (m) => Object.assign(new Error(m), { status: 422 });
  let bank;
  try { bank = await require('../lib/bankPdf').parseStatement(buffer); }
  catch (e) { throw cannot('This PDF could not be opened (it may be damaged or protected). Please use the Excel / CSV of the bank, or enter it by hand.'); }
  if (bank && bank.rows) return Object.assign({ kind: 'bank_statement' }, bank);
  if (bank && bank.unreadable) throw cannot('This PDF is a picture (a scan): it can not be read without OCR. Please enter it by hand or use the Excel / CSV of the bank.');
  let text = '';
  try { text = (await require('pdf-parse/lib/pdf-parse.js')(buffer)).text; } catch (e) { text = ''; }
  const bill = require('../lib/hqBill').parseBill(text, String(fileName || ''), opts && opts.branches);
  if (bill && bill.items && bill.items.length) return { kind: 'hq_bill', bill };
  throw cannot('This PDF is not a kind the system can read yet (Public Bank statements and QC GROUP HQ bills). Please enter it by hand or use an Excel / CSV file.');
}

module.exports = { readTable, readPdf, parseCsv };
