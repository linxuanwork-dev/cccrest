const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const store = require('../lib/statutoryStore');
const auditLog = require('../lib/auditLog');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as the other route files.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Statutory payroll rules (EPF, SOCSO, EIS, pay lines), by effective date. Anyone signed in can read the rules in force (the Attendance page needs them);
// only the Owner (admin) adds a draft, edits or deletes a draft, and approves it. An approved version can never change: the database refuses.
const guard = [requireAuth, requireRole('admin')];
const dateOk = (d) => /^\d{4}-\d{2}-01$/.test(String(d || ''));
const reasonOk = (r) => String(r || '').trim().length >= 3;
const fail = (res, s, m) => res.status(s).json({ error: m });
const who = async (req) => auditLog.userName(pool, req.user.sub);

router.get('/statutory-rules/current', requireAuth, async (req, res) => {
  await store.ready();
  res.json(store.withDefaults(await store.approvedList()));
});

router.get('/statutory-rules', ...guard, async (req, res) => {
  await store.ensureSeed();
  res.json(await store.allRows());
});

router.post('/statutory-rules', ...guard, async (req, res) => {
  const { kind, effectiveFrom, data, note, reason } = req.body || {};
  if (!store.KINDS.includes(kind)) return fail(res, 400, 'kind must be one of ' + store.KINDS.join(', '));
  if (!dateOk(effectiveFrom)) return fail(res, 400, 'The effective date must be the first day of a month (YYYY-MM-01)');
  if (!reasonOk(reason)) return fail(res, 400, 'A reason is required');
  try { store.check(kind, data); } catch (e) { return fail(res, e.status || 500, e.message); }
  const name = await who(req);
  const { rows } = await pool.query(
    `INSERT INTO statutory_rules (kind, effective_from, status, data, note, created_by) VALUES ($1,$2::date,'draft',$3::jsonb,$4,$5) RETURNING id`,
    [kind, effectiveFrom, JSON.stringify(data), note || null, name]);
  await auditLog.write(pool, { who: name, userId: req.user.sub, module: 'statutory_rules', record: kind + ' from ' + effectiveFrom + ' (#' + rows[0].id + ')', action: 'create draft', after: JSON.stringify(data).slice(0, 1800), reason });
  res.status(201).json({ id: rows[0].id });
});

router.put('/statutory-rules/:id', ...guard, async (req, res) => {
  const id = parseInt(req.params.id, 10); const { effectiveFrom, data, note, reason } = req.body || {};
  const cur = (await pool.query('SELECT kind, status FROM statutory_rules WHERE id = $1', [id])).rows[0];
  if (!cur) return fail(res, 404, 'Not found');
  if (cur.status !== 'draft') return fail(res, 409, 'An approved rule can not be changed: add a new version');
  if (effectiveFrom !== undefined && !dateOk(effectiveFrom)) return fail(res, 400, 'The effective date must be the first day of a month (YYYY-MM-01)');
  if (!reasonOk(reason)) return fail(res, 400, 'A reason is required');
  if (data !== undefined) { try { store.check(cur.kind, data); } catch (e) { return fail(res, e.status || 500, e.message); } }
  await pool.query(
    `UPDATE statutory_rules SET effective_from = COALESCE($2::date, effective_from), data = COALESCE($3::jsonb, data), note = COALESCE($4, note) WHERE id = $1`,
    [id, effectiveFrom || null, data !== undefined ? JSON.stringify(data) : null, note !== undefined ? note : null]);
  await auditLog.write(pool, { who: await who(req), userId: req.user.sub, module: 'statutory_rules', record: cur.kind + ' (#' + id + ')', action: 'update draft', after: data !== undefined ? JSON.stringify(data).slice(0, 1800) : null, reason });
  res.json({ ok: true });
});

router.delete('/statutory-rules/:id', ...guard, async (req, res) => {
  const id = parseInt(req.params.id, 10); const reason = (req.body && req.body.reason) || req.query.reason;
  const cur = (await pool.query('SELECT kind, status, effective_from FROM statutory_rules WHERE id = $1', [id])).rows[0];
  if (!cur) return fail(res, 404, 'Not found');
  if (cur.status !== 'draft') return fail(res, 409, 'An approved rule can not be deleted');
  if (!reasonOk(reason)) return fail(res, 400, 'A reason is required');
  await pool.query('DELETE FROM statutory_rules WHERE id = $1', [id]);
  await auditLog.write(pool, { who: await who(req), userId: req.user.sub, module: 'statutory_rules', record: cur.kind + ' (#' + id + ')', action: 'delete draft', reason });
  res.json({ ok: true });
});

// the same wages with the rules in force and with this draft (from the month it starts, or ?month=YYYY-MM)
router.get('/statutory-rules/:id/compare', ...guard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = (await pool.query("SELECT id, kind, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, data FROM statutory_rules WHERE id = $1", [id])).rows[0];
  if (!r) return fail(res, 404, 'Not found');
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : r.effective_from.slice(0, 7);
  const approved = await store.approvedList();
  res.json({ kind: r.kind, effectiveFrom: r.effective_from, month, rows: store.compare(approved, { kind: r.kind, effectiveFrom: r.effective_from, data: r.data }, month) });
});

router.post('/statutory-rules/:id/approve', ...guard, async (req, res) => {
  const id = parseInt(req.params.id, 10); const { reason } = req.body || {};
  if (!reasonOk(reason)) return fail(res, 400, 'A reason is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query("SELECT kind, status, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, data FROM statutory_rules WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return fail(res, 404, 'Not found'); }
    if (cur.status !== 'draft') { await client.query('ROLLBACK'); return fail(res, 409, 'It is approved already'); }
    try { store.check(cur.kind, cur.data); } catch (e) { await client.query('ROLLBACK'); return fail(res, e.status || 500, e.message); }
    const name = await auditLog.userName(client, req.user.sub);
    try {
      await client.query("UPDATE statutory_rules SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [id, name]);
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return fail(res, 409, 'There is an approved ' + cur.kind + ' rule for ' + cur.effective_from + ' already: choose another date');
      throw e;
    }
    await auditLog.write(client, { who: name, userId: req.user.sub, module: 'statutory_rules', record: cur.kind + ' from ' + cur.effective_from + ' (#' + id + ')', action: 'approve', after: JSON.stringify(cur.data).slice(0, 1800), reason });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  await store.refresh();
  res.json({ ok: true });
});

module.exports = router;
