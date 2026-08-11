const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');

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

module.exports = router;
