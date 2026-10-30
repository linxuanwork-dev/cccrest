const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { scopeToCompany, requireAuth } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — same wrapper as dailySales.js.
['get', 'post', 'patch', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

const ID_TYPES = ['B', 'L', 'T', 'P', 'PR', 'SSN', 'passport'];
const MARITAL = ['single', 'married_spouse_not_working', 'married_working_spouse', 'widow_divorced'];
const TAX_RESIDENT = ['resident', 'non_resident'];
const RACES = ['01', '02', '03', '04', '05', '06'];

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const ymd = (d) => (d instanceof Date ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : d);
const out = (r) => Object.assign({}, r, { dob: ymd(r.dob), start_date: ymd(r.start_date) });
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// Column values for an employee, read from the request body; anything the body doesn't mention keeps `base`
// (the existing row) so a partial update never wipes a field.
function readFields(body, base) {
  const has = (k) => body[k] !== undefined;
  const pick = (k, col, fn) => (has(k) ? fn(body[k]) : base[col]);
  return {
    name: has('name') && str(body.name, 200) ? str(body.name, 200) : base.name,
    ic_no: pick('icNo', 'ic_no', (v) => str(v, 30) || null),
    id_type: pick('idType', 'id_type', (v) => (ID_TYPES.includes(v) ? v : 'B')),
    dob: pick('dob', 'dob', dateOrNull),
    gender: pick('gender', 'gender', (v) => (v === 'L' || v === 'P' ? v : null)),
    race: pick('race', 'race', (v) => (RACES.includes(v) ? v : null)),
    nationality: pick('nationality', 'nationality', (v) => str(v, 60).toUpperCase() || null),
    address: pick('address', 'address', (v) => str(v, 400) || null),
    start_date: pick('startDate', 'start_date', dateOrNull),
    position: pick('position', 'position', (v) => str(v, 120) || null),
    bank_name: pick('bankName', 'bank_name', (v) => str(v, 80) || null),
    bank_account: pick('bankAccount', 'bank_account', (v) => str(v, 40) || null),
    epf_no: pick('epfNo', 'epf_no', (v) => str(v, 30) || null),
    socso_no: pick('socsoNo', 'socso_no', (v) => str(v, 30) || null),
    tin_no: pick('tinNo', 'tin_no', (v) => str(v, 30) || null),
    tax_resident: pick('taxResident', 'tax_resident', (v) => (TAX_RESIDENT.includes(v) ? v : 'resident')),
    marital_status: pick('maritalStatus', 'marital_status', (v) => (MARITAL.includes(v) ? v : null)),
    children: pick('children', 'children', (v) => Math.min(30, Math.max(0, parseInt(v, 10) || 0))),
    disabled: pick('disabled', 'disabled', (v) => v === true || v === 'true'),
    basic_salary: pick('basicSalary', 'basic_salary', (v) => Math.max(0, Number(v) || 0)),
    active: typeof body.active === 'boolean' ? body.active : base.active
  };
}

const COLUMNS = ['name', 'ic_no', 'id_type', 'dob', 'gender', 'race', 'nationality', 'address', 'start_date', 'position', 'bank_name', 'bank_account',
  'epf_no', 'socso_no', 'tin_no', 'tax_resident', 'marital_status', 'children', 'disabled', 'basic_salary', 'active'];

// A readable "what changed" list for the history (dates as plain text, no images)
function changes(before, after) {
  const view = (r) => {
    const o = {};
    COLUMNS.forEach((c) => { o[c] = ymd(r[c]); });
    return o;
  };
  return docs.diffObjects(view(before), view(after));
}

const baseRow = { name: '', ic_no: null, id_type: 'B', dob: null, gender: null, race: null, nationality: null, address: null, start_date: null, position: null,
  bank_name: null, bank_account: null, epf_no: null, socso_no: null, tin_no: null, tax_resident: 'resident', marital_status: null, children: 0, disabled: false, basic_salary: 0, active: true };

router.get('/companies/:companyId/employees', requireAuth, scopeToCompany, requirePage('payroll', 1), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.*, (SELECT count(*) FROM employee_documents d WHERE d.employee_id = e.id)::int AS document_count
       FROM employees e WHERE e.company_id = $1 ORDER BY e.name`,
    [req.params.companyId]
  );
  res.json(rows.map(out));
});

router.post('/companies/:companyId/employees', requireAuth, scopeToCompany, requirePage('payroll', 2), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const f = readFields(req.body || {}, baseRow);
  if (!f.name) return res.status(400).json({ error: 'Employee name is required' });

  const { rows } = await pool.query(
    `INSERT INTO employees (company_id, ${COLUMNS.join(', ')})
     VALUES ($1, ${COLUMNS.map((_, i) => '$' + (i + 2)).join(', ')}) RETURNING *`,
    [req.params.companyId, ...COLUMNS.map((c) => f[c])]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Added employee', companyRows[0].name, f.name);
  await docs.logEvent(req, req.params.companyId, 'employee', f.name, 'created', []);
  res.status(201).json(out(rows[0]));
});

router.patch('/companies/:companyId/employees/:employeeId', requireAuth, scopeToCompany, requirePage('payroll', 3), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { rows: before } = await pool.query('SELECT * FROM employees WHERE id = $1 AND company_id = $2', [req.params.employeeId, req.params.companyId]);
  if (!before[0]) return res.status(404).json({ error: 'Not found' });

  const f = readFields(req.body || {}, before[0]);
  const { rows } = await pool.query(
    `UPDATE employees SET ${COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${COLUMNS.length + 1} RETURNING *`,
    [...COLUMNS.map((c) => f[c]), req.params.employeeId]
  );

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Updated employee', companyRows[0].name, f.name);
  await docs.logUpdate(req, req.params.companyId, 'employee', f.name, changes(before[0], rows[0]));
  res.json(out(rows[0]));
});

// ---------- IC images (and other papers) kept with the employee ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype)) return cb(new Error('Use a JPG, PNG, WEBP or PDF file.'));
    cb(null, true);
  }
});

router.get('/companies/:companyId/employees/:employeeId/documents', requireAuth, scopeToCompany, requirePage('payroll', 1), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, kind, file_name, mime, size, uploaded_at FROM employee_documents WHERE employee_id = $1 AND company_id = $2 ORDER BY id',
    [req.params.employeeId, req.params.companyId]
  );
  res.json(rows.map((r) => ({ id: r.id, kind: r.kind, fileName: r.file_name, mime: r.mime, size: r.size, uploadedAt: r.uploaded_at })));
});

router.get('/companies/:companyId/employees/:employeeId/documents/:docId', requireAuth, scopeToCompany, requirePage('payroll', 1), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT file_name, mime, data FROM employee_documents WHERE id = $1 AND employee_id = $2 AND company_id = $3',
    [req.params.docId, req.params.employeeId, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Content-Disposition', 'inline; filename="' + rows[0].file_name.replace(/[^\w.\- ]/g, '_') + '"');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(rows[0].data);
});

router.post('/companies/:companyId/employees/:employeeId/documents', requireAuth, scopeToCompany, requirePage('payroll', 2), upload.single('file'), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { rows: emp } = await pool.query('SELECT id, name FROM employees WHERE id = $1 AND company_id = $2', [req.params.employeeId, req.params.companyId]);
  if (!emp[0]) return res.status(404).json({ error: 'Not found' });
  const kind = ['ic', 'other'].includes(req.body && req.body.kind) ? req.body.kind : 'ic';
  const { rows } = await pool.query(
    `INSERT INTO employee_documents (company_id, employee_id, kind, file_name, mime, size, data, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.params.companyId, req.params.employeeId, kind, str(req.file.originalname, 150) || 'file', req.file.mimetype, req.file.size, req.file.buffer, req.user.sub]
  );
  await docs.logUpdate(req, req.params.companyId, 'employee', emp[0].name, [{ field: kind === 'ic' ? 'IC image' : 'document', from: '', to: 'uploaded: ' + str(req.file.originalname, 60) }]);
  res.status(201).json({ id: rows[0].id });
});

router.delete('/companies/:companyId/employees/:employeeId/documents/:docId', requireAuth, scopeToCompany, requirePage('payroll', 3), async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Not allowed' });
  const { rows } = await pool.query(
    `DELETE FROM employee_documents d USING employees e
      WHERE d.id = $1 AND d.employee_id = $2 AND d.company_id = $3 AND e.id = d.employee_id RETURNING d.file_name, e.name AS employee_name`,
    [req.params.docId, req.params.employeeId, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await docs.logUpdate(req, req.params.companyId, 'employee', rows[0].employee_name, [{ field: 'IC image', from: rows[0].file_name, to: 'removed' }]);
  res.json({ ok: true });
});

// a rejected upload (wrong file type / too large) is the user's mistake, not a server error
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /^Use a JPG/.test(err.message || '')) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (8 MB at most).' : err.message });
  }
  next(err);
});

module.exports = router;
