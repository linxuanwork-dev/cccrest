const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');
const STAT = require('../lib/statutory');
const { buildPayslipPdf } = require('../lib/payslipPdf');
const { buildTablePdf } = require('../lib/tablePdf');
const { buildJournalPdf } = require('../lib/journalPdf');
const { buildEaPdf } = require('../lib/eaPdf');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// HR > Attendance (考勤) for one company: the roster (foreign / local / part-time staff with their schedules), the daily clock entries,
// the manager approvals, advances and pay adjustments. The page is server/assets/attendance/app.html (shown inside the company's
// HR > Attendance page); the data is kept as small documents in attendance_docs. The Owner switches it on per company in the Control Panel.
// Everyone uses the HR ("payroll") level of their permission list: L1 look, L2 enter clock times, L3 (manager) approve / roster / pay.

const PAGE = path.join(__dirname, '..', 'assets', 'attendance', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const PATH_RE = /^(roster|settings|entries|approvals|advances|payadj|payroll)\/[A-Za-z0-9_.:-]{1,90}$/;
const MGR_WRITE = new Set(['roster', 'settings', 'approvals', 'advances', 'payadj', 'payroll']);   // only entries (the clock times) can be written by L2
const MGR_READ = new Set(['advances', 'payadj', 'payroll']);                                        // money: managers only
const MAX_DOC = 100 * 1024;
const KEEP_DAYS = 430;                                                                   // the page works on the last ~14 months of clock entries

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, COALESCE(s.enabled, false) AS enabled, COALESCE(s.rev, 0) AS rev, COALESCE(s.payroll_only, false) AS payroll_only
       FROM companies c LEFT JOIN attendance_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  return r ? { name: r.name, enabled: r.enabled, rev: Number(r.rev), payrollOnly: r.payroll_only } : null;
}

// ============ CONTROL PANEL (Owner): switch the feature on per company ============

router.get('/attendance/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled, COALESCE(s.payroll_only, false) AS payroll_only,
       (SELECT COUNT(*) FROM attendance_docs d WHERE d.company_id = c.id)::int AS docs
     FROM companies c LEFT JOIN attendance_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows);
});

router.put('/attendance/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const enabled = !!(req.body && req.body.enabled === true), payrollOnly = !!(req.body && req.body.payrollOnly === true);
  await pool.query(
    `INSERT INTO attendance_settings (company_id, enabled, payroll_only, rev, updated_at) VALUES ($1,$2,$3,1, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, payroll_only = $3, rev = attendance_settings.rev + 1, updated_at = now()`,
    [req.params.id, enabled, payrollOnly]
  );
  await logActivity(req.user.sub, 'Updated HR Attendance settings', s.name, enabled ? (payrollOnly ? 'on (payroll only)' : 'on') : 'off');
  res.json({ ok: true });
});

// ============ COMPANY SIDE ============

router.get('/attendance/app', requireAuth, (req, res) => { res.sendFile(PAGE); });

// The payroll rules (EPF / SOCSO / SKBBK / EIS and the pay lines) are one file used by the server and by the page: the page gets it as a script.
let STAT_JS = null;
router.get('/attendance/statutory.js', requireAuth, (req, res) => {
  if (!STAT_JS) {
    const fs = require('fs');
    STAT_JS = 'window.STAT_TABLES=' + JSON.stringify(require('../lib/statutoryTables')) + ';\n' + fs.readFileSync(path.join(__dirname, '..', 'lib', 'statutory.js'), 'utf8');
  }
  res.type('application/javascript').send(STAT_JS);
});

const BASE = '/companies/:companyId/attendance';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('payroll', level)];
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || req.pageAccess.level >= 3));
async function enabledSettings(req, res) {
  const s = await loadSettings(req.params.companyId);
  if (!s || !s.enabled) { bad(res, '这家公司还没有开通考勤。 Attendance is not switched on for this company.'); return null; }
  return s;
}

router.get(BASE, ...guard(1), async (req, res) => {
  const s = await loadSettings(req.params.companyId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ enabled: s.enabled, payrollOnly: s.payrollOnly, name: s.name, uid: String(req.user.sub), mgr: isMgr(req), canWrite: !!(req.pageAccess && req.pageAccess.level >= 2) });
});

// Everything the page shows, in one request; "same" when nothing changed since the revision the page has.
router.get(BASE + '/sync', ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  if (req.query.rev !== undefined && String(s.rev) === String(req.query.rev)) return res.json({ same: true, rev: s.rev });
  const { rows } = await pool.query(
    `SELECT path, coll, data FROM attendance_docs WHERE company_id = $1
       AND (coll <> 'entries' OR data->>'date' >= to_char(now() - ($2 || ' days')::interval, 'YYYY-MM-DD'))`,
    [req.params.companyId, String(KEEP_DAYS)]
  );
  const mgr = isMgr(req);
  const by = { roster: [], settings: [], entries: [], approvals: [], advances: [], payadj: [], payroll: [] };
  rows.forEach((r) => {
    if (!mgr && MGR_READ.has(r.coll)) return;
    let data = r.data;
    if (!mgr && r.coll === 'roster' && data && data.id) { data = Object.assign({}, data); delete data.id; }   // passport / IC numbers: managers only
    (by[r.coll] = by[r.coll] || []).push({ id: r.path.slice(r.coll.length + 1), data });
  });
  res.json({ rev: s.rev, docs: by });
});

// The HR employee master (Payroll > employees) of the company: what the payroll needs to know about each person (managers only)
router.get(BASE + '/employees', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const { rows } = await pool.query(
    `SELECT id, name, ic_no, bank_name, bank_account, basic_salary, dob, nationality, marital_status, children, disabled, epf_no, socso_no, tin_no, start_date, active, skbbk_opt_out
       FROM employees WHERE company_id = $1 ORDER BY name`, [req.params.companyId]);
  const hist = (await pool.query(
    `SELECT employee_id, to_char(effective_date, 'YYYY-MM-DD') AS effective, amount::float AS amount FROM employee_salary_history WHERE company_id = $1 ORDER BY effective_date, id`, [req.params.companyId])).rows;
  const hby = {};
  hist.forEach((h) => { (hby[h.employee_id] = hby[h.employee_id] || []).push({ effective: h.effective, amount: h.amount }); });
  res.json(rows.map((r) => ({ skbbkOptOut: !!r.skbbk_opt_out, history: hby[r.id] || [],
    id: r.id, name: r.name, ic: r.ic_no || '', basic: Number(r.basic_salary) || 0, dob: r.dob ? String(r.dob).slice(0, 10) : '', nationality: r.nationality || '',
    marital: r.marital_status || '', children: r.children, disabled: r.disabled, epfNo: r.epf_no || '', socsoNo: r.socso_no || '', tin: r.tin_no || '',
    start: r.start_date ? String(r.start_date).slice(0, 10) : '', active: r.active
  })));
});

// SKBBK: a standing choice per employee (opted out / deducted), made on the Payroll page; kept on the employee in Staff Information
router.post(BASE + '/employees/:id/skbbk', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const optOut = !!(req.body && req.body.optOut === true);
  const r = await pool.query('UPDATE employees SET skbbk_opt_out = $3 WHERE id = $1 AND company_id = $2 RETURNING name', [Number(req.params.id) || 0, req.params.companyId, optOut]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  try { await docs.logEvent(req, req.params.companyId, 'employee', r.rows[0].name, 'updated', [{ field: 'SKBBK', from: optOut ? 'deduct' : 'opted out', to: optOut ? 'opted out' : 'deduct' }]); } catch (e) { console.error('skbbk log failed:', e); }
  res.json({ ok: true });
});

// Salary vouchers (payslips) as one PDF, a page per person. The page sends what the attendance gave and what was typed in; the numbers are worked out
// here with the same rules as the page (lib/statutory.js), the person's details come from the HR employee master.
router.post(BASE + '/payslips', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {}, month = String(b.month || ''), list = Array.isArray(b.slips) ? b.slips : [];
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !list.length || list.length > 80) return bad(res, 'Invalid request');
  const ids = [...new Set(list.map((x) => Number(x && x.empId)).filter((n) => Number.isInteger(n) && n > 0))];
  const { rows: emps } = await pool.query(
    `SELECT id, name, ic_no, bank_name, bank_account, basic_salary, dob, nationality, epf_no, socso_no, tin_no, skbbk_opt_out, to_char(start_date,'YYYY-MM-DD') AS start_date
       FROM employees WHERE company_id = $1 AND id = ANY($2::int[])`, [req.params.companyId, ids]);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const hbyEmp = new Map();
  (await pool.query(`SELECT employee_id, to_char(effective_date, 'YYYY-MM-DD') AS effective, amount::float AS amount FROM employee_salary_history WHERE company_id = $1 AND employee_id = ANY($2::int[])`, [req.params.companyId, ids])).rows
    .forEach((h) => { if (!hbyEmp.has(h.employee_id)) hbyEmp.set(h.employee_id, []); hbyEmp.get(h.employee_id).push({ effective: h.effective, amount: h.amount }); });
  const co = (await pool.query('SELECT name, registration_no, address FROM companies WHERE id = $1', [req.params.companyId])).rows[0] || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  // Annual leave: entitlement by length of service (Employment Act: under 2 years 8 days, 2 to under 5 years 12, 5 years or more 16), taken = the days marked 年假 in the Attendance this year up to the month
  const normName = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const leaveTaken = new Map();
  (await pool.query(`SELECT data->>'name' AS name, count(*)::int AS n FROM attendance_docs WHERE company_id = $1 AND coll = 'entries' AND data->>'reason' = $2 AND data->>'date' >= $3 AND data->>'date' <= $4 GROUP BY 1`,
    [req.params.companyId, '年假', month.slice(0, 4) + '-01-01', month + '-31'])).rows.forEach((r) => leaveTaken.set(normName(r.name), r.n));
  const leaveOf = (e) => {
    if (!e.start_date) return null;
    const yrs = (Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0) - Date.parse(e.start_date)) / (365.25 * 86400000);
    const ent = yrs < 2 ? 8 : yrs < 5 ? 12 : 16, taken = leaveTaken.get(normName(e.name)) || 0;
    return { ent, taken, bal: ent - taken };
  };
  const yymm = month.slice(2, 4) + month.slice(5, 7);
  const slips = [];
  list.forEach((x, i) => {
    const e = byId.get(Number(x.empId));
    if (!e) return;
    const snap = x.snap && typeof x.snap === 'object' && Number.isFinite(Number(x.snap.net)) && Number.isFinite(Number(x.snap.gross)) ? x.snap : null;   // the month was finalized: its saved numbers
    const c = snap || STAT.calc({
      month, basic: x.wages === true ? num(x.basic) : STAT.salaryOn(hbyEmp.get(e.id), month, num(e.basic_salary)), otHours: num(x.otHours), unpaidDays: num(x.unpaidDays), allowance: num(x.allowance), incentive: num(x.incentive),
      commission: num(x.commission), other: num(x.other), advance: num(x.advance), pcb: num(x.pcb), dob: e.dob ? String(e.dob).slice(0, 10) : '', nationality: e.nationality || 'MALAYSIAN', skbbkOptOut: !!e.skbbk_opt_out
    });
    slips.push({
      company: co, month, c, leave: leaveOf(e), days: x.days, hours: num(x.hours), otHours: num(x.otHours), voucher: 'JVS-' + yymm + '-' + String(i + 1).padStart(3, '0'),
      emp: { name: e.name, ic: e.ic_no || '', epfNo: e.epf_no || '', socsoNo: e.socso_no || '', tin: e.tin_no || '', bank: [e.bank_name, e.bank_account].filter(Boolean).join(' ') }
    });
  });
  if (!slips.length) return bad(res, '找不到这些员工。 Employees not found.');
  const doc = buildPayslipPdf(slips);
  const base = await docs.fileBase('salary_voucher', req.params.companyId, { PERIOD: month, YYYY: month.slice(0, 4), MM: month.slice(5, 7), EMP: slips.length === 1 ? String(slips[0].emp.name).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() : 'ALL' }, 'SALARY VOUCHER-' + month.slice(0, 4) + '_' + month.slice(5, 7));
  try { await docs.logEvent(req, req.params.companyId, 'salary_voucher', base + '.pdf', 'generated', [{ field: 'payslips', from: '', to: String(slips.length) }]); } catch (e) { console.error('payslip log failed:', e); }
  docs.stampPdfkitPages(doc, docs.stampText(await docs.userNameFor(req)));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-File-Name', encodeURIComponent(base + '.pdf'));
  doc.pipe(res);
  doc.end();
});

// Payroll summary (a month, or the months picked in a year) as a landscape table PDF. The page works the figures out from the payroll rows it shows and sends them.
router.post(BASE + '/summary-pdf', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {}, secs = Array.isArray(b.sections) ? b.sections : [];
  const str = (v) => String(v == null ? '' : v).slice(0, 80);
  const span = String(b.span || '').replace(/[^0-9_-]/g, '').slice(0, 40);
  if (!secs.length || secs.length > 4 || !span) return bad(res, 'Invalid request');
  const sections = secs.map((s) => ({
    heading: str(s.heading), columns: (Array.isArray(s.columns) ? s.columns : []).slice(0, 20).map(str),
    rows: (Array.isArray(s.rows) ? s.rows : []).slice(0, 300).map((r) => (Array.isArray(r) ? r : []).slice(0, 20).map(str)),
    total: Array.isArray(s.total) ? s.total.slice(0, 20).map(str) : null
  }));
  const co = (await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId])).rows[0] || {};
  const doc = buildTablePdf({ company: co.name, title: str(b.title), subtitle: str(b.subtitle), sections, notes: (Array.isArray(b.notes) ? b.notes : []).slice(0, 6).map((t) => String(t).slice(0, 200)) });
  const base = await docs.fileBase('payroll_summary', req.params.companyId, { SPAN: span }, 'PAYROLL SUMMARY-' + span);
  try { await docs.logEvent(req, req.params.companyId, 'payroll_summary', base + '.pdf', 'generated', [{ field: 'summary', from: '', to: str(b.title) }]); } catch (e) { console.error('summary log failed:', e); }
  docs.stampPdfkitPages(doc, docs.stampText(await docs.userNameFor(req)));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-File-Name', encodeURIComponent(base + '.pdf'));
  doc.pipe(res);
  doc.end();
});

// ---- Bukku import files: the rows are written into Bukku's own template (server/assets/attendance/bukku) so the comment lines, the column headings,
// the column order and the formats are exactly what Bukku gives. rows = arrays of cells starting at column B. ----
const BUKKU = {
  journal: { file: 'journal-entry-template.xlsx', header: /^No\. \(1\)/ },
  moneyout: { file: 'money-out-template.xlsx', header: /^Contact Code/ }
};
router.post(BASE + '/bukku-file', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const type = req.body && req.body.type, rows = req.body && req.body.rows;
  if (!BUKKU[type] || !Array.isArray(rows) || !rows.length || rows.length > 3000) return bad(res, 'Invalid request');
  for (const r of rows) {
    if (!Array.isArray(r) || r.length > 30 || r.some((v) => v !== null && !['string', 'number'].includes(typeof v))) return bad(res, 'Invalid request');
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(__dirname, '..', 'assets', 'attendance', 'bukku', BUKKU[type].file));
  const ws = wb.worksheets[0];
  let hdr = 0;
  for (let i = 1; i <= 80 && !hdr; i++) { if (BUKKU[type].header.test(String(ws.getRow(i).getCell(2).value || ''))) hdr = i; }
  if (!hdr) return bad(res, 'Template problem');
  for (let i = hdr + 1; i <= ws.rowCount; i++) ws.getRow(i).eachCell({ includeEmpty: false }, (c) => { c.value = null; });   // the sample lines
  rows.forEach((cells, k) => {
    const row = ws.getRow(hdr + 1 + k);
    cells.forEach((v, j) => { if (v !== null && v !== '') row.getCell(2 + j).value = v; });
  });
  // the sample lines of the Bukku template are struck through: the lines we write must not be
  for (let i = hdr + 1; i <= hdr + rows.length + 100; i++) {
    const row = ws.getRow(i);
    for (let j = 1; j <= 30; j++) { const c = row.getCell(j); if (c.font && c.font.strike) c.font = Object.assign({}, c.font, { strike: false }); }
  }
  const buf = await wb.xlsx.writeBuffer();
  try { await docs.logEvent(req, req.params.companyId, 'payroll_bukku', type === 'journal' ? 'Bukku Journal Entry' : 'Bukku Money Out', 'generated', [{ field: 'rows', from: '', to: String(rows.length) }]); } catch (e) { console.error('bukku file log failed:', e); }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// The payroll journals of a month (Journal Entry vouchers) as a PDF, one voucher per page. The page builds the lines; each voucher must balance.
router.post(BASE + '/journal', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {}, month = String(b.month || ''), list = Array.isArray(b.vouchers) ? b.vouchers : [];
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !list.length || list.length > 100) return bad(res, 'Invalid request');
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const vouchers = [];
  for (const v of list) {
    const lines = (Array.isArray(v && v.lines) ? v.lines : []).slice(0, 60).map((l) => ({
      account: str(l && l.account, 120), code: str(l && l.code, 20), desc: str(l && l.desc, 160),
      debit: Math.round((Number(l && l.debit) || 0) * 100) / 100, credit: Math.round((Number(l && l.credit) || 0) * 100) / 100
    }));
    const dr = Math.round(lines.reduce((a, l) => a + l.debit * 100, 0)), cr = Math.round(lines.reduce((a, l) => a + l.credit * 100, 0));
    if (!lines.length || lines.some((l) => !l.account || l.debit < 0 || l.credit < 0) || dr !== cr) return bad(res, '分录不平衡或有空科目：' + str(v && v.no, 40) + ' (Dr ' + dr / 100 + ' / Cr ' + cr / 100 + ')');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.date || ''))) return bad(res, 'Invalid request');
    vouchers.push({ no: str(v.no, 40), date: v.date, reference: str(v.reference, 80), lines });
  }
  const co = (await pool.query('SELECT name, registration_no FROM companies WHERE id = $1', [req.params.companyId])).rows[0] || {};
  const doc = buildJournalPdf(co, vouchers);
  const base = await docs.fileBase('journal_voucher', req.params.companyId, { PERIOD: month }, 'Journal-Entry-' + month);
  try { await docs.logEvent(req, req.params.companyId, 'journal_voucher', base + '.pdf', 'generated', [{ field: 'vouchers', from: '', to: String(vouchers.length) }]); } catch (e) { console.error('journal log failed:', e); }
  docs.stampPdfkitPages(doc, docs.stampText(await docs.userNameFor(req)));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-File-Name', encodeURIComponent(base + '.pdf'));
  doc.pipe(res);
  doc.end();
});

// Form EA (C.P.8A) for a year, one page per employee. The page sends the year's totals; the person's details come from the HR employee master,
// the employer details from the EA settings of the page (settings/ea).
router.post(BASE + '/ea', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {}, year = String(b.year || ''), list = Array.isArray(b.items) ? b.items : [];
  if (!/^20\d{2}$/.test(year) || !list.length || list.length > 80) return bad(res, 'Invalid request');
  const ids = [...new Set(list.map((x) => Number(x && x.empId)).filter((n) => Number.isInteger(n) && n > 0))];
  const { rows: emps } = await pool.query(
    `SELECT id, name, position, ic_no, id_type, epf_no, socso_no, tin_no, children, start_date FROM employees WHERE company_id = $1 AND id = ANY($2::int[])`,
    [req.params.companyId, ids]);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const co = (await pool.query('SELECT name, address FROM companies WHERE id = $1', [req.params.companyId])).rows[0] || {};
  const st = (await pool.query("SELECT data FROM attendance_docs WHERE company_id = $1 AND path = 'settings/ea'", [req.params.companyId])).rows[0];
  const set = Object.assign({}, st && st.data, { date: new Date().toISOString().slice(0, 10) });
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const items = [];
  list.forEach((x) => {
    const e = byId.get(Number(x.empId));
    if (!e) return;
    const start = e.start_date ? String(e.start_date).slice(0, 10) : '';
    items.push({
      name: e.name, position: e.position || '', staffNo: String(x.staffNo || '').slice(0, 30), ic: e.id_type === 'passport' ? '' : (e.ic_no || ''), passport: e.id_type === 'passport' ? (e.ic_no || '') : '',
      epfNo: e.epf_no || '', socsoNo: e.socso_no || '', tin: e.tin_no || '', children: e.children, start: start.slice(0, 4) === year && start.slice(5, 10) !== '01-01' ? start : '', end: /^\d{4}-\d{2}-\d{2}$/.test(String(x.end || '')) ? x.end : '',
      a: num(x.a), b: num(x.b), c: num(x.c), pcb: num(x.pcb), cp38: num(x.cp38), zakat: num(x.zakat), donation: num(x.donation), tp1Relief: num(x.tp1Relief), tp1Zakat: num(x.tp1Zakat),
      childRelief: num(x.childRelief), fundName: 'KWSP (EPF)', epf: num(x.epf), socso: num(x.socso), exempt: num(x.exempt)
    });
  });
  if (!items.length) return bad(res, '找不到这些员工。 Employees not found.');
  const doc = buildEaPdf(co, set, year, items);
  const base = await docs.fileBase('ea_form', req.params.companyId, { PERIOD: year, EMP: items.length === 1 ? docs.hyphenUpper(items[0].name) : 'ALL' }, 'EA-' + year);
  try { await docs.logEvent(req, req.params.companyId, 'ea_form', base + '.pdf', 'generated', [{ field: 'forms', from: '', to: String(items.length) }]); } catch (e) { console.error('EA log failed:', e); }
  docs.stampPdfkitPages(doc, docs.stampText(await docs.userNameFor(req)));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-File-Name', encodeURIComponent(base + '.pdf'));
  doc.pipe(res);
  doc.end();
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Writes: [{op: 'set' | 'delete', path, data}] — all or nothing. A document is replaced as a whole.
router.post(BASE + '/batch', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const ops = req.body && req.body.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 60) return bad(res, 'Invalid request');
  const mgr = isMgr(req);
  for (const o of ops) {
    if (!o || !['set', 'delete'].includes(o.op) || typeof o.path !== 'string' || !PATH_RE.test(o.path)) return bad(res, 'Invalid request');
    const coll = o.path.slice(0, o.path.indexOf('/'));
    if (MGR_WRITE.has(coll) && !mgr) return res.status(403).json({ error: '只有店长 / manager 可以做这个操作。 Only a manager can do this.' });
    if (o.op === 'set' && (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC)) return bad(res, 'Invalid request');
  }
  const cid = req.params.companyId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      if (o.op === 'delete') await client.query('DELETE FROM attendance_docs WHERE company_id = $1 AND path = $2', [cid, o.path]);
      else {
        await client.query(
          `INSERT INTO attendance_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5, now())
           ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_by = $5, updated_at = now()`,
          [cid, o.path, o.path.slice(0, o.path.indexOf('/')), JSON.stringify(o.data), req.user.sub]
        );
      }
    }
    await client.query(
      `INSERT INTO attendance_settings (company_id, enabled, rev) VALUES ($1,false,1)
       ON CONFLICT (company_id) DO UPDATE SET rev = attendance_settings.rev + 1`,
      [cid]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

router.use((err, req, res, next) => {
  console.error('attendance route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
