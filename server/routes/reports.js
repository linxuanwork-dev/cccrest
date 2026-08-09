const express = require('express');
const { pool } = require('../db');
const { scopeToCompany, requireAuth } = require('../auth');

const router = express.Router();

router.get('/companies/:companyId/sales', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT date, invoice_no, gross, settled, petty_out, status FROM sales_records WHERE company_id = $1 ORDER BY date',
    [req.params.companyId]
  );
  res.json(rows);
});

router.get('/companies/:companyId/bank', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT date, description, debit, credit, balance, status FROM bank_statement_entries WHERE company_id = $1 ORDER BY date, id',
    [req.params.companyId]
  );
  res.json(rows);
});

router.get('/companies/:companyId/purchases', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT invoice_no, supplier, amount, date, status FROM purchase_bills WHERE company_id = $1 ORDER BY date, id',
    [req.params.companyId]
  );
  res.json(rows);
});

router.get('/companies/:companyId/claims', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cb.claim_no, s.name AS staff_name, cb.category, cb.amount, cb.date, cb.status
     FROM claim_bills cb LEFT JOIN staff s ON s.id = cb.staff_id
     WHERE cb.company_id = $1 ORDER BY cb.date, cb.id`,
    [req.params.companyId]
  );
  res.json(rows);
});

router.get('/companies/:companyId/petty', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT date, description, amount_in, amount_out, balance FROM petty_cash_entries WHERE company_id = $1 ORDER BY date, id',
    [req.params.companyId]
  );
  res.json(rows);
});

router.get('/companies/:companyId/merchant', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT date, txns, approved_amt, failed_amt, fee, net FROM merchant_settlements WHERE company_id = $1 ORDER BY date',
    [req.params.companyId]
  );
  res.json(rows);
});

module.exports = router;
