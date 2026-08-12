const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const rules = require('../lib/dmInvoiceRules');

const router = express.Router();

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'dm-sale-invoice-template.xlsx');

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are accepted for the DM REG & MOD bill.'));
    cb(null, true);
  }
});

const listUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/csv', 'application/vnd.ms-excel'];
    if (!allowed.includes(file.mimetype) && !/\.(xlsx|csv)$/i.test(file.originalname || '')) {
      return cb(new Error('Only .xlsx or .csv files are accepted for the master list.'));
    }
    cb(null, true);
  }
});

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function extractBillFromPdf(buffer) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('OCR is not configured on this server (ANTHROPIC_API_KEY missing)');

  const base64 = buffer.toString('base64');
  const prompt = `This is a "DM REG & MOD" bill — a monthly consolidated purchases bill listing many clients' registrations and module purchases for one branch (TDA, TST, or BBU). Extract the branch, the invoice month/year, and every line item, and respond with ONLY a JSON object, no other text, no markdown fences:
{
  "branch": "<TDA, TST, or BBU>",
  "year": "<4-digit year of the bill, e.g. 2026>",
  "month": "<2-digit month of the bill, e.g. 07>",
  "lines": [
    {
      "type": "<registration or module>",
      "clientName": "<client's full name as printed>",
      "nric": "<client's NRIC number, digits only, from the parentheses after their name>",
      "jersiSize": "<jersi/uniform size if printed for this line, e.g. Pendek, Panjang, or null if not applicable>"
    }
  ]
}
"PENDAFTARAN PENUH" lines are type "registration" (one bundled row per client — do not split into sub-items). "PEMBELIAN MODUL" lines are type "module". Extract every line item on the bill, in the order they appear. If a field cannot be determined, use null for that field.`;

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    throw new Error(`Bill extraction failed (${apiRes.status}): ${errText.slice(0, 200)}`);
  }

  const data = await apiRes.json();
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error('Extraction returned an empty response');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse the extraction response');
  return JSON.parse(jsonMatch[0]);
}

// ============ BILL CONVERSION ============

router.post('/companies/:companyId/dm-invoice/extract', requireAuth, scopeToCompany, pdfUpload.single('file'), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let extracted;
  try {
    extracted = await extractBillFromPdf(req.file.buffer);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const branch = extracted.branch;
  if (!rules.BRANCHES.includes(branch)) {
    return res.status(422).json({ error: `Could not determine a valid branch (got "${branch}") — please check the PDF.` });
  }

  const { rows: lookupRows } = await pool.query(
    'SELECT name, customer_code FROM dm_customer_lookup WHERE company_id = $1 AND branch = $2',
    [req.params.companyId, branch]
  );
  const lookupByName = new Map(lookupRows.map((r) => [normalizeName(r.name), r.customer_code]));

  const rows = (extracted.lines || []).map((line) => {
    const type = line.type === 'module' ? 'module' : 'registration';
    let gender = null;
    let product = 'MODULE';
    let amount = rules.MODULE_PRICE;
    if (type === 'registration') {
      gender = rules.genderFromNric(line.nric);
      product = rules.registrationProduct(gender);
      amount = rules.registrationPrice(gender, line.jersiSize);
    }
    return {
      type,
      clientName: line.clientName || '',
      nric: line.nric || '',
      jersiSize: line.jersiSize || null,
      gender,
      product,
      amount,
      customerCode: lookupByName.get(normalizeName(line.clientName)) || null
    };
  });

  res.json({ branch, year: String(extracted.year || ''), month: String(extracted.month || ''), rows });
});

router.post('/companies/:companyId/dm-invoice/generate', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { branch, year, month, rows } = req.body || {};
  if (!rules.BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch must be TDA, TST, or BBU' });
  if (!year || !month) return res.status(400).json({ error: 'year and month are required' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'At least one row is required' });
  for (const row of rows) {
    if (!row.customerCode) return res.status(400).json({ error: `Missing customer code for ${row.clientName || 'a row'}` });
  }

  // Remember any new branch+name -> code pairs for next time.
  for (const row of rows) {
    if (!row.clientName) continue;
    const { rows: existing } = await pool.query(
      'SELECT id FROM dm_customer_lookup WHERE company_id = $1 AND branch = $2 AND lower(trim(name)) = lower(trim($3))',
      [req.params.companyId, branch, row.clientName]
    );
    if (!existing[0]) {
      await pool.query(
        'INSERT INTO dm_customer_lookup (company_id, branch, name, customer_code) VALUES ($1,$2,$3,$4)',
        [req.params.companyId, branch, row.clientName, row.customerCode]
      );
    }
  }

  const yy = String(year).slice(-2);
  const mm = String(month).padStart(2, '0');
  const dateStr = `01/${mm}/${year}`;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws = wb.getWorksheet('Worksheet');

  const HEADER_ROW = 31;
  const FIRST_DATA_ROW = 32;
  const maxExisting = ws.rowCount;
  if (maxExisting >= FIRST_DATA_ROW) {
    for (let r = FIRST_DATA_ROW; r <= maxExisting; r++) {
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => { cell.value = null; });
    }
  }

  rows.forEach((row, i) => {
    const r = FIRST_DATA_ROW + i;
    ws.getCell(`B${r}`).value = row.customerCode;
    ws.getCell(`C${r}`).value = rules.invoiceNoPattern(row.type, branch, yy, mm);
    ws.getCell(`E${r}`).value = dateStr;
    ws.getCell(`J${r}`).value = branch;
    ws.getCell(`M${r}`).value = row.product;
    ws.getCell(`N${r}`).value = rules.ACCOUNTS[row.type];
    ws.getCell(`O${r}`).value = rules.itemDescription(row.type, branch, year, mm);
    ws.getCell(`P${r}`).value = 1;
    ws.getCell(`S${r}`).value = Number(row.amount);
  });

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Generated Registration & Modul invoice', companyRows[0].name, `${branch} ${mm}/${year} — ${rows.length} rows`);

  const filename = `sales-invoice-${branch}-${mm}${year}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ============ CUSTOMER LOOKUP MANAGEMENT ============

router.get('/companies/:companyId/dm-invoice/customers', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { branch } = req.query;
  const params = [req.params.companyId];
  let where = 'WHERE company_id = $1';
  if (branch) {
    params.push(branch);
    where += ' AND branch = $2';
  }
  const { rows } = await pool.query(`SELECT * FROM dm_customer_lookup ${where} ORDER BY branch, name`, params);
  res.json(rows);
});

router.post('/companies/:companyId/dm-invoice/customers', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { branch, name, customerCode } = req.body || {};
  if (!rules.BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch must be TDA, TST, or BBU' });
  if (!name || !customerCode) return res.status(400).json({ error: 'name and customerCode are required' });

  const { rows } = await pool.query(
    'INSERT INTO dm_customer_lookup (company_id, branch, name, customer_code) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.companyId, branch, name.trim(), customerCode.trim()]
  );
  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Added DM customer code', companyRows[0].name, `${branch} — ${name.trim()} (${customerCode.trim()})`);
  res.status(201).json(rows[0]);
});

router.patch('/companies/:companyId/dm-invoice/customers/:customerId', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { rows: before } = await pool.query(
    'SELECT * FROM dm_customer_lookup WHERE id = $1 AND company_id = $2',
    [req.params.customerId, req.params.companyId]
  );
  if (!before[0]) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const branch = rules.BRANCHES.includes(body.branch) ? body.branch : before[0].branch;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : before[0].name;
  const customerCode = typeof body.customerCode === 'string' && body.customerCode.trim() ? body.customerCode.trim() : before[0].customer_code;

  const { rows } = await pool.query(
    'UPDATE dm_customer_lookup SET branch = $1, name = $2, customer_code = $3 WHERE id = $4 RETURNING *',
    [branch, name, customerCode, req.params.customerId]
  );
  res.json(rows[0]);
});

router.delete('/companies/:companyId/dm-invoice/customers/:customerId', requireAuth, scopeToCompany, async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  await pool.query('DELETE FROM dm_customer_lookup WHERE id = $1 AND company_id = $2', [req.params.customerId, req.params.companyId]);
  res.json({ ok: true });
});

function findHeaderIndex(headerRow, candidates) {
  for (let i = 0; i < headerRow.length; i++) {
    const cell = String(headerRow[i] || '').trim().toLowerCase();
    if (candidates.includes(cell)) return i;
  }
  return -1;
}

router.post('/companies/:companyId/dm-invoice/customers/import', requireAuth, scopeToCompany, listUpload.single('file'), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(req.file.originalname || '') || req.file.mimetype.includes('csv')) {
      await wb.csv.read(require('stream').Readable.from(req.file.buffer));
    } else {
      await wb.xlsx.load(req.file.buffer);
    }
  } catch (err) {
    return res.status(422).json({ error: 'Could not read the file — make sure it is a valid .xlsx or .csv.' });
  }

  const ws = wb.worksheets[0];
  if (!ws) return res.status(422).json({ error: 'The file has no sheets.' });

  const headerRow = (ws.getRow(1).values || []).map((v) => v);
  const branchIdx = findHeaderIndex(headerRow, ['branch']);
  const nameIdx = findHeaderIndex(headerRow, ['name', 'customer name', 'client name']);
  const codeIdx = findHeaderIndex(headerRow, ['customer code', 'code', 'bukku code']);

  if (branchIdx === -1 || nameIdx === -1 || codeIdx === -1) {
    return res.status(422).json({ error: 'Could not find Branch, Name, and Customer Code columns — check the header row.' });
  }

  let added = 0;
  let updated = 0;
  const skipped = [];

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r).values || [];
    const branch = String(row[branchIdx] || '').trim().toUpperCase();
    const name = String(row[nameIdx] || '').trim();
    const customerCode = String(row[codeIdx] || '').trim();
    if (!branch && !name && !customerCode) continue;
    if (!rules.BRANCHES.includes(branch) || !name || !customerCode) {
      skipped.push({ row: r, branch, name, customerCode });
      continue;
    }

    const { rows: existing } = await pool.query(
      'SELECT id FROM dm_customer_lookup WHERE company_id = $1 AND branch = $2 AND lower(trim(name)) = lower(trim($3))',
      [req.params.companyId, branch, name]
    );
    if (existing[0]) {
      await pool.query('UPDATE dm_customer_lookup SET customer_code = $1, name = $2 WHERE id = $3', [customerCode, name, existing[0].id]);
      updated++;
    } else {
      await pool.query(
        'INSERT INTO dm_customer_lookup (company_id, branch, name, customer_code) VALUES ($1,$2,$3,$4)',
        [req.params.companyId, branch, name, customerCode]
      );
      added++;
    }
  }

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Imported DM customer master list', companyRows[0].name, `${added} added, ${updated} updated, ${skipped.length} skipped`);

  res.json({ added, updated, skipped });
});

module.exports = router;
