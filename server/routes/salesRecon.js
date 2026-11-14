const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Daily Sales Reconciliation (每日营业对账 → Bukku) for one restaurant company. The page is server/assets/salesrecon/app.html (shown in the company's
// Bookkeeping menu); the data is kept as small documents in sales_recon_docs. The Owner switches it on per company in the Control Panel.
// Page level = the "Sales Summary" level of the permission list: L1 look, L2 upload reports, L3 (manager) check the differences, close the month,
// change the Bukku settings and export the files.

const PAGE = path.join(__dirname, '..', 'assets', 'salesrecon', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const PATH_RE = /^(src|adj|closing|settings|log)\/[A-Za-z0-9_.:-]{1,80}$/;
const MGR_WRITE = new Set(['adj', 'closing', 'settings']);   // checking, closing and the Bukku settings are the manager's; uploading and the log are L2
const MAX_DOC = 900 * 1024;
const KEEP_MONTHS = 15;                                       // the page works on the reports of the last ~15 months

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, COALESCE(s.enabled, false) AS enabled, COALESCE(s.rev, 0) AS rev
       FROM companies c LEFT JOIN sales_recon_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  return r ? { name: r.name, enabled: r.enabled, rev: Number(r.rev) } : null;
}

// ============ CONTROL PANEL (Owner) ============

router.get('/sales-recon/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM sales_recon_docs d WHERE d.company_id = c.id)::int AS docs
     FROM companies c LEFT JOIN sales_recon_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows);
});

router.put('/sales-recon/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const enabled = !!(req.body && req.body.enabled === true);
  await pool.query(
    `INSERT INTO sales_recon_settings (company_id, enabled, rev, updated_at) VALUES ($1,$2,1, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, rev = sales_recon_settings.rev + 1, updated_at = now()`,
    [req.params.id, enabled]
  );
  await logActivity(req.user.sub, 'Updated Daily Sales Reconciliation settings', s.name, enabled ? 'on' : 'off');
  res.json({ ok: true });
});

// ============ COMPANY SIDE ============

router.get('/sales-recon/app', requireAuth, (req, res) => { res.sendFile(PAGE); });

const BASE = '/companies/:companyId/sales-recon';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('sales', level)];
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || req.pageAccess.level >= 3));
async function enabledSettings(req, res) {
  const s = await loadSettings(req.params.companyId);
  if (!s || !s.enabled) { bad(res, '这家公司还没有开通每日营业对账。 Daily Sales Reconciliation is not switched on for this company.'); return null; }
  return s;
}

router.get(BASE, ...guard(1), async (req, res) => {
  const s = await loadSettings(req.params.companyId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ enabled: s.enabled, name: s.name, uid: String(req.user.sub), mgr: isMgr(req), canWrite: !!(req.pageAccess && req.pageAccess.level >= 2) });
});

// Everything the page shows, in one request; "same" when nothing changed since the revision the page has. `names` = who the user ids in the documents are.
router.get(BASE + '/sync', ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  if (req.query.rev !== undefined && String(s.rev) === String(req.query.rev)) return res.json({ same: true, rev: s.rev });
  const { rows } = await pool.query(
    `SELECT path, coll, data FROM sales_recon_docs WHERE company_id = $1
       AND (coll NOT IN ('src', 'adj', 'closing') OR (data->>'month') >= to_char(now() - ($2 || ' months')::interval, 'YYYY-MM'))
       AND (coll <> 'log' OR data->>'day' >= to_char(now() - interval '70 days', 'YYYY-MM-DD'))`,
    [req.params.companyId, String(KEEP_MONTHS)]
  );
  const by = { src: [], adj: [], closing: [], settings: [], log: [] };
  const ids = new Set();
  rows.forEach((r) => {
    (by[r.coll] = by[r.coll] || []).push({ id: r.path.slice(r.coll.length + 1), data: r.data });
    const d = r.data || {};
    [d.by, d.closedBy].forEach((x) => { if (x) ids.add(String(x)); });
    (d.files || []).forEach((f) => { if (f && f.by) ids.add(String(f.by)); });
    Object.values(d.days || {}).forEach((x) => { if (x && x.by) ids.add(String(x.by)); });
  });
  const names = {};
  const nums = [...ids].map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (nums.length) {
    const u = await pool.query('SELECT id, display_name, login_id FROM users WHERE id = ANY($1::int[])', [nums]);
    u.rows.forEach((x) => { names[String(x.id)] = x.display_name || x.login_id; });
  }
  res.json({ rev: s.rev, docs: by, names });
});

// The days a person has a clock time in the HR Attendance of the company (for the commission: no work that day = no commission)
router.get(BASE + '/worked-days', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const month = String(req.query.month || ''), name = String(req.query.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !name) return bad(res, 'Invalid request');
  const { rows } = await pool.query(
    `SELECT data FROM attendance_docs WHERE company_id = $1 AND coll = 'entries' AND data->>'date' LIKE $2`, [req.params.companyId, month + '-%']);
  const days = {};
  let entries = 0;
  rows.forEach((r) => {
    const d = r.data || {};
    if (String(d.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== name) return;
    entries++;
    const worked = ['inT', 'in1', 'in2'].some((k) => String(d[k] == null ? '' : d[k]).trim() !== '');
    days[d.date] = { worked, reason: String(d.reason || '') };
  });
  res.json({ days, entries });
});

// The month's commission of a person goes to the HR Payroll (the payroll page picks it up in its Commission column)
router.post(BASE + '/commission-to-payroll', ...guard(3), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {}, month = String(b.month || ''), name = String(b.name || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 100);
  const amount = Math.round((Number(b.amount) || 0) * 100) / 100;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !name || !(amount >= 0)) return bad(res, 'Invalid request');
  const slug = name.replace(/[^A-Za-z0-9]+/g, '_');
  const cid = req.params.companyId;
  const data = { kind: 'commission', name, month, amount, source: 'sales', at: Date.now(), by: String(req.user.sub) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO attendance_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,'payroll',$3::jsonb,$4, now())
       ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_by = $4, updated_at = now()`,
      [cid, 'payroll/COMM_' + slug + '_' + month, JSON.stringify(data), req.user.sub]);
    await client.query(
      `INSERT INTO attendance_settings (company_id, enabled, rev) VALUES ($1,false,1) ON CONFLICT (company_id) DO UPDATE SET rev = attendance_settings.rev + 1`, [cid]);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  res.json({ ok: true });
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
    if (MGR_WRITE.has(coll) && !mgr) return res.status(403).json({ error: '只有 manager 可以核对、结账和改设定。 Only a manager can do this.' });
    if (o.op === 'set' && (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC)) return bad(res, 'Invalid request');
  }
  const cid = req.params.companyId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      if (o.op === 'delete') await client.query('DELETE FROM sales_recon_docs WHERE company_id = $1 AND path = $2', [cid, o.path]);
      else {
        await client.query(
          `INSERT INTO sales_recon_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5, now())
           ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_by = $5, updated_at = now()`,
          [cid, o.path, o.path.slice(0, o.path.indexOf('/')), JSON.stringify(o.data), req.user.sub]
        );
      }
    }
    await client.query(
      `INSERT INTO sales_recon_settings (company_id, enabled, rev) VALUES ($1,false,1)
       ON CONFLICT (company_id) DO UPDATE SET rev = sales_recon_settings.rev + 1`,
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
  console.error('salesRecon route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
