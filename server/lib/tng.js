// TNG / DuitNow QR Daily Settlement Report: reading the original MMSDO monthly settlement report (xlsx / csv), grouping it by outlet,
// the daily summary and the checks. All money is kept in cents (integers) so there is no floating point error.
const ExcelJS = require('exceljs');

const KNOWN_TYPES = [
  { type: 'DUITNOW_QR_TNGD', key: 'tng', label: 'TNG eWallet' },
  { type: 'DUITNOW_QR_AQC', key: 'duitnow', label: 'DuitNow QR' },
  { type: 'DUITNOW_QR_AQC_CB', key: 'cb', label: 'Cross-Border QR' }
];
const TYPE_KEYS = KNOWN_TYPES.map((t) => t.key).concat(['others']);
const TYPE_LABEL = { tng: 'TNG eWallet', duitnow: 'DuitNow QR', cb: 'Cross-Border QR', others: 'Others' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const typeKeyOf = (type) => { const k = KNOWN_TYPES.find((t) => t.type === String(type || '').trim().toUpperCase()); return k ? k.key : 'others'; };
const isKnownType = (type) => KNOWN_TYPES.some((t) => t.type === String(type || '').trim().toUpperCase());
const REFUND_RE = /REFUND|REVERSAL|CHARGEBACK|VOID|CANCEL/i;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const normKey = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- reading the file ----------

function cellVal(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((p) => p.text).join('');
    if (v.result !== undefined) return cellVal(v.result);
    if (v.text !== undefined) return v.text;
    if (v.error) return '';
  }
  return v;
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// the first sheet that looks like the settlement report -> an array of rows (arrays of cell values, column A = index 0)
async function readRows(buffer, fileName) {
  const name = String(fileName || '').toLowerCase();
  if (/\.xls$/.test(name)) throw new Error('这是旧格式 .xls。请在 Excel 里另存为 .xlsx 再上传。 This is an old .xls file: save it as .xlsx first.');
  if (/\.csv$/.test(name)) return parseCsv(buffer.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { throw new Error('读不到这个文件，请确认是 TNG / MMSDO 的原版月结报告（.xlsx）。 Could not read the file: is it the original MMSDO monthly report (.xlsx)?'); }
  let best = null;
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => { const vals = []; for (let c = 1; c <= row.cellCount; c++) vals.push(cellVal(row.getCell(c).value)); rows[n - 1] = vals; });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    if (findHeader(rows)) return rows;
    if (!best) best = rows;
  }
  return best || [];
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const keys = (rows[i] || []).map(normKey);
    if (keys.includes('no') && keys.includes('settlementdate')) return i;
  }
  return -1;
}

const COLS = {
  no: ['no'], settleDate: ['settlementdate'], txnDate: ['transactiondatetime'], outlet: ['shopoutletname'], location: ['shopoutletlocation'],
  txnRef: ['transactionreference'], merRef: ['merchantreference'], type: ['transactiontype'],
  gross: ['transactionamountrm', 'transactionamount'], comm: ['commissionamountrm', 'commissionamount'], gst: ['commissiongstrm', 'commissiongst'],
  net: ['settlementamountrm', 'settlementamount'], details: ['paymentdetails'], mode: ['settlementmode']
};

function ymdOf(v) {
  // -> { ymd:'2026-10-01', hms:'10:30:29' } or null. A date cell is read as its own wall clock (Excel has no time zone).
  if (v instanceof Date) { if (isNaN(v.getTime())) return null; return { ymd: v.getUTCFullYear() + '-' + pad(v.getUTCMonth() + 1) + '-' + pad(v.getUTCDate()), hms: pad(v.getUTCHours()) + ':' + pad(v.getUTCMinutes()) + ':' + pad(v.getUTCSeconds()) }; }
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return ymdOf(d); }
  const s = norm(v); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return { ymd: m[1] + '-' + m[2] + '-' + m[3], hms: pad(m[4] || 0) + ':' + pad(m[5] || 0) + ':' + pad(m[6] || 0) };
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return { ymd: m[3] + '-' + pad(m[2]) + '-' + pad(m[1]), hms: pad(m[4] || 0) + ':' + pad(m[5] || 0) + ':' + pad(m[6] || 0) };
  return null;
}

function cents(v) {
  if (v === '' || v == null) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const textOf = (v) => { if (v == null || v === '') return ''; if (v instanceof Date) return v.toISOString(); return typeof v === 'number' ? String(v) : String(v).trim(); };

// buffer + file name -> { meta, rows, total }
async function parseReport(buffer, fileName) {
  const grid = await readRows(buffer, fileName);
  const hi = findHeader(grid);
  if (hi < 0) throw new Error('找不到明细表头（要同一行有 No 和 Settlement Date）。请确认是 TNG / MMSDO 的原版月结报告。 Could not find the detail header row (a row with both "No" and "Settlement Date").');
  // header information (label on the left, value on the right)
  const meta = { settleDate: '', reference: '', merchantId: '', externalMid: '', merchantName: '', companyName: '' };
  const labelMap = { settlementreportdate: 'settleDate', reportreference: 'reference', merchantid: 'merchantId', externalmid: 'externalMid', merchantname: 'merchantName', merchantcompanyname: 'companyName' };
  for (let i = 0; i < hi; i++) {
    const r = grid[i] || [];
    for (let c = 0; c < r.length; c++) {
      const f = labelMap[normKey(r[c])];
      if (!f) continue;
      let v = ''; for (let k = c + 1; k < r.length; k++) if (r[k] !== '' && r[k] != null) { v = r[k]; break; }
      if (f === 'settleDate') { const d = ymdOf(v); meta.settleDate = d ? d.ymd : ''; } else meta[f] = textOf(v);
      break;
    }
  }
  const hdr = (grid[hi] || []).map(normKey);
  const col = {};
  for (const k in COLS) { const idx = hdr.findIndex((h) => COLS[k].includes(h)); col[k] = idx; }
  for (const need of ['txnDate', 'type', 'net']) if (col[need] < 0) throw new Error('明细表头里缺少必要的列（Transaction Datetime / Transaction Type / Settlement Amount）。 A required column is missing in the header.');
  const get = (r, k) => (col[k] >= 0 ? r[col[k]] : '');
  const rows = []; let total = null;
  for (let i = hi + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (!r.length) continue;
    const typeCell = norm(get(r, 'type'));
    if (/^total:?$/i.test(typeCell) || r.some((x) => /^total:?$/i.test(norm(x)))) { total = { gross: cents(get(r, 'gross')), comm: cents(get(r, 'comm')), gst: cents(get(r, 'gst')), net: cents(get(r, 'net')) }; break; }
    const no = get(r, 'no');
    if (!(typeof no === 'number' || /^\d+$/.test(norm(no)))) continue;
    const td = ymdOf(get(r, 'txnDate')), sd = ymdOf(get(r, 'settleDate'));
    rows.push({
      no: Number(no), settleDate: sd ? sd.ymd : '', txnDate: td ? td.ymd : '', txnTime: td ? td.hms : '',
      outlet: norm(get(r, 'outlet')), location: norm(get(r, 'location')),
      txnRef: textOf(get(r, 'txnRef')), merRef: textOf(get(r, 'merRef')), type: norm(get(r, 'type')),
      gross: cents(get(r, 'gross')), comm: cents(get(r, 'comm')), gst: cents(get(r, 'gst')), net: cents(get(r, 'net')),
      details: textOf(get(r, 'details')), mode: norm(get(r, 'mode'))
    });
  }
  if (!rows.length) throw new Error('这个文件里没有交易明细。 No transactions found in the file.');
  // the report month: the header date, else the month of the first transaction
  let period = meta.settleDate ? meta.settleDate.slice(0, 7) : '';
  if (!period) { const first = rows.find((x) => x.txnDate); period = first ? first.txnDate.slice(0, 7) : ''; }
  meta.period = period;
  return { meta, rows, total };
}

// ---------- outlets ----------

const outletKeyOf = (r) => (norm(r.outlet).toLowerCase() + (r.location ? '|' + norm(r.location).toLowerCase() : ''));
const outletNameOf = (r) => norm(r.outlet) + (r.location ? ' ' + norm(r.location) : '');

// the outlets found in the file, in the order of their first transaction: [{ key, name, rows }]
function groupOutlets(rows) {
  const map = new Map();
  for (const r of rows) { const k = outletKeyOf(r); if (!map.has(k)) map.set(k, { key: k, name: outletNameOf(r), rows: [] }); map.get(k).rows.push(r); }
  return [...map.values()];
}

// ---------- the daily summary of one outlet ----------

const daysIn = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const dowOf = (ymd) => DAY_NAMES[new Date(ymd + 'T00:00:00Z').getUTCDay()];
const dmy = (ymd) => (ymd ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : '');

function summarise(rows, period) {
  const n = daysIn(period);
  const zero = () => ({ tng: 0, duitnow: 0, cb: 0, others: 0 });
  const days = [];
  for (let d = 1; d <= n; d++) { const ymd = period + '-' + pad(d); days.push({ no: d, ymd, date: dmy(ymd), dow: dowOf(ymd), settle: '', settleMany: false, type: zero(), count: 0, gross: 0, comm: 0, gst: 0, net: 0, _sd: new Set() }); }
  const outside = { type: zero(), count: 0, gross: 0, comm: 0, gst: 0, net: 0, rows: [] };
  const byType = {};
  for (const r of rows) {
    const k = typeKeyOf(r.type);
    const day = r.txnDate && r.txnDate.startsWith(period + '-') ? days[Number(r.txnDate.slice(8, 10)) - 1] : null;
    const tgt = day || outside;
    tgt.type[k] += r.net; tgt.count++; tgt.gross += r.gross; tgt.comm += r.comm; tgt.gst += r.gst; tgt.net += r.net;
    if (day) { if (r.settleDate) day._sd.add(r.settleDate); } else outside.rows.push(r);
    const tk = String(r.type || '(blank)').toUpperCase();
    byType[tk] = byType[tk] || { type: tk, key: k, count: 0, amount: 0 };
    byType[tk].count++; byType[tk].amount += r.net;
  }
  for (const d of days) { const s = [...d._sd].sort(); d.settle = s.length ? s[s.length - 1] : ''; d.settleMany = s.length > 1; delete d._sd; }
  const sum = (f) => days.reduce((a, d) => a + f(d), 0) + f(outside);
  const totals = { type: zero(), count: sum((d) => d.count), gross: sum((d) => d.gross), comm: sum((d) => d.comm), gst: sum((d) => d.gst), net: sum((d) => d.net) };
  for (const k of TYPE_KEYS) totals.type[k] = sum((d) => d.type[k]);
  const types = Object.values(byType).sort((a, b) => TYPE_KEYS.indexOf(a.key) - TYPE_KEYS.indexOf(b.key) || b.amount - a.amount);
  types.forEach((t) => { t.pct = totals.net ? Math.round((t.amount / totals.net) * 10000) / 100 : 0; });
  const sorted = rows.slice().sort((a, b) => (a.txnDate + ' ' + a.txnTime < b.txnDate + ' ' + b.txnTime ? -1 : a.txnDate + ' ' + a.txnTime > b.txnDate + ' ' + b.txnTime ? 1 : a.no - b.no));
  return {
    period, days, outside: outside.count ? outside : null, totals, types, rows: sorted,
    hasOthers: totals.type.others !== 0 || outside.type.others !== 0,
    hideCommission: totals.comm === 0 && totals.gst === 0,
    activeDays: days.filter((d) => d.count).length,
    refunds: rows.filter((r) => r.net < 0 || r.gross < 0 || REFUND_RE.test(r.type))
  };
}

// ---------- the checks (shown before the reports are made) ----------

const money = (c) => (c / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function runChecks(parsed, outlets) {
  const { rows, total, meta } = parsed;
  const checks = [];
  const add = (level, title, detail, list) => checks.push({ level, title, detail: detail || '', list: list || [] });
  const sums = rows.reduce((a, r) => ({ gross: a.gross + r.gross, comm: a.comm + r.comm, gst: a.gst + r.gst, net: a.net + r.net }), { gross: 0, comm: 0, gst: 0, net: 0 });
  const outletNet = outlets.reduce((a, o) => a + o.rows.reduce((x, r) => x + r.net, 0), 0);
  if (!total) {
    add('warn', '没有找到原版的 Total: 行，无法对账 · No "Total:" row found to reconcile with', '');
  } else {
    const diffs = [['Net Settlement', outletNet, total.net], ['Gross', sums.gross, total.gross], ['Commission', sums.comm, total.comm], ['Commission GST', sums.gst, total.gst]].filter((x) => Math.abs(x[1] - x[2]) >= 1);
    if (!diffs.length) add('ok', '各分行合计 = 原版 Total: 行（Net / Gross / Commission / GST）· Outlets add up to the statement total', 'Net Settlement RM ' + money(total.net));
    else add('bad', '合计和原版 Total: 行不一样 · Totals differ from the statement', '', diffs.map((x) => x[0] + '：明细合计 RM ' + money(x[1]) + '，原版 Total RM ' + money(x[2]) + '（差 RM ' + money(x[1] - x[2]) + '）'));
  }
  const cnt = outlets.reduce((a, o) => a + o.rows.length, 0);
  if (cnt === rows.length) add('ok', '交易笔数 ' + rows.length + ' = 各分行笔数合计 · Transaction count matches', '');
  else add('bad', '交易笔数对不上 · Transaction count does not match', rows.length + ' / ' + cnt);
  // duplicates by Merchant Reference (the Transaction Reference may already be in scientific notation: not used)
  const seen = new Map(), dups = [];
  for (const r of rows) { if (!r.merRef) continue; if (seen.has(r.merRef)) dups.push(r.merRef + '（第 ' + seen.get(r.merRef) + ' 行和第 ' + r.no + ' 行）'); else seen.set(r.merRef, r.no); }
  if (dups.length) add('warn', 'Merchant Reference 有重复 · Duplicate Merchant Reference', dups.length + ' 笔', dups.slice(0, 30));
  else add('ok', '没有重复的 Merchant Reference · No duplicates', '');
  const refunds = rows.filter((r) => r.net < 0 || r.gross < 0 || REFUND_RE.test(r.type));
  if (refunds.length) add('warn', '有负数金额 / 退款类交易（照原版金额计入）· Negative amounts / refunds (counted as in the statement)', refunds.length + ' 笔', refunds.slice(0, 30).map((r) => '第 ' + r.no + ' 行 ' + r.txnDate + ' ' + r.type + ' RM ' + money(r.net)));
  const out = meta.period ? rows.filter((r) => !r.txnDate || !r.txnDate.startsWith(meta.period + '-')) : [];
  if (out.length) add('warn', '有交易日期不在报告月份（' + meta.period + '）内 · Transactions dated outside the report month', out.length + ' 笔', out.slice(0, 30).map((r) => '第 ' + r.no + ' 行 ' + (r.txnDate || '日期读不到') + ' RM ' + money(r.net)));
  const unk = [...new Set(rows.filter((r) => !isKnownType(r.type)).map((r) => r.type || '(blank)'))];
  if (unk.length) add('warn', '有系统不认识的 Transaction Type，归入 Others · Unknown transaction types (put in Others)', unk.length + ' 种', unk);
  const noOutlet = rows.filter((r) => !r.outlet).length;
  if (noOutlet) add('warn', '有 ' + noOutlet + ' 笔没有 Shop/Outlet Name', '');
  if (!meta.period) add('bad', '读不到报告月份 · Could not read the report month', '');
  const level = checks.some((c) => c.level === 'bad') ? 'bad' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  return { level, checks };
}

module.exports = { parseReport, groupOutlets, summarise, runChecks, typeKeyOf, isKnownType, outletKeyOf, outletNameOf, daysIn, dmy, money, KNOWN_TYPES, TYPE_KEYS, TYPE_LABEL, MONTH_NAMES, DAY_NAMES, REFUND_RE, cents };
