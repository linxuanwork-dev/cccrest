const express = require('express');
const { pool } = require('../db');
const { scopeToCompany, requireAuth } = require('../auth');
const { logActivity } = require('../lib/activity');
const { renderLetterheadHeader, renderTable, PDFDocument } = require('../lib/pdf');

const router = express.Router();

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Suggested EPF/SOCSO/EIS using commonly-published flat percentages — an
// estimate to review, not a guarantee against the current official KWSP/
// PERKESO tables. PCB is intentionally left out: it depends on personal
// reliefs this system doesn't capture, so it's always a manual entry.
function suggestStatutory(wage) {
  const epfEmployee = round2(wage * 0.11);
  const epfEmployer = round2(wage * (wage <= 5000 ? 0.13 : 0.12));
  const capped = Math.min(wage, 6000);
  const socsoEmployee = round2(capped * 0.005);
  const socsoEmployer = round2(capped * 0.0175);
  const eisEmployee = round2(capped * 0.002);
  const eisEmployer = round2(capped * 0.002);
  return { epfEmployee, epfEmployer, socsoEmployee, socsoEmployer, eisEmployee, eisEmployer };
}

router.get('/companies/:companyId/payroll/suggest', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { employeeId, allowances } = req.query;
  const { rows } = await pool.query(
    'SELECT basic_salary FROM employees WHERE id = $1 AND company_id = $2',
    [employeeId, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });
  const wage = Number(rows[0].basic_salary) + (Number(allowances) || 0);
  res.json({ basicSalary: Number(rows[0].basic_salary), ...suggestStatutory(wage) });
});

router.get('/companies/:companyId/payroll', requireAuth, scopeToCompany, async (req, res) => {
  const { period } = req.query;
  const params = [req.params.companyId];
  let where = 'WHERE pe.company_id = $1';
  if (period) {
    params.push(period);
    where += ' AND pe.period_month = $2';
  }
  const { rows } = await pool.query(
    `SELECT pe.*, e.name AS employee_name
     FROM payroll_entries pe JOIN employees e ON e.id = pe.employee_id
     ${where} ORDER BY pe.period_month DESC, e.name`,
    params
  );
  res.json(rows);
});

router.post('/companies/:companyId/payroll', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const {
    employeeId, period, basicSalary, allowances,
    epfEmployee, epfEmployer, socsoEmployee, socsoEmployer, eisEmployee, eisEmployer, pcb
  } = req.body || {};
  if (!employeeId || !period) return res.status(400).json({ error: 'employeeId and period are required' });

  const { rows: empRows } = await pool.query(
    'SELECT name FROM employees WHERE id = $1 AND company_id = $2',
    [employeeId, req.params.companyId]
  );
  if (!empRows[0]) return res.status(404).json({ error: 'Employee not found' });

  const basic = Number(basicSalary) || 0;
  const allow = Number(allowances) || 0;
  const epfE = Number(epfEmployee) || 0;
  const socsoE = Number(socsoEmployee) || 0;
  const eisE = Number(eisEmployee) || 0;
  const pcbAmt = Number(pcb) || 0;
  const netPay = round2(basic + allow - epfE - socsoE - eisE - pcbAmt);

  const { rows } = await pool.query(
    `INSERT INTO payroll_entries
      (company_id, employee_id, period_month, basic_salary, allowances,
       epf_employee, epf_employer, socso_employee, socso_employer, eis_employee, eis_employer, pcb, net_pay, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending') RETURNING *`,
    [
      req.params.companyId, employeeId, period, basic, allow,
      epfE, Number(epfEmployer) || 0, socsoE, Number(socsoEmployer) || 0, eisE, Number(eisEmployer) || 0, pcbAmt, netPay
    ]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Ran payroll', companyRows[0].name, empRows[0].name + ' — ' + period + ' (Net RM ' + netPay.toFixed(2) + ')');

  res.status(201).json(rows[0]);
});

router.patch('/companies/:companyId/payroll/:entryId', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { rows: before } = await pool.query(
    'SELECT * FROM payroll_entries WHERE id = $1 AND company_id = $2',
    [req.params.entryId, req.params.companyId]
  );
  if (!before[0]) return res.status(404).json({ error: 'Not found' });

  const b = before[0];
  const body = req.body || {};
  const status = body.status === 'Paid' ? 'Paid' : body.status === 'Pending' ? 'Pending' : b.status;
  const paymentDate = status === 'Paid' ? (body.paymentDate || b.payment_date || new Date().toISOString().slice(0, 10)) : null;

  const { rows } = await pool.query(
    'UPDATE payroll_entries SET status = $1, payment_date = $2, updated_at = now() WHERE id = $3 RETURNING *',
    [status, paymentDate, req.params.entryId]
  );

  const { rows: empRows } = await pool.query('SELECT name FROM employees WHERE id = $1', [b.employee_id]);
  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  if (b.status !== status) {
    await logActivity(req.user.sub, 'Updated payroll status', companyRows[0].name, empRows[0].name + ' — ' + b.period_month + ' → ' + status);
  }

  res.json(rows[0]);
});

router.get('/companies/:companyId/payroll/:entryId/voucher.pdf', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pe.*, e.name AS employee_name, e.position, e.bank_name, e.bank_account
     FROM payroll_entries pe JOIN employees e ON e.id = pe.employee_id
     WHERE pe.id = $1 AND pe.company_id = $2`,
    [req.params.entryId, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const entry = rows[0];

  const { rows: companyRows } = await pool.query(
    'SELECT name, registration_no, address, letterhead_data_url FROM companies WHERE id = $1',
    [req.params.companyId]
  );

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Salary-Voucher-' + entry.period_month + '.pdf"');
  doc.pipe(res);

  renderLetterheadHeader(doc, companyRows[0], 'Salary Payment Voucher', entry.period_month);

  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
  doc.text('Employee: ' + entry.employee_name + (entry.position ? '  (' + entry.position + ')' : ''));
  if (entry.bank_name || entry.bank_account) {
    doc.text('Bank: ' + (entry.bank_name || '—') + '  ' + (entry.bank_account || ''));
  }
  doc.text('Status: ' + entry.status + (entry.payment_date ? '  ·  Paid on ' + entry.payment_date : ''));
  doc.moveDown(1);

  renderTable(doc, [
    { key: 'label', label: 'Item', width: 2 },
    { key: 'amount', label: 'Amount (RM)', width: 1, align: 'right' }
  ], [
    { label: 'Basic Salary', amount: Number(entry.basic_salary).toFixed(2) },
    { label: 'Allowances', amount: Number(entry.allowances).toFixed(2) },
    { label: 'EPF (Employee)', amount: '-' + Number(entry.epf_employee).toFixed(2) },
    { label: 'SOCSO (Employee)', amount: '-' + Number(entry.socso_employee).toFixed(2) },
    { label: 'EIS (Employee)', amount: '-' + Number(entry.eis_employee).toFixed(2) },
    { label: 'PCB', amount: '-' + Number(entry.pcb).toFixed(2) },
    { label: 'Net Pay', amount: Number(entry.net_pay).toFixed(2) }
  ]);

  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(8).fillColor('#888888').text(
    'EPF/SOCSO/EIS shown here are computed estimates and should be checked against the current official rates before filing.',
    { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
  );

  doc.moveDown(2.5);
  const sigY = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a');
  doc.text('_____________________', 40, sigY);
  doc.text('Prepared by', 40, sigY + 14);
  doc.text('_____________________', 230, sigY);
  doc.text('Approved by', 230, sigY + 14);
  doc.text('_____________________', 420, sigY);
  doc.text('Received by', 420, sigY + 14);

  doc.end();
});

module.exports = router;
