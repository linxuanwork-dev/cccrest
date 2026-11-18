const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// The inbox: a small program on the office computer watches a folder per company and uploads every new bill file (PDF / photo) here with a token
// of that company. The files are read and checked in the Purchases Bill page (the reading is done in the browser).
// A token can only upload to ONE company and cannot read anything back.

const bad = (res, msg) => res.status(400).json({ error: msg });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hashToken = (t) => crypto.createHash('sha256').update('inbox-token:' + t).digest('hex');
const OK_EXT = /\.(pdf|jpe?g|png|webp)$/i;
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// ============ Control Panel (Owner): the tokens ============

router.get('/inbox/tokens', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.company_id, c.name AS company, t.name, t.active, t.created_at, t.last_used_at,
       (SELECT COUNT(*) FROM inbox_files f WHERE f.uploaded_via = t.id)::int AS files
       FROM inbox_tokens t JOIN companies c ON c.id = t.company_id ORDER BY t.active DESC, c.name, t.id`);
  res.json(rows.map((r) => ({ id: r.id, companyId: r.company_id, company: r.company, name: r.name, active: r.active, createdAt: r.created_at, lastUsedAt: r.last_used_at, files: r.files })));
});

// the token is shown ONCE (only its hash is kept)
router.post('/inbox/tokens', requireAuth, requireRole('admin'), async (req, res) => {
  const companyId = Number(req.body && req.body.companyId) || 0;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!companyId || !name) return bad(res, '请选公司，并给这台电脑起个名字（例如「办公室」）。 Choose the company and name the computer.');
  const { rows: co } = await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
  if (!co[0]) return res.status(404).json({ error: 'Not found' });
  const token = 'cci_' + crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query('INSERT INTO inbox_tokens (company_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [companyId, name, hashToken(token), req.user.sub]);
  await logActivity(req.user.sub, 'Made a folder-watcher token', co[0].name, name);
  res.status(201).json({ id: rows[0].id, token });
});

router.delete('/inbox/tokens/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('UPDATE inbox_tokens SET active = false WHERE id = $1 RETURNING company_id, name', [Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await logActivity(req.user.sub, 'Switched off a folder-watcher token', String(rows[0].company_id), rows[0].name);
  res.json({ ok: true });
});

// ============ the watcher program: upload (no login; the token says which company) ============

router.post('/inbox/upload', express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
  const h = String(req.headers.authorization || '');
  const token = /^Bearer\s+(cci_[a-f0-9]{48})$/.exec(h);
  if (!token) return res.status(401).json({ error: 'Missing or wrong token' });
  const { rows: tk } = await pool.query('SELECT id, company_id FROM inbox_tokens WHERE token_hash = $1 AND active', [hashToken(token[1])]);
  if (!tk[0]) return res.status(401).json({ error: 'Missing or wrong token' });
  const name = String(req.query.name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  if (/\.(xlsx|csv)$/i.test(name)) {   // an MMSDO settlement report for the TNG Report page of this company
    if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Empty file.');
    const tng = require('./tngReport');
    if (!(await tng.isEnabled(tk[0].company_id))) return bad(res, 'TNG Report is not switched on for this company.');
    await pool.query('UPDATE inbox_tokens SET last_used_at = now() WHERE id = $1', [tk[0].id]);
    let r; try { r = await tng.saveFile(tk[0].company_id, name, req.body, { viaToken: tk[0].id }); } catch (e) { return res.status(422).json({ error: e.message, rejected: true }); }
    const info = await docs.companyInfo(tk[0].company_id);
    const stored = (info.PREFIX || 'CO') + '-TNG-MMSDO-' + String(r.period || '').replace('-', '_') + '.' + name.split('.').pop().toLowerCase();
    return res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: !!r.duplicate, id: r.id, name: stored, kind: 'tng' });
  }
  if (!OK_EXT.test(name)) return bad(res, 'Only PDF, JPG, PNG or WEBP files (or an .xlsx / .csv TNG report).');
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Empty file.');
  const buf = req.body, hash = sha(buf), ext = name.split('.').pop().toLowerCase();
  await pool.query('UPDATE inbox_tokens SET last_used_at = now() WHERE id = $1', [tk[0].id]);
  const { rows: dup } = await pool.query('SELECT id, stored_name, status FROM inbox_files WHERE company_id = $1 AND sha256 = $2', [tk[0].company_id, hash]);
  if (dup[0]) return res.json({ ok: true, duplicate: true, id: dup[0].id, name: dup[0].stored_name, status: dup[0].status });
  // the name the program saves the file under afterwards: PREFIX-PURCHASE-YYYY_MM-NNN.ext
  const info = await docs.companyInfo(tk[0].company_id);
  const ym = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).slice(0, 7).replace('-', '_');
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM inbox_files WHERE company_id = $1 AND to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY_MM') = $2`, [tk[0].company_id, ym]);
  const stored = (info.PREFIX || 'CO') + '-PURCHASE-' + ym + '-' + String(cnt[0].n + 1).padStart(3, '0') + '.' + ext;
  const { rows } = await pool.query(
    'INSERT INTO inbox_files (company_id, original_name, stored_name, mime, size, sha256, data, uploaded_via) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [tk[0].company_id, name, stored, MIME[ext] || 'application/octet-stream', buf.length, hash, buf, tk[0].id]
  );
  res.status(201).json({ ok: true, id: rows[0].id, name: stored });
});

// ============ the Purchases Bill page: the files waiting ============

const BASE = '/companies/:companyId/inbox';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('purchases', level)];

router.get(BASE, ...guard(1), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.original_name, f.stored_name, f.size, f.status, f.bill_no, f.created_at, f.handled_at, u.display_name AS handled_by
       FROM inbox_files f LEFT JOIN users u ON u.id = f.handled_by
      WHERE f.company_id = $1 AND (f.status = 'new' OR f.handled_at > now() - interval '14 days') ORDER BY (f.status = 'new') DESC, f.created_at DESC LIMIT 300`, [req.params.companyId]);
  res.json({ files: rows.map((r) => ({ id: r.id, name: r.original_name, storedName: r.stored_name, size: r.size, status: r.status, billNo: r.bill_no || '', createdAt: r.created_at, handledAt: r.handled_at, handledBy: r.handled_by || '' })) });
});

router.get(BASE + '/:id/file', ...guard(1), async (req, res) => {
  const { rows } = await pool.query('SELECT original_name, mime, data FROM inbox_files WHERE id = $1 AND company_id = $2', [Number(req.params.id) || 0, req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', rows[0].mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + String(rows[0].original_name).replace(/"/g, '') + '"');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(rows[0].data);
});

router.post(BASE + '/:id/status', ...guard(2), async (req, res) => {
  const status = req.body && req.body.status;
  if (!['new', 'done', 'dismissed'].includes(status)) return bad(res, 'Invalid request');
  const { rows } = await pool.query(
    `UPDATE inbox_files SET status = $3, bill_no = $4, handled_by = CASE WHEN $3::text = 'new' THEN NULL::int ELSE $5::int END, handled_at = CASE WHEN $3::text = 'new' THEN NULL::timestamptz ELSE now() END
      WHERE id = $1 AND company_id = $2 RETURNING id`,
    [Number(req.params.id) || 0, req.params.companyId, status, String((req.body && req.body.billNo) || '').slice(0, 60) || null, req.user.sub]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
