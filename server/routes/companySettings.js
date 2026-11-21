const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const branchesLib = require('../lib/branches');
const settings = require('../lib/settings');
const auditLog = require('../lib/auditLog');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as the other route files.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Company settings and the audit log: the Owner (admin) only. Every change needs a reason and is written to the audit_log.
const guard = [requireAuth, requireRole('admin')];

// all setting rows of a company (every version), and what is in force today
router.get('/company-settings/:companyId', ...guard, async (req, res) => {
  const id = parseInt(req.params.companyId, 10); if (!id) return res.status(400).json({ error: 'Bad company' });
  const { rows } = await pool.query(
    'SELECT key, value, effective_from, note, created_by, created_at FROM company_settings WHERE company_id = $1 ORDER BY key, effective_from DESC', [id]);
  const now = await settings.effective([id], null);
  res.json({ inForce: now[id], rows });
});

router.put('/company-settings/:companyId', ...guard, async (req, res) => {
  const id = parseInt(req.params.companyId, 10); if (!id) return res.status(400).json({ error: 'Bad company' });
  const { key, value, effectiveFrom, note, reason } = req.body || {};
  const { rows } = await pool.query('SELECT 1 FROM companies WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const who = await auditLog.userName(client, req.user.sub);
    await settings.set(client, { companyId: id, key, value, effectiveFrom, note, who, userId: req.user.sub, reason });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally { client.release(); }
  const now = await settings.effective([id], null);
  res.json({ ok: true, inForce: now[id] });
});

// the branches of a company, for the pages (anyone who may open the company)
router.get('/companies/:companyId/branches', requireAuth, scopeToCompany, async (req, res) => {
  const rows = await branchesLib.list(parseInt(req.params.companyId, 10));
  res.json(rows.map((b) => ({ code: b.code, name: b.name, merchantId: b.merchant_id, sortOrder: b.sort_order })));
});

// all branches of a company, also the switched-off ones, with the extra data (Owner only: for the admin page)
router.get('/company-branches/:companyId', ...guard, async (req, res) => {
  const id = parseInt(req.params.companyId, 10); if (!id) return res.status(400).json({ error: 'Bad company' });
  res.json(await branchesLib.list(id, null, { includeInactive: true }));
});

// the admin page (company settings, branches, statutory rules, audit log): Owner only
router.get('/admin-console/app', ...guard, (req, res) => { res.sendFile(path.join(__dirname, '..', 'assets', 'admin', 'app.html')); });

// add or change a branch (Owner only; the reason and the before / after go to the audit_log)
router.put('/company-branches/:companyId', ...guard, async (req, res) => {
  const id = parseInt(req.params.companyId, 10); if (!id) return res.status(400).json({ error: 'Bad company' });
  const b = req.body || {}; const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(code)) return res.status(400).json({ error: 'Branch code: letters, digits, - and _ (up to 20)' });
  if (String(b.reason || '').trim().length < 3) return res.status(400).json({ error: 'A reason is required' });
  const found = await pool.query('SELECT 1 FROM companies WHERE id = $1', [id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'Company not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = (await client.query('SELECT code, name, merchant_id, active, sort_order, extra FROM branches WHERE company_id = $1 AND code = $2', [id, code])).rows[0] || null;
    const next = {
      name: String(b.name != null ? b.name : (before ? before.name : code)).trim() || code,
      merchant_id: b.merchantId != null ? String(b.merchantId) : (before ? before.merchant_id : null),
      active: b.active != null ? !!b.active : (before ? before.active : true),
      sort_order: Number.isFinite(+b.sortOrder) && b.sortOrder !== '' && b.sortOrder != null ? +b.sortOrder : (before ? before.sort_order : 0),
      extra: b.extra && typeof b.extra === 'object' ? b.extra : (before ? before.extra : {})
    };
    await client.query(
      `INSERT INTO branches (company_id, code, name, merchant_id, active, sort_order, extra) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name, merchant_id = EXCLUDED.merchant_id, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, extra = EXCLUDED.extra`,
      [id, code, next.name, next.merchant_id, next.active, next.sort_order, JSON.stringify(next.extra)]);
    await auditLog.write(client, { who: await auditLog.userName(client, req.user.sub), userId: req.user.sub, companyId: id, module: 'branches', record: code,
      action: before ? 'update' : 'create', field: 'branch', before: before ? JSON.stringify(before) : null, after: JSON.stringify(next), reason: b.reason });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ ok: true });
});

// the audit log, newest first. Filters: company, module, who, action, record (part of it), from / to (dates), source (e.g. activity_log), limit (up to 1000)
router.get('/audit-log', ...guard, async (req, res) => {
  const where = []; const args = [];
  const add = (cond, v) => { args.push(v); where.push(cond.replace('?', '$' + args.length)); };
  const like = (v) => String(v).replace(/[\%_]/g, '\$&');   // the text is searched as text: % and _ are not wildcards
  if (req.query.company) add('company_id = ?', parseInt(req.query.company, 10) || 0);
  if (req.query.module) add('module = ?', String(req.query.module));
  if (req.query.who) add('who ILIKE ?', '%' + like(req.query.who) + '%');
  if (req.query.action) add('action = ?', String(req.query.action));
  if (req.query.record) add('record ILIKE ?', '%' + like(req.query.record) + '%');
  if (req.query.source) add('source LIKE ?', like(req.query.source) + '%');
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) add('at >= ?::date', req.query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) add("at < (?::date + 1)", req.query.to);
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const { rows } = await pool.query(
    `SELECT id, at, who, company_id, module, record, action, field, before, after, reason, source FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, args);
  res.json(rows);
});

module.exports = router;
