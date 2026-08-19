const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const { parseMmsdoWorkbook, buildDailySettlementWorkbook } = require('../lib/olTngReport');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
    if (!allowed.includes(file.mimetype) && !/\.xlsx$/i.test(file.originalname || '')) {
      return cb(new Error('Only .xlsx files are accepted for the MMSDO settlement report.'));
    }
    cb(null, true);
  }
});

router.post('/companies/:companyId/ol-tng-report/generate', requireAuth, scopeToCompany, upload.single('file'), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const body = req.body || {};
  const createdBy = (body.createdBy || '').trim();
  const approvedBy = (body.approvedBy || '').trim();
  const approvedDate = body.approvedDate;
  const createdDate = body.createdDate || new Date().toISOString().slice(0, 10);

  if (!createdBy) return res.status(400).json({ error: 'Created By is required' });
  if (!approvedBy) return res.status(400).json({ error: 'Approved By is required' });
  if (!approvedDate) return res.status(400).json({ error: 'Approved Date is required' });

  const inputWb = new ExcelJS.Workbook();
  try {
    await inputWb.xlsx.load(req.file.buffer);
  } catch (err) {
    return res.status(422).json({ error: 'Could not read the file — make sure it is a valid .xlsx MMSDO settlement export.' });
  }

  let parsed;
  try {
    parsed = parseMmsdoWorkbook(inputWb);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const outWb = buildDailySettlementWorkbook({
    companyName: parsed.companyName,
    year: parsed.year,
    month: parsed.month,
    transactions: parsed.transactions,
    createdBy,
    createdDate,
    approvedBy,
    approvedDate
  });

  const mm = String(parsed.month).padStart(2, '0');
  const filename = `OL-TNG_${parsed.year}_${mm}.xlsx`;

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Generated OL-TNG Daily Settlement Report', companyRows[0].name, `${mm}/${parsed.year} — ${parsed.transactions.length} transactions`);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await outWb.xlsx.write(res);
  res.end();
});

module.exports = router;
