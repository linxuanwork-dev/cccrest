const express = require('express');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
const PERIOD = '2026-08';

router.get('/companies/:companyId/reconciliation-batches', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM reconciliation_batches WHERE company_id = $1 AND period_month = $2',
    [req.params.companyId, PERIOD]
  );
  if (!rows[0]) return res.json(null);

  const { rows: lines } = await pool.query(
    'SELECT * FROM reconciliation_line_items WHERE batch_id = $1 ORDER BY date',
    [rows[0].id]
  );
  res.json({ batch: rows[0], lines });
});

router.post('/companies/:companyId/reconciliation-batches/generate-bukku', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });

  const { rows } = await pool.query(
    `UPDATE reconciliation_batches
     SET output_summary_ready = true, output_sales_ready = true, output_payment_ready = true,
         output_carryover_ready = true, output_flags_ready = true, updated_at = now()
     WHERE company_id = $1 AND period_month = $2 RETURNING *`,
    [req.params.companyId, PERIOD]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No reconciliation batch for this period' });

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Generated Bukku templates', companyRows[0].name, 'Sales, Payment, carryover, and flags files generated');

  res.json(rows[0]);
});

module.exports = router;
