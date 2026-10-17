const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const { slugify } = require('../lib/mockGen');

const router = express.Router();
const PERIOD = '2026-08';

const letterheadUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Unsupported file type — use JPG, PNG, or WEBP.'));
    cb(null, true);
  }
});

function baseCompanyQuery(whereClause) {
  return `
    SELECT c.id, c.name, c.type, c.slug, c.enabled_features, c.registration_no, c.address,
      COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS staff,
      COALESCE(json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name, 'permissions', cs.permissions, 'canApprove', cs.can_approve)) FILTER (WHERE s.id IS NOT NULL), '[]') AS staff_detail,
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
    // Each staff member is told their own levels on each company, so the app can hide pages they have no access to.
    return res.json(rows.map((r) => {
      const me = (r.staff_detail || []).find((s) => s.id === staffId);
      return Object.assign({}, r, { my_access: me ? { permissions: me.permissions, canApprove: me.canApprove } : null });
    }));
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

router.patch('/companies/:companyId', requireRole('admin'), async (req, res) => {
  const { name, type, registrationNo, address } = req.body || {};
  const { rows: before } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
  if (!before[0]) return res.status(404).json({ error: 'Not found' });

  const trimmedName = typeof name === 'string' && name.trim() ? name.trim() : before[0].name;
  const newSlug = trimmedName !== before[0].name ? slugify(trimmedName) : before[0].slug;
  const newType = typeof type === 'string' && type.trim() ? type.trim() : before[0].type;
  const newRegNo = typeof registrationNo === 'string' ? (registrationNo.trim() || null) : before[0].registration_no;
  const newAddress = typeof address === 'string' ? (address.trim() || null) : before[0].address;

  try {
    await pool.query(
      'UPDATE companies SET name = $1, slug = $2, type = $3, registration_no = $4, address = $5 WHERE id = $6',
      [trimmedName, newSlug, newType, newRegNo, newAddress, req.params.companyId]
    );
    await logActivity(req.user.sub, 'Updated company profile', trimmedName, null);
    const { rows: full } = await pool.query(baseCompanyQuery('WHERE c.id = $1'), [req.params.companyId]);
    res.json(full[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A company with that name already exists' });
    throw err;
  }
});

router.get('/companies/:companyId/profile', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, type, registration_no, address, letterhead_data_url FROM companies WHERE id = $1',
    [req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.post('/companies/:companyId/letterhead', requireRole('admin'), letterheadUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const dataUrl = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  const { rows } = await pool.query(
    'UPDATE companies SET letterhead_data_url = $1 WHERE id = $2 RETURNING id, name',
    [dataUrl, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Uploaded letterhead', rows[0].name, null);
  res.json({ ok: true });
});

router.delete('/companies/:companyId/letterhead', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE companies SET letterhead_data_url = NULL WHERE id = $1 RETURNING id, name',
    [req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Removed letterhead', rows[0].name, null);
  res.json({ ok: true });
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
