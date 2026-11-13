const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// HR > Attendance (考勤) for one company: the roster (foreign / local / part-time staff with their schedules), the daily clock entries,
// the manager approvals, advances and pay adjustments. The page is server/assets/attendance/app.html (shown inside the company's
// HR > Attendance page); the data is kept as small documents in attendance_docs. The Owner switches it on per company in the Control Panel.
// Everyone uses the HR ("payroll") level of their permission list: L1 look, L2 enter clock times, L3 (manager) approve / roster / pay.

const PAGE = path.join(__dirname, '..', 'assets', 'attendance', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const PATH_RE = /^(roster|settings|entries|approvals|advances|payadj)\/[A-Za-z0-9_.:-]{1,90}$/;
const MGR_WRITE = new Set(['roster', 'settings', 'approvals', 'advances', 'payadj']);   // only entries (the clock times) can be written by L2
const MGR_READ = new Set(['advances', 'payadj']);                                        // money: managers only
const MAX_DOC = 100 * 1024;
const KEEP_DAYS = 430;                                                                   // the page works on the last ~14 months of clock entries

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, COALESCE(s.enabled, false) AS enabled, COALESCE(s.rev, 0) AS rev
       FROM companies c LEFT JOIN attendance_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  return r ? { name: r.name, enabled: r.enabled, rev: Number(r.rev) } : null;
}

// ============ CONTROL PANEL (Owner): switch the feature on per company ============

router.get('/attendance/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM attendance_docs d WHERE d.company_id = c.id)::int AS docs
     FROM companies c LEFT JOIN attendance_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows);
});

router.put('/attendance/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const enabled = !!(req.body && req.body.enabled === true);
  await pool.query(
    `INSERT INTO attendance_settings (company_id, enabled, rev, updated_at) VALUES ($1,$2,1, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, rev = attendance_settings.rev + 1, updated_at = now()`,
    [req.params.id, enabled]
  );
  await logActivity(req.user.sub, 'Updated HR Attendance settings', s.name, enabled ? 'on' : 'off');
  res.json({ ok: true });
});

// ============ COMPANY SIDE ============

router.get('/attendance/app', requireAuth, (req, res) => { res.sendFile(PAGE); });

const BASE = '/companies/:companyId/attendance';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('payroll', level)];
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || req.pageAccess.level >= 3));
async function enabledSettings(req, res) {
  const s = await loadSettings(req.params.companyId);
  if (!s || !s.enabled) { bad(res, '这家公司还没有开通考勤。 Attendance is not switched on for this company.'); return null; }
  return s;
}

router.get(BASE, ...guard(1), async (req, res) => {
  const s = await loadSettings(req.params.companyId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ enabled: s.enabled, name: s.name, uid: String(req.user.sub), mgr: isMgr(req), canWrite: !!(req.pageAccess && req.pageAccess.level >= 2) });
});

// Everything the page shows, in one request; "same" when nothing changed since the revision the page has.
router.get(BASE + '/sync', ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  if (req.query.rev !== undefined && String(s.rev) === String(req.query.rev)) return res.json({ same: true, rev: s.rev });
  const { rows } = await pool.query(
    `SELECT path, coll, data FROM attendance_docs WHERE company_id = $1
       AND (coll <> 'entries' OR data->>'date' >= to_char(now() - ($2 || ' days')::interval, 'YYYY-MM-DD'))`,
    [req.params.companyId, String(KEEP_DAYS)]
  );
  const mgr = isMgr(req);
  const by = { roster: [], settings: [], entries: [], approvals: [], advances: [], payadj: [] };
  rows.forEach((r) => {
    if (!mgr && MGR_READ.has(r.coll)) return;
    let data = r.data;
    if (!mgr && r.coll === 'roster' && data && data.id) { data = Object.assign({}, data); delete data.id; }   // passport / IC numbers: managers only
    (by[r.coll] = by[r.coll] || []).push({ id: r.path.slice(r.coll.length + 1), data });
  });
  res.json({ rev: s.rev, docs: by });
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Writes: [{op: 'set' | 'delete', path, data}] — all or nothing. A document is replaced as a whole.
router.post(BASE + '/batch', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const ops = req.body && req.body.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 60) return bad(res, 'Invalid request');
  const mgr = isMgr(req);
  for (const o of ops) {
    if (!o || !['set', 'delete'].includes(o.op) || typeof o.path !== 'string' || !PATH_RE.test(o.path)) return bad(res, 'Invalid request');
    const coll = o.path.slice(0, o.path.indexOf('/'));
    if (MGR_WRITE.has(coll) && !mgr) return res.status(403).json({ error: '只有店长 / manager 可以做这个操作。 Only a manager can do this.' });
    if (o.op === 'set' && (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC)) return bad(res, 'Invalid request');
  }
  const cid = req.params.companyId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      if (o.op === 'delete') await client.query('DELETE FROM attendance_docs WHERE company_id = $1 AND path = $2', [cid, o.path]);
      else {
        await client.query(
          `INSERT INTO attendance_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5, now())
           ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_by = $5, updated_at = now()`,
          [cid, o.path, o.path.slice(0, o.path.indexOf('/')), JSON.stringify(o.data), req.user.sub]
        );
      }
    }
    await client.query(
      `INSERT INTO attendance_settings (company_id, enabled, rev) VALUES ($1,false,1)
       ON CONFLICT (company_id) DO UPDATE SET rev = attendance_settings.rev + 1`,
      [cid]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

router.use((err, req, res, next) => {
  console.error('attendance route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
