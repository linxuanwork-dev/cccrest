const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — same wrapper as dailySales.js.
['get', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'kwsp');

// Only these files are ever served from the assets folder (signed-in users only).
const ASSET_WHITELIST = /^(spec\.json|filler\.js|ssm\.js|ocr\.js|authletter\.js|lang\.js|templates\/(kwsp1|portal|b1|b2|sip1|sip1a|sip2|sip2a)\.pdf|vendor\/(pdf-lib\.min\.js|pdf\.min\.js|pdf\.worker\.min\.js|tesseract\/(tesseract\.min\.js|worker\.min\.js|tesseract-core-lstm\.wasm\.js|tesseract-core-simd-lstm\.wasm\.js|eng\.traineddata\.gz)))$/;

// The form page itself (shown inside the HR > KWSP & PERKESO panel). It reads the company id from its URL and
// talks to the endpoints below, which do the real permission checks.
router.get('/kwsp/app', requireAuth, (req, res) => {
  res.sendFile(path.join(ASSET_DIR, 'borang.html'));
});

router.get('/kwsp/assets/*', requireAuth, (req, res) => {
  const rel = req.params[0];
  if (!ASSET_WHITELIST.test(rel)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(ASSET_DIR, rel));
});

// The saved data sets of one company. Reading needs HR (payroll) Read Only; changing needs Create / Create & Update.
router.get('/companies/:companyId/kwsp-forms', requireAuth, scopeToCompany, requirePage('payroll', 1), async (req, res) => {
  const { rows: companyRows } = await pool.query('SELECT name, registration_no FROM companies WHERE id = $1', [req.params.companyId]);
  if (!companyRows[0]) return res.status(404).json({ error: 'Company not found' });
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.data, f.updated_at, COALESCE(u.display_name, '') AS updated_by
       FROM kwsp_forms f LEFT JOIN users u ON u.id = f.updated_by
      WHERE f.company_id = $1 ORDER BY f.updated_at DESC`,
    [req.params.companyId]
  );
  res.json({
    canEdit: req.pageAccess.level >= 2,
    canDelete: req.pageAccess.level >= 3,
    company: { name: companyRows[0].name, registrationNo: companyRows[0].registration_no || '' },
    forms: rows.map((r) => ({ id: r.id, name: r.name, data: r.data, updatedAt: r.updated_at, updatedBy: r.updated_by }))
  });
});

// Save (create or replace) one data set; the name is the company name written on the form.
router.put('/companies/:companyId/kwsp-forms', requireAuth, scopeToCompany, requirePage('payroll', 2), async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().toUpperCase().slice(0, 200);
  const data = body.data;
  if (!name) return res.status(400).json({ error: 'Company name is required before saving' });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Invalid form data' });
  if (JSON.stringify(data).length > 1000000) return res.status(413).json({ error: 'Form data is too large' });

  // The page auto-saves as you type: it sends the id of the record it is working on, so a company name that is
  // corrected after reading the SSM file renames that record instead of creating another one.
  const id = Number(body.id) || 0;
  const auto = !!body.auto;
  if (id) {
    const { rows: own } = await pool.query('SELECT id, name FROM kwsp_forms WHERE id = $1 AND company_id = $2', [id, req.params.companyId]);
    if (own[0]) {
      if (req.pageAccess.level < 3) return res.status(403).json({ error: '你的权限不足（修改已保存的资料需要 L3 或以上）' });
      let updated;
      try {
        ({ rows: updated } = await pool.query(
          'UPDATE kwsp_forms SET name = $1, data = $2, updated_by = $3, updated_at = now() WHERE id = $4 RETURNING id, name, updated_at',
          [name, JSON.stringify(data), req.user.sub, id]
        ));
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A saved data set with this name already exists' });
        throw err;
      }
      if (!auto || own[0].name !== name) {
        const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
        await logActivity(req.user.sub, 'Updated KWSP & PERKESO form data', companyRows[0].name, name);
      }
      return res.json({ id: updated[0].id, name: updated[0].name, updatedAt: updated[0].updated_at });
    }
  }

  const { rows: existing } = await pool.query('SELECT id FROM kwsp_forms WHERE company_id = $1 AND name = $2', [req.params.companyId, name]);
  if (existing[0] && req.pageAccess.level < 3) {
    return res.status(403).json({ error: '你的权限不足（修改已保存的资料需要 L3 或以上）' });
  }
  const { rows } = await pool.query(
    `INSERT INTO kwsp_forms (company_id, name, data, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (company_id, name) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, name, updated_at`,
    [req.params.companyId, name, JSON.stringify(data), req.user.sub]
  );
  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, existing[0] ? 'Updated KWSP & PERKESO form data' : 'Saved KWSP & PERKESO form data', companyRows[0].name, name);
  res.json({ id: rows[0].id, name: rows[0].name, updatedAt: rows[0].updated_at });
});

// What was read from the SSM documents also goes into the company profile: empty profile fields are filled (nothing
// already typed there is overwritten) and the readings are kept as a snapshot (directors, incorporation date ...).
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
function profileAddress(name, a) {
  if (!a || !(a.line1 || a.pc)) return null;
  return { name, street: [a.line1, a.line2, a.line3].map((x) => clip(x, 200)).filter(Boolean).join(', '), city: clip(a.city, 80), postcode: clip(a.pc, 10), country: 'Malaysia', state: clip(a.state, 60) };
}
router.put('/companies/:companyId/profile/ssm', requireAuth, scopeToCompany, requirePage('payroll', 2), async (req, res) => {
  const b = req.body || {};
  const c = b.company || {};
  const dirs = (Array.isArray(b.directors) ? b.directors : []).slice(0, 20).map((d) => ({
    name: clip(d.name, 120), ic: clip(d.ic, 30), nat: clip(d.nat, 60), email: clip(d.email, 120), addr: clip(d.addr, 300), dob: clip(d.dob, 12), race: clip(d.race, 40)
  })).filter((d) => d.name);
  const addresses = [profileAddress('Business address', b.bizAddr), profileAddress('Registered address', b.regAddr)].filter(Boolean);
  const first = addresses[0];
  const snapshot = { name: clip(c.name, 200), reg: clip(c.reg, 40), oldReg: clip(c.oldReg, 40), incDate: clip(c.incDate, 12), nature: clip(c.nature, 200), msicCode: clip(c.msicCode, 10), msicDesc: clip(c.msicDesc, 200), directors: dirs, savedAt: new Date().toISOString() };
  const { rows } = await pool.query(
    `UPDATE companies SET
       legal_name = COALESCE(NULLIF(legal_name, ''), $1),
       registration_no = COALESCE(NULLIF(registration_no, ''), $2),
       old_registration_no = COALESCE(NULLIF(old_registration_no, ''), $3),
       msic_code = COALESCE(NULLIF(msic_code, ''), $4),
       msic_description = COALESCE(NULLIF(msic_description, ''), $5),
       addresses = CASE WHEN jsonb_array_length(addresses) = 0 THEN $6::jsonb ELSE addresses END,
       address = CASE WHEN address IS NULL OR address = '' THEN $7 ELSE address END,
       ssm_data = $8::jsonb
     WHERE id = $9 RETURNING name`,
    [snapshot.name || null, snapshot.reg || null, snapshot.oldReg || null, snapshot.msicCode || null, snapshot.msicDesc || null,
      JSON.stringify(addresses), first ? [first.street, [first.postcode, first.city].filter(Boolean).join(' '), first.state].filter(Boolean).join(', ') : null,
      JSON.stringify(snapshot), req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Saved SSM details to company profile', rows[0].name, snapshot.reg);
  res.json({ ok: true });
});

router.delete('/companies/:companyId/kwsp-forms/:formId', requireAuth, scopeToCompany, requirePage('payroll', 3), async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM kwsp_forms WHERE id = $1 AND company_id = $2 RETURNING name',
    [Number(req.params.formId) || 0, req.params.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Deleted KWSP & PERKESO form data', companyRows[0].name, rows[0].name);
  res.json({ ok: true });
});

module.exports = router;
