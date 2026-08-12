const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const { slugify } = require('../lib/mockGen');

const router = express.Router();
const PERIOD = '2026-08';

function baseCompanyQuery(whereClause) {
  return `
    SELECT c.id, c.name, c.type, c.slug, c.enabled_features,
      COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS staff,
      COALESCE(json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name)) FILTER (WHERE s.id IS NOT NULL), '[]') AS staff_detail,
      rb.status, rb.exceptions_count, rb.invoices_count, rb.input_file_name,
      rb.output_summary_ready, rb.output_sales_ready, rb.output_payment_ready,
      rb.updated_at
    FROM companies c
    LEFT JOIN company_staff cs ON cs.company_id = c.id
    LEFT JOIN staff s ON s.id = cs.staff_id
    LEFT JOIN reconciliation_batches rb ON rb.company_id = c.id AND rb.period_month = '${PERIOD}'
    ${whereClause}
    GROUP BY c.id, rb.status, rb.exceptions_count, rb.invoices_count, rb.input_file_name,
      rb.output_summary_ready, rb.output_sales_ready, rb.output_payment_ready, rb.updated_at
    ORDER BY c.name
  `;
}

router.get('/companies', requireAuth, async (req, res) => {
  const { role, sub: userId, staffId, companyId } = req.user;

  if (role === 'admin') {
    const { rows } = await pool.query(baseCompanyQuery(''));
    return res.json(rows);
  }
  if (role === 'staff') {
    const { rows } = await pool.query(
      baseCompanyQuery('WHERE c.id IN (SELECT company_id FROM company_staff WHERE staff_id = $1)'),
      [staffId]
    );
    return res.json(rows);
  }
  if (role === 'manager') {
    const { rows } = await pool.query(
      baseCompanyQuery(`WHERE c.id IN (
        SELECT cs2.company_id FROM company_staff cs2
        JOIN manager_staff ms ON ms.staff_id = cs2.staff_id
        WHERE ms.manager_user_id = $1
      )`),
      [userId]
    );
    return res.json(rows);
  }
  if (role === 'client') {
    const { rows } = await pool.query(baseCompanyQuery('WHERE c.id = $1'), [companyId]);
    return res.json(rows);
  }
  res.status(403).json({ error: 'Not allowed' });
});

router.post('/companies', requireRole('admin'), async (req, res) => {
  const { name, type, shortName } = req.body || {};
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'Company name is required' });

  const slug = slugify(trimmedName);
  try {
    const { rows } = await pool.query(
      `INSERT INTO companies (name, slug, type, short_name) VALUES ($1,$2,$3,$4) RETURNING id`,
      [trimmedName, slug, (type || '').trim() || 'Company', (shortName || '').trim() || null]
    );
    await logActivity(req.user.sub, 'Added company', trimmedName, null);
    const { rows: full } = await pool.query(baseCompanyQuery('WHERE c.id = $1'), [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A company with that name already exists' });
    throw err;
  }
});

router.patch('/companies/:companyId/features', requireRole('admin'), async (req, res) => {
  const { enabledFeatures } = req.body || {};
  if (!Array.isArray(enabledFeatures)) return res.status(400).json({ error: 'enabledFeatures must be an array' });
  const { rows } = await pool.query(
    'UPDATE companies SET enabled_features = $1 WHERE id = $2 RETURNING id, name, enabled_features',
    [enabledFeatures, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Updated feature access', rows[0].name, 'Enabled: ' + enabledFeatures.join(', '));
  res.json(rows[0]);
});

router.get('/companies/:companyId', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(baseCompanyQuery('WHERE c.id = $1'), [req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ============ CLIENT LOGIN (Owner only — one login per company) ============

router.get('/companies/:companyId/client-login', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login_id, active FROM users WHERE company_id = $1 AND role = 'client'`,
    [req.params.companyId]
  );
  res.json(rows[0] || null);
});

router.post('/companies/:companyId/client-login', requireRole('admin'), async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return res.status(400).json({ error: 'loginId and password are required' });

  const { rows: existing } = await pool.query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'client'`,
    [req.params.companyId]
  );
  if (existing[0]) return res.status(400).json({ error: 'This company already has a login' });

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  if (!companyRows[0]) return res.status(404).json({ error: 'Company not found' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, company_id, active)
       VALUES ($1,$2,'client',$3,$4,true) RETURNING id, login_id, active`,
      [loginId.trim().toLowerCase(), hash, companyRows[0].name, req.params.companyId]
    );
    await logActivity(req.user.sub, 'Created client login', companyRows[0].name, 'Login ID: ' + rows[0].login_id);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'That login ID is already taken' });
    throw err;
  }
});

router.patch('/companies/:companyId/client-login', requireRole('admin'), async (req, res) => {
  const { active, password } = req.body || {};
  const { rows: existing } = await pool.query(
    `SELECT * FROM users WHERE company_id = $1 AND role = 'client'`,
    [req.params.companyId]
  );
  if (!existing[0]) return res.status(404).json({ error: 'No login exists for this company yet' });

  const newActive = typeof active === 'boolean' ? active : existing[0].active;
  const newHash = password ? await bcrypt.hash(password, 10) : existing[0].password_hash;

  const { rows } = await pool.query(
    'UPDATE users SET active = $1, password_hash = $2 WHERE id = $3 RETURNING id, login_id, active',
    [newActive, newHash, existing[0].id]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  const changes = [];
  if (existing[0].active !== newActive) changes.push(newActive ? 'access re-enabled' : 'access removed');
  if (password) changes.push('password reset');
  if (changes.length) await logActivity(req.user.sub, 'Updated client login', companyRows[0].name, changes.join('; '));

  res.json(rows[0]);
});

module.exports = router;
