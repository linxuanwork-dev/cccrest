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

// ---------- the change record (cannot be switched off) ----------
const LOCKED = ['reviewed', 'filed'];   // a return that is approved (and locked) or filed
const short = (v) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t === undefined ? '' : t.length > 120 ? t.slice(0, 120) + '…' : t; };
function diffDocs(a, b, base, out) {
  const A = a == null ? {} : a, B = b == null ? {} : b;
  if (typeof A !== 'object' || typeof B !== 'object' || Array.isArray(A) !== Array.isArray(B)) { if (JSON.stringify(A) !== JSON.stringify(B) && out.length < 80) out.push({ path: base, before: short(a), after: short(b) }); return out; }
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  for (const k of keys) {
    if (!base && (k === 'updatedAt' || k === 'result' || k === '_reopen')) continue;
    const p = base ? (Array.isArray(A) || Array.isArray(B) ? base + '[' + k + ']' : base + '.' + k) : k;
    const x = A[k], y = B[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object') diffDocs(x, y, p, out);
    else if (out.length < 80) out.push({ path: p, before: short(x), after: short(y) });
  }
  return out;
}
// jsonb keeps the keys in its own order: compare with the keys sorted
const stable = (v) => (Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v));
const sameExcept = (a, b, skip) => { const strip = (o) => { const c = Object.assign({}, o); skip.forEach((k) => delete c[k]); return stable(c); }; return strip(a) === strip(b); };
async function userName(id) { const { rows } = await pool.query('SELECT display_name, login_id FROM users WHERE id = $1', [id]); return rows[0] ? (rows[0].display_name || rows[0].login_id || '') : ''; }
async function audit(req, coll, id, action, changes, reason) {
  await pool.query('INSERT INTO tax_audit (user_id, user_name, coll, doc_id, action, changes, reason) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [req.user.sub, await userName(req.user.sub), coll, id, action, JSON.stringify(changes || []), String(reason || '').slice(0, 500)]);
}

router.get('/tax/audit', ...guard, async (req, res) => {
  const cid = String(req.query.client || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!cid) return res.status(400).json({ error: 'Invalid request' });
  const like = cid.split('_').join('\\_') + '\\_%';   // the ids hold only letters, digits, _ . - : the _ is escaped for LIKE
  const { rows } = await pool.query(
    "SELECT id, at, user_name, coll, doc_id, action, changes, reason FROM tax_audit WHERE (coll = 'taxclients' AND doc_id = $1) OR (coll = 'taxreturns' AND doc_id LIKE $2) ORDER BY id DESC LIMIT 300", [cid, like]);
  res.json({ rows: rows.map((r) => ({ id: r.id, at: r.at, who: r.user_name, coll: r.coll, docId: r.doc_id, action: r.action, changes: r.changes, reason: r.reason })) });
});

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
  const { rows: ex } = await pool.query('SELECT data FROM tax_docs WHERE coll = $1 AND id = $2', [coll, id]);
  const old = ex[0] ? ex[0].data : null;
  let action = old ? 'update' : 'create', reason = '';
  if (coll === 'taxreturns') {
    if (old && LOCKED.includes(old.status)) {
      const why = body._reopen && String(body._reopen.reason || '').trim();
      if (why && body.status === 'draft') { if (why.length < 3) return res.status(400).json({ error: '重开要写原因。' }); action = 'reopen'; reason = why; }
      else if (old.status === 'reviewed' && body.status === 'filed' && sameExcept(old, body, ['status', 'filedOn', 'filedRef', 'updatedAt', 'result', '_reopen'])) action = 'file';
      else return res.status(409).json({ error: '这份报税资料已经批准并锁定。要改请先按「重开」，写原因。', locked: true });
    } else if (body.status === 'reviewed' && (!old || old.status !== 'reviewed')) action = 'approve';
    else if (body.status === 'filed' && (!old || old.status !== 'filed')) action = 'file';
  }
  delete body._reopen;
  const text = JSON.stringify(body);
  if (text.length > MAX_DOC) return res.status(400).json({ error: '资料太大。 Too large.' });
  const changes = diffDocs(old, body, '', []);
  await pool.query(
    `INSERT INTO tax_docs (coll, id, data, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,$4, now())
     ON CONFLICT (coll, id) DO UPDATE SET data = $3::jsonb, updated_by = $4, updated_at = now()`, [coll, id, text, req.user.sub]);
  if (!(old && !changes.length && action === 'update')) await audit(req, coll, id, action, changes, reason);   // only the computed result changed: saved, but not a change of the data
  if (coll === 'taxrules') await logActivity(req.user.sub, 'Saved tax rules', 'YA' + id, body.status || '');
  res.json({ ok: true });
});

router.delete('/tax/docs/:coll/:id', ...guard, async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLS.includes(coll) || !ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
  const { rows: ex } = await pool.query('SELECT data FROM tax_docs WHERE coll = $1 AND id = $2', [coll, id]);
  if (!ex[0]) return res.json({ ok: true });
  if (coll === 'taxreturns' && LOCKED.includes(ex[0].data.status)) return res.status(409).json({ error: '已批准锁定的报税资料不能删除。请先「重开」。', locked: true });
  await pool.query('DELETE FROM tax_docs WHERE coll = $1 AND id = $2', [coll, id]);
  await audit(req, coll, id, 'delete', [{ path: '(whole document)', before: short(ex[0].data.name || ex[0].data.form || ''), after: '' }], '');
  res.json({ ok: true });
});

router.get('/tax/app', requireAuth, requireRole('admin'), (req, res) => { res.sendFile(path.join(__dirname, '..', 'assets', 'taxb', 'app.html')); });

module.exports = router;
