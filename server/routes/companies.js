const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const { slugify } = require('../lib/mockGen');

const router = express.Router();
const PERIOD = '2026-08';

// Express 4 doesn't catch rejected promises from async handlers — same wrapper as dailySales.js.
['get', 'put', 'post', 'patch', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

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
    if (newAddress !== before[0].address) {
      // keep the profile's first address in step with the single address typed in this older dialog
      await pool.query(
        `UPDATE companies SET addresses = CASE
           WHEN jsonb_array_length(addresses) = 0 THEN jsonb_build_array(jsonb_build_object('name','Address 1','street',$1::text,'city','','postcode','','country','Malaysia','state',''))
           ELSE jsonb_set(addresses, '{0,street}', to_jsonb($1::text)) END
         WHERE id = $2`,
        [newAddress || '', req.params.companyId]
      );
    }
    await logActivity(req.user.sub, 'Updated company profile', trimmedName, null);
    const { rows: full } = await pool.query(baseCompanyQuery('WHERE c.id = $1'), [req.params.companyId]);
    res.json(full[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A company with that name already exists' });
    throw err;
  }
});

// ---- Company profile (Bukku-style). Anyone who can open the company can read it; CC CREST admin / manager edit it. ----
const REG_TYPES = ['BRN', 'NRIC', 'Passport', 'Army'];
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function profileJson(r, canEdit) {
  return {
    id: r.id, name: r.name, type: r.type, canEdit,
    // snake_case keys are what the older Edit Company dialog reads
    registration_no: r.registration_no, address: r.address, letterhead_data_url: r.letterhead_data_url,
    legalName: r.legal_name || '', regType: r.reg_type, registrationNo: r.registration_no || '', oldRegistrationNo: r.old_registration_no || '',
    tin: r.tin || '', msicCode: r.msic_code || '', msicDescription: r.msic_description || '', tourismTaxNo: r.tourism_tax_no || '',
    contactNo: r.contact_no || '', email: r.email || '', website: r.website || '',
    addresses: Array.isArray(r.addresses) ? r.addresses : [],
    logoDataUrl: r.logo_data_url || null, letterheadDataUrl: r.letterhead_data_url || null, ssm: r.ssm_data || null
  };
}

function formatAddress(a) {
  const street = String(a.street || '').split(/\s*\n\s*/).map((s) => s.replace(/[,\s]+$/, '')).filter(Boolean).join(', ');
  return [street, [a.postcode, a.city].filter(Boolean).join(' '), a.state].map((x) => (x || '').trim()).filter(Boolean).join(', ');
}

function cleanAddresses(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((a, i) => ({
    name: text(a && a.name, 80) || `Address ${i + 1}`, street: text(a && a.street, 400), city: text(a && a.city, 80),
    postcode: text(a && a.postcode, 10), country: text(a && a.country, 60) || 'Malaysia', state: text(a && a.state, 60)
  })).filter((a) => a.street || a.city || a.postcode);
}

router.get('/companies/:companyId/profile', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(profileJson(rows[0], ['admin', 'manager'].includes(req.user.role)));
});

router.put('/companies/:companyId/profile', requireAuth, scopeToCompany, requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  const { rows: before } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
  if (!before[0]) return res.status(404).json({ error: 'Not found' });
  const regType = REG_TYPES.includes(b.regType) ? b.regType : before[0].reg_type;
  const addresses = cleanAddresses(b.addresses);
  const registrationNo = text(b.registrationNo, 40) || null;
  const { rows } = await pool.query(
    `UPDATE companies SET legal_name = $1, reg_type = $2, registration_no = $3, old_registration_no = $4, tin = $5, msic_code = $6,
       msic_description = $7, tourism_tax_no = $8, contact_no = $9, email = $10, website = $11, addresses = $12, address = $13
     WHERE id = $14 RETURNING *`,
    [text(b.legalName, 200) || null, regType, registrationNo, text(b.oldRegistrationNo, 40) || null, text(b.tin, 40) || null,
      text(b.msicCode, 10) || null, text(b.msicDescription, 200) || null, text(b.tourismTaxNo, 40) || null, text(b.contactNo, 40) || null,
      text(b.email, 120) || null, text(b.website, 200) || null, JSON.stringify(addresses), addresses[0] ? formatAddress(addresses[0]) : null,
      req.params.companyId]
  );
  await logActivity(req.user.sub, 'Updated company profile', rows[0].name, null);
  res.json(profileJson(rows[0], true));
});

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(new Error('Unsupported file type — use JPG, PNG, or WEBP.'));
    cb(null, true);
  }
});

router.post('/companies/:companyId/logo', requireAuth, scopeToCompany, requireRole('admin', 'manager'), logoUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const dataUrl = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  const { rows } = await pool.query('UPDATE companies SET logo_data_url = $1 WHERE id = $2 RETURNING id, name', [dataUrl, req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Uploaded company logo', rows[0].name, null);
  res.json({ ok: true, logoDataUrl: dataUrl });
});

router.delete('/companies/:companyId/logo', requireAuth, scopeToCompany, requireRole('admin', 'manager'), async (req, res) => {
  const { rows } = await pool.query('UPDATE companies SET logo_data_url = NULL WHERE id = $1 RETURNING id, name', [req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Removed company logo', rows[0].name, null);
  res.json({ ok: true });
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
