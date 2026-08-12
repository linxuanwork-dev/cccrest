const express = require('express');
const { pool } = require('../db');
const { scopeToCompany, requireAuth } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

router.get('/companies/:companyId/employees', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM employees WHERE company_id = $1 ORDER BY name',
    [req.params.companyId]
  );
  res.json(rows);
});

router.post('/companies/:companyId/employees', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { name, icNo, position, bankName, bankAccount, epfNo, socsoNo, basicSalary } = req.body || {};
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'Employee name is required' });

  const { rows } = await pool.query(
    `INSERT INTO employees (company_id, name, ic_no, position, bank_name, bank_account, epf_no, socso_no, basic_salary, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
    [
      req.params.companyId, trimmedName, icNo || null, position || null,
      bankName || null, bankAccount || null, epfNo || null, socsoNo || null,
      Number(basicSalary) || 0
    ]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Added employee', companyRows[0].name, trimmedName);
  res.status(201).json(rows[0]);
});

router.patch('/companies/:companyId/employees/:employeeId', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { rows: before } = await pool.query(
    'SELECT * FROM employees WHERE id = $1 AND company_id = $2',
    [req.params.employeeId, req.params.companyId]
  );
  if (!before[0]) return res.status(404).json({ error: 'Not found' });

  const b = before[0];
  const body = req.body || {};
  const fields = {
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : b.name,
    ic_no: body.icNo !== undefined ? (body.icNo || null) : b.ic_no,
    position: body.position !== undefined ? (body.position || null) : b.position,
    bank_name: body.bankName !== undefined ? (body.bankName || null) : b.bank_name,
    bank_account: body.bankAccount !== undefined ? (body.bankAccount || null) : b.bank_account,
    epf_no: body.epfNo !== undefined ? (body.epfNo || null) : b.epf_no,
    socso_no: body.socsoNo !== undefined ? (body.socsoNo || null) : b.socso_no,
    basic_salary: body.basicSalary !== undefined ? (Number(body.basicSalary) || 0) : b.basic_salary,
    active: typeof body.active === 'boolean' ? body.active : b.active
  };

  const { rows } = await pool.query(
    `UPDATE employees SET name=$1, ic_no=$2, position=$3, bank_name=$4, bank_account=$5, epf_no=$6, socso_no=$7, basic_salary=$8, active=$9
     WHERE id = $10 RETURNING *`,
    [fields.name, fields.ic_no, fields.position, fields.bank_name, fields.bank_account, fields.epf_no, fields.socso_no, fields.basic_salary, fields.active, req.params.employeeId]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Updated employee', companyRows[0].name, fields.name);
  res.json(rows[0]);
});

module.exports = router;
