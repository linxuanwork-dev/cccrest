const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const docs = require('../lib/docs');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const tuitionLang = require('../lib/tuitionLang');
const hqBill = require('../lib/hqBill');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Tuition fee reconciliation & MT Allowance (学费对账 & Allowance) for one company (a tuition centre): the students of each branch, the
// package price / allowance list, the monthly teacher rosters and the bank statements with their matching. The page is
// server/assets/tuition/app.html (shown inside the company's "Tuition & Allowance" page). Everything is kept as small documents
// (students/, settings/, rosters/, bank/) in tuition_docs. The Owner switches it on per company in the Control Panel.
// Only CC CREST people use it: admin / manager, and assigned staff with the "Tuition & Allowance" level (L1 look, L2 work,
// L3 also the price / allowance settings). Company users (clients) never can — see getAccess in lib/access.js.

const PAGE = path.join(__dirname, '..', 'assets', 'tuition', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const PATH_RE = /^(students|settings|rosters|bank|claims|hqbills)\/[A-Za-z0-9_.:-]{1,80}$/;
const MGR_ONLY = new Set(['settings/packages', 'settings/config', 'settings/mts', 'settings/mtprofiles']);   // fees, allowance rates, bank / invoice settings, MT deductions, MT profiles
const MGR_READ = new Set(['settings/mtprofiles']);
const ADMIN_ONLY = new Set(['settings/packages', 'settings/config']);   // price list, allowance rates, bank / invoice / HQ price settings: the CC CREST admin (Owner) only   // not even sent to non-managers: the MTs' bank account and IC numbers
const MAX_DOC = 900 * 1024;

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, c.file_prefix, COALESCE(s.enabled, false) AS enabled, COALESCE(s.rev, 0) AS rev
       FROM companies c LEFT JOIN tuition_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  return r ? { name: r.name, short: r.file_prefix || '', enabled: r.enabled, rev: Number(r.rev) } : null;
}

// ============ CONTROL PANEL (Owner): switch the feature on per company ============

router.get('/tuition/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM tuition_docs d WHERE d.company_id = c.id)::int AS docs
     FROM companies c LEFT JOIN tuition_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows);
});

router.put('/tuition/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const enabled = !!(req.body && req.body.enabled === true);
  await pool.query(
    `INSERT INTO tuition_settings (company_id, enabled, rev, updated_at) VALUES ($1,$2,1, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, rev = tuition_settings.rev + 1, updated_at = now()`,
    [req.params.id, enabled]
  );
  await logActivity(req.user.sub, 'Updated Tuition & Allowance settings', s.name, enabled ? 'on' : 'off');
  res.json({ ok: true });
});

// ============ COMPANY SIDE ============

// The page itself (shown in an iframe); the data endpoints below do the real checks.
router.get('/tuition/app', requireAuth, (req, res) => {
  res.type('html').send(tuitionLang.pageFor(String(req.query.lang || 'zh')));   // zh / en / ms
});

const BASE = '/companies/:companyId/tuition';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('tuition', level)];
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || req.pageAccess.level >= 3));
async function enabledSettings(req, res) {
  const s = await loadSettings(req.params.companyId);
  if (!s || !s.enabled) { bad(res, '这家公司还没有开通学费对账。 Tuition & Allowance is not switched on for this company.'); return null; }
  return s;
}

// Whether the feature is on for this company, and what this user may do on the page
router.get(BASE, ...guard(1), async (req, res) => {
  const s = await loadSettings(req.params.companyId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ enabled: s.enabled, name: s.name, uid: String(req.user.sub), mgr: isMgr(req), admin: !!(req.user && req.user.role === 'admin'), canWrite: !!(req.pageAccess && req.pageAccess.level >= 2) });
});

// Everything the page shows, in one request. The page asks again every few seconds with the revision it has and gets "same" back
// when nothing changed.
router.get(BASE + '/sync', ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  if (req.query.rev !== undefined && String(s.rev) === String(req.query.rev)) return res.json({ same: true, rev: s.rev });
  const { rows } = await pool.query('SELECT path, coll, data FROM tuition_docs WHERE company_id = $1', [req.params.companyId]);
  const by = { students: [], settings: [], rosters: [], bank: [], claims: [], hqbills: [] };
  const mgr = isMgr(req);
  rows.forEach((r) => { if (!mgr && MGR_READ.has(r.path)) return; (by[r.coll] = by[r.coll] || []).push({ id: r.path.slice(r.coll.length + 1), data: r.data }); });
  res.json({ rev: s.rev, docs: by });
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Writes: [{op: 'set' | 'delete', path, data}] — all or nothing. A document is replaced as a whole.
router.post(BASE + '/batch', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const ops = req.body && req.body.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 50) return bad(res, 'Invalid request');
  const mgr = isMgr(req);
  for (const o of ops) {
    if (!o || !['set', 'delete'].includes(o.op) || typeof o.path !== 'string' || !PATH_RE.test(o.path)) return bad(res, 'Invalid request');
    if (ADMIN_ONLY.has(o.path) && !(req.user && req.user.role === 'admin')) return res.status(403).json({ error: '价目表和设置只有 CC admin 可以改。 Only the CC CREST admin can change the price list and settings.' });
    if (MGR_ONLY.has(o.path) && !mgr) return res.status(403).json({ error: '价目表、Allowance 设定和银行设置只有 manager 可以改。 Only a manager can change the price list and settings.' });
    if (o.path.startsWith('claims/') && !mgr) return res.status(403).json({ error: 'MT claim 只有 manager 可以批准或退回。 Only a manager can approve or return a claim.' });
    if (o.op === 'set' && (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC)) return bad(res, 'Invalid request');
  }
  const cid = req.params.companyId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      if (o.op === 'delete') await client.query('DELETE FROM tuition_docs WHERE company_id = $1 AND path = $2', [cid, o.path]);
      else {
        await client.query(
          `INSERT INTO tuition_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5, now())
           ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_by = $5, updated_at = now()`,
          [cid, o.path, o.path.slice(0, o.path.indexOf('/')), JSON.stringify(o.data), req.user.sub]
        );
      }
    }
    await client.query(
      `INSERT INTO tuition_settings (company_id, enabled, rev) VALUES ($1,false,1)
       ON CONFLICT (company_id) DO UPDATE SET rev = tuition_settings.rev + 1`,
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

// ---- Bukku import files: the rows are written into Bukku's own template (server/assets/tuition/bukku), so the comment lines, the
// column headings, the column order and the formats are exactly what Bukku gives. rows = arrays of cells starting at column B. ----
const BUKKU_TEMPLATES = { invoice: 'sales-invoice-template.xlsx', payment: 'sales-payment-template.xlsx' };
router.post(BASE + '/bukku-file', ...guard(1), async (req, res) => {
  const type = req.body && req.body.type, rows = req.body && req.body.rows;
  if (!BUKKU_TEMPLATES[type] || !Array.isArray(rows) || rows.length > 3000) return bad(res, 'Invalid request');
  for (const r of rows) {
    if (!Array.isArray(r) || r.length > 30 || r.some((v) => v !== null && !['string', 'number'].includes(typeof v))) return bad(res, 'Invalid request');
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(__dirname, '..', 'assets', 'tuition', 'bukku', BUKKU_TEMPLATES[type]));
  const ws = wb.worksheets[0];
  let hdr = 0;
  for (let i = 1; i <= 80 && !hdr; i++) { if (/^Contact Code/.test(String(ws.getRow(i).getCell(2).value || ''))) hdr = i; }
  if (!hdr) return bad(res, 'Template problem');
  for (let i = hdr + 1; i <= ws.rowCount; i++) ws.getRow(i).eachCell({ includeEmpty: false }, (c) => { c.value = null; });   // the sample lines
  rows.forEach((cells, k) => {
    const row = ws.getRow(hdr + 1 + k);
    cells.forEach((v, j) => { if (v !== null && v !== '') row.getCell(2 + j).value = v; });
  });
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// ---- HQ bills (QC GROUP -> a branch): read the PDF into its lines; the page does the matching, pricing and the Bukku file ----
router.post(BASE + '/hq-parse', ...guard(2), express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Invalid request');
  let text;
  try { text = (await require('pdf-parse/lib/pdf-parse.js')(req.body)).text; } catch (e) { return bad(res, '读不到这个 PDF。 Cannot read this PDF.'); }
  const bill = hqBill.parseBill(text, String(req.query.name || ''));
  if (!bill.items.length) return bad(res, '这个 PDF 里找不到账单的行（要 QC GROUP 的 HQ 单）。 No bill lines found: it must be a QC GROUP HQ bill.');
  res.json(bill);
});

// ---- MT Claim form logins (DIDIK MULIA): a manager opens a login for each MT; the MT fills the claim form on /mt-claim ----
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newPassword = () => Array.from(crypto.randomBytes(10)).map((b) => PW_CHARS[b % PW_CHARS.length]).join('');
const slug = (t) => String(t || '').toLowerCase().replace(/^mt\s+/, '').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 14);
const mtOut = (r) => ({ id: r.id, branch: r.branch, mt: r.mt, username: r.username, active: r.active, mustChange: r.must_change, lastLogin: r.last_login });

router.get(BASE + '/mt-users', ...guard(3), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tuition_mt_users WHERE company_id = $1 ORDER BY branch, mt', [req.params.companyId]);
  res.json(rows.map(mtOut));
});

router.post(BASE + '/mt-users', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {}, branch = String(b.branch || ''), mt = String(b.mt || '').trim().toUpperCase();
  if (!['BBU', 'TST', 'TDA'].includes(branch) || !mt || mt.length > 80) return bad(res, 'Invalid request');
  let username = String(b.username || '').trim().toLowerCase();
  if (!username) username = slug(mt) + '.' + branch.toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return bad(res, '用户名只能用英文字母、数字、点、横线，3 到 40 个字。');
  const pw = newPassword();
  try {
    const { rows } = await pool.query(
      `INSERT INTO tuition_mt_users (company_id, branch, mt, username, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.companyId, branch, mt, username, await bcrypt.hash(pw, 10)]
    );
    await logActivity(req.user.sub, 'Opened an MT claim login', mt, branch);
    res.json({ user: mtOut(rows[0]), password: pw });
  } catch (e) {
    if (e.code === '23505') return bad(res, '这位 MT 已经有账号了，或者这个用户名被用了。 That MT already has a login, or the user name is taken.');
    throw e;
  }
});

router.post(BASE + '/mt-users/:id/reset', ...guard(3), async (req, res) => {
  const pw = newPassword();
  const { rows } = await pool.query(
    'UPDATE tuition_mt_users SET password_hash = $3, must_change = true WHERE id = $1 AND company_id = $2 RETURNING *',
    [req.params.id, req.params.companyId, await bcrypt.hash(pw, 10)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Reset an MT claim password', rows[0].mt, rows[0].branch);
  res.json({ user: mtOut(rows[0]), password: pw });
});

router.put(BASE + '/mt-users/:id', ...guard(3), async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE tuition_mt_users SET active = $3 WHERE id = $1 AND company_id = $2 RETURNING *',
    [req.params.id, req.params.companyId, !!(req.body && req.body.active)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ user: mtOut(rows[0]) });
});

// The page builds its Excel files in the browser; this puts the system's print stamp (date + user, in the print footer) on them
// before they are saved, like every other download.
router.post(BASE + '/stamp', ...guard(1), express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Invalid request');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.body); } catch (e) { return bad(res, 'Cannot read this Excel file.'); }
  docs.stampWorkbook(wb, docs.stampText(await docs.userNameFor(req)));
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

router.use((err, req, res, next) => {
  console.error('tuitionAllowance route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
