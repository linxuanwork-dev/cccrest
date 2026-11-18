const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// 个人所得税 Form B / BE: the Owner (admin) only. Clients, assets and returns hold personal data (IC, TIN, income): nobody else can read them.
// The page (server/assets/taxb/app.html) keeps its data as small documents in tax_docs.
const COLLS = ['taxrules', 'taxclients', 'taxreturns'];
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_DOC = 900 * 1024;
const guard = [requireAuth, requireRole('admin')];
const RULES_DIR = path.join(__dirname, '..', 'assets', 'taxb', 'rules');

// the first time: the tax rules of the years that were made with the page (YA2025 final, YA2026 draft)
async function seedRules() {
  const { rows } = await pool.query("SELECT 1 FROM tax_docs WHERE coll = 'taxrules' LIMIT 1");
  if (rows[0]) return;
  for (const f of fs.readdirSync(RULES_DIR).filter((x) => /^\d{4}\.json$/.test(x))) {
    const data = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'));
    await pool.query("INSERT INTO tax_docs (coll, id, data) VALUES ('taxrules', $1, $2::jsonb) ON CONFLICT DO NOTHING", [f.slice(0, 4), JSON.stringify(data)]);
  }
}

router.get('/tax/docs/:coll', ...guard, async (req, res) => {
  if (!COLLS.includes(req.params.coll)) return res.status(404).json({ error: 'Not found' });
  if (req.params.coll === 'taxrules') await seedRules();
  const { rows } = await pool.query('SELECT id, data, updated_at FROM tax_docs WHERE coll = $1 ORDER BY id', [req.params.coll]);
  res.json({ docs: rows.map((r) => ({ id: r.id, data: r.data, updatedAt: r.updated_at })) });
});

router.put('/tax/docs/:coll/:id', ...guard, async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLS.includes(coll) || !ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
  if (coll === 'taxrules' && !/^\d{4}$/.test(id)) return res.status(400).json({ error: 'The tax rules are kept by year (YA).' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Invalid request' });
  const text = JSON.stringify(body);
  if (text.length > MAX_DOC) return res.status(400).json({ error: '资料太大。 Too large.' });
  await pool.query(
    `INSERT INTO tax_docs (coll, id, data, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,$4, now())
     ON CONFLICT (coll, id) DO UPDATE SET data = $3::jsonb, updated_by = $4, updated_at = now()`, [coll, id, text, req.user.sub]);
  if (coll === 'taxrules') await logActivity(req.user.sub, 'Saved tax rules', 'YA' + id, body.status || '');
  res.json({ ok: true });
});

router.delete('/tax/docs/:coll/:id', ...guard, async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLS.includes(coll) || !ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM tax_docs WHERE coll = $1 AND id = $2', [coll, id]);
  res.json({ ok: true });
});

router.get('/tax/app', requireAuth, requireRole('admin'), (req, res) => { res.sendFile(path.join(__dirname, '..', 'assets', 'taxb', 'app.html')); });

module.exports = router;
