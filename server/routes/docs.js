const express = require('express');
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — same wrapper as dailySales.js.
['get', 'put', 'post', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// ---------- Control Panel: file naming (Owner only) ----------

router.get('/doc-settings', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT feature_key, pattern FROM doc_settings');
  const byKey = Object.fromEntries(rows.map((r) => [r.feature_key, r.pattern]));
  res.json({
    features: docs.FEATURES.map((f) => ({ key: f.key, label: f.label, builtin: f.builtin, ext: f.ext, letter: !!f.letter, soon: !!f.soon, pattern: byKey[f.key] || '' })),
    tokens: docs.TOKENS
  });
});

router.put('/doc-settings', requireRole('admin'), async (req, res) => {
  const patterns = (req.body && req.body.patterns) || {};
  const changes = [];
  for (const [key, raw] of Object.entries(patterns)) {
    if (!docs.FEATURE_BY_KEY[key]) return res.status(400).json({ error: 'Unknown feature: ' + key });
    const pattern = String(raw || '').trim();
    if (pattern) {
      const problem = docs.validatePattern(pattern);
      if (problem) return res.status(400).json({ error: docs.FEATURE_BY_KEY[key].label + ': ' + problem });
    }
  }
  for (const [key, raw] of Object.entries(patterns)) {
    const pattern = String(raw || '').trim();
    if (pattern) {
      await pool.query(
        `INSERT INTO doc_settings (feature_key, pattern, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (feature_key) DO UPDATE SET pattern = EXCLUDED.pattern, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, pattern, req.user.sub]
      );
    } else {
      await pool.query('DELETE FROM doc_settings WHERE feature_key = $1', [key]);
    }
    changes.push(docs.FEATURE_BY_KEY[key].label + ': ' + (pattern || '(built-in)'));
  }
  if (changes.length) await logActivity(req.user.sub, 'Updated file naming', 'Control Panel', changes.join('; ').slice(0, 900));
  res.json({ ok: true });
});

router.post('/doc-settings/preview', requireRole('admin'), async (req, res) => {
  const pattern = String((req.body && req.body.pattern) || '').trim();
  const problem = docs.validatePattern(pattern);
  if (problem) return res.json({ error: problem });
  const companyId = Number(req.body && req.body.companyId) || 0;
  res.json({ name: await docs.previewName(pattern, companyId) });
});

// ---------- per company: the next file name (and a history entry for the file made) ----------

const clean = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

router.post('/companies/:companyId/documents', requireAuth, scopeToCompany, async (req, res) => {
  const b = req.body || {};
  const feature = docs.FEATURE_BY_KEY[b.feature];
  if (!feature) return res.status(400).json({ error: 'Unknown feature' });
  const ctx = {};
  ['EMP', 'PERIOD', 'TITLE', 'BRANCH'].forEach((k) => { if (b.ctx && b.ctx[k]) ctx[k] = docs.hyphenUpper(clean(b.ctx[k], 80)); });
  const info = (await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId])).rows[0];
  if (!info) return res.status(404).json({ error: 'Not found' });
  // single PERKESO forms keep the spaces in their name ("DM-BORANG 1", "DM-SIP 1A") so they can be uploaded one by one
  if (b.ctx && b.ctx.FORM) ctx.FORM = docs.cleanFileName(clean(b.ctx.FORM, 40)).toUpperCase();
  let fallback = docs.cleanFileName(clean(b.fallback, 150)) || (docs.hyphenUpper(info.name) + '-' + feature.key.toUpperCase());
  if (feature.key === 'kwsp_form_single' && ctx.FORM) fallback = (await docs.companyInfo(req.params.companyId)).PREFIX + '-' + ctx.FORM;
  const base = await docs.fileBase(feature.key, req.params.companyId, ctx, fallback);
  const fileName = base + '.' + feature.ext;
  if (b.log !== false) await docs.logEvent(req, req.params.companyId, feature.key, fileName, 'generated', []);
  res.json({ name: base, fileName });
});

// ---------- history of everything made / changed for the company ----------

router.get('/companies/:companyId/documents', requireAuth, scopeToCompany, async (req, res) => {
  const params = [req.params.companyId];
  let where = 'company_id = $1';
  if (req.query.type) { params.push(String(req.query.type)); where += ' AND doc_type = $' + params.length; }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const { rows } = await pool.query(
    `SELECT id, doc_type, doc_ref, event, details, user_name, created_at FROM document_events WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    params
  );
  res.json({
    types: Object.fromEntries(docs.FEATURES.map((f) => [f.key, f.label]).concat([['company_profile', 'Company profile'], ['kwsp_form', 'KWSP & PERKESO form data'], ['employee', 'Employee record'], ['purchase_bukku_entry', 'Purchase bill entry']])),
    events: rows.map((r) => ({ id: r.id, docType: r.doc_type, docRef: r.doc_ref, event: r.event, details: r.details, userName: r.user_name, createdAt: r.created_at }))
  });
});

// ---------- e-Invoice information sheet (printable, to give to customers) ----------

router.get('/companies/:companyId/einvoice-info.pdf', requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Not found' });
  const addr = (Array.isArray(c.addresses) && c.addresses[0]) || null;
  const street = addr ? String(addr.street || '').split(/\s*\n\s*/).map((s) => s.replace(/[,\s]+$/, '')).filter(Boolean).join(', ') : '';
  const address = addr ? [street, [addr.postcode, addr.city].filter(Boolean).join(' '), addr.state, addr.country].filter(Boolean).join(', ') : (c.address || '');
  const regLabel = { BRN: 'Registration No. (BRN)', NRIC: 'Registration No. (NRIC)', Passport: 'Registration No. (Passport)', Army: 'Registration No. (Army)' }[c.reg_type] || 'Registration No.';
  const fields = [
    ['Company Full Name', (c.legal_name || c.name || '').toUpperCase()],
    [regLabel + ' — new', c.registration_no || ''],
    ['Registration No. — old', c.old_registration_no || ''],
    ['TIN No.', c.tin || ''],
    ['Company Address', address.toUpperCase()],
    ['Email', c.email || ''],
    ['SST No. (if any)', c.sst_no || '-']
  ];

  const fallback = docs.hyphenUpper(c.name) + '-EINVOICE-INFO';
  const base = await docs.fileBase('einvoice_info', c.id, {}, fallback);
  const fileName = base + '.pdf';
  await docs.logEvent(req, c.id, 'einvoice_info', fileName, 'generated', []);

  const doc = new PDFDocument({ margin: 56, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fileName.replace(/"/g, '') + '"');
  doc.pipe(res);

  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  let y = 56;
  if (c.logo_data_url) {
    try {
      const m = c.logo_data_url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { doc.image(Buffer.from(m[2], 'base64'), left, y, { fit: [90, 50] }); }
    } catch (e) { /* unsupported logo image: leave it out */ }
  }
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111').text('e-Invoice Information', left + (c.logo_data_url ? 104 : 0), y + 8, { width: width - (c.logo_data_url ? 104 : 0) });
  y += 64;
  doc.font('Helvetica').fontSize(10).fillColor('#444444').text('Please use these details when issuing e-Invoices to us.', left, y, { width });
  y += 34;

  const labelW = 170, rowPad = 9;
  fields.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').fontSize(10);
    const lh = doc.heightOfString(label, { width: labelW - 16 });
    doc.font('Helvetica').fontSize(11);
    const vh = doc.heightOfString(value || ' ', { width: width - labelW - 16 });
    const h = Math.max(lh, vh) + rowPad * 2;
    doc.lineWidth(0.7).strokeColor('#999999').rect(left, y, width, h).stroke();
    doc.moveTo(left + labelW, y).lineTo(left + labelW, y + h).stroke();
    doc.rect(left, y, labelW, h).fillOpacity(0.06).fill('#000000').fillOpacity(1);
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10).text(label, left + 8, y + rowPad, { width: labelW - 16 });
    doc.font('Helvetica').fontSize(11).text(value, left + labelW + 8, y + rowPad, { width: width - labelW - 16 });
    y += h;
  });

  docs.stampPdfkitPages(doc, docs.stampText(await docs.userNameFor(req)));
  doc.end();
});

module.exports = router;
