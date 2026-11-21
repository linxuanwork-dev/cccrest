const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
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

// the audit log, newest first (filters: company, module)
router.get('/audit-log', ...guard, async (req, res) => {
  const where = []; const args = [];
  if (req.query.company) { args.push(parseInt(req.query.company, 10) || 0); where.push('company_id = $' + args.length); }
  if (req.query.module) { args.push(String(req.query.module)); where.push('module = $' + args.length); }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const { rows } = await pool.query(
    `SELECT id, at, who, company_id, module, record, action, field, before, after, reason FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, args);
  res.json(rows);
});

module.exports = router;
