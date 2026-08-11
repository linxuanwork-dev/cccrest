const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { scopeToCompany, requireAuth } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

const CLAIM_CATEGORIES = ['Transport', 'Equipment Repair', 'Utilities', 'Cleaning Supplies', 'Stationery', 'Meals', 'Other'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Unsupported file type — use JPG, PNG, WEBP, or PDF.'));
    cb(null, true);
  }
});

async function extractClaimFromImage(buffer, mimetype) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('OCR is not configured on this server (ANTHROPIC_API_KEY missing)');

  const base64 = buffer.toString('base64');
  const contentBlock = mimetype === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mimetype, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64 } };

  const prompt = `This is a receipt or invoice for a staff reimbursement claim. Extract the following fields and respond with ONLY a JSON object, no other text, no markdown fences:
{
  "amount": <number, the total amount paid, no currency symbol>,
  "date": "<YYYY-MM-DD>",
  "vendor": "<merchant/vendor name>",
  "category": "<one of: ${CLAIM_CATEGORIES.join(', ')}>",
  "description": "<short one-line description of what was purchased>",
  "confidence": "<high, medium, or low - how confident you are this was read correctly>"
}
If a field cannot be determined, use null for that field.`;

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
    })
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    throw new Error(`OCR request failed (${apiRes.status}): ${errText.slice(0, 200)}`);
  }

  const data = await apiRes.json();
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error('OCR returned an empty response');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse the OCR response');

  return JSON.parse(jsonMatch[0]);
}

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

// Reads an uploaded receipt/invoice via Claude's vision API and returns extracted
// fields for review — does NOT save anything, that's a separate confirm step.
router.post('/companies/:companyId/claims/ocr', requireAuth, scopeToCompany, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const extracted = await extractClaimFromImage(req.file.buffer, req.file.mimetype);
    res.json(extracted);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.post('/companies/:companyId/claims', requireAuth, scopeToCompany, async (req, res) => {
  const { staffId, category, amount, date, description } = req.body || {};
  if (!staffId || !category || !amount || !date) {
    return res.status(400).json({ error: 'staffId, category, amount, and date are required' });
  }

  if (req.user.role === 'staff' && Number(staffId) !== req.user.staffId) {
    return res.status(403).json({ error: 'You can only submit claims for yourself' });
  }

  const { rows: assignedRows } = await pool.query(
    'SELECT 1 FROM company_staff WHERE company_id = $1 AND staff_id = $2',
    [req.params.companyId, staffId]
  );
  if (!assignedRows[0]) return res.status(400).json({ error: 'That staff member is not assigned to this company' });

  const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM claim_bills WHERE company_id = $1', [req.params.companyId]);
  const claimNo = 'CLM-' + (5000 + Number(countRows[0].count));

  const { rows } = await pool.query(
    `INSERT INTO claim_bills (company_id, claim_no, staff_id, category, amount, date, status)
     VALUES ($1,$2,$3,$4,$5,$6,'Pending') RETURNING *`,
    [req.params.companyId, claimNo, staffId, category, amount, date]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  const { rows: staffRows } = await pool.query('SELECT name FROM staff WHERE id = $1', [staffId]);
  await logActivity(
    req.user.sub,
    'Submitted claim bill',
    companyRows[0].name,
    staffRows[0].name + ' — ' + claimNo + ' (RM ' + Number(amount).toFixed(2) + ')' + (description ? ': ' + description : '')
  );

  res.status(201).json(rows[0]);
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
