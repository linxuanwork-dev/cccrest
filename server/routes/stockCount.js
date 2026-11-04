const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const docs = require('../lib/docs');
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

// Stock count (库存盘点) for one company: item master with groups, monthly count, month closing (locks quantity + price),
// closing stock report and change log. The page is server/assets/stockcount/app.html (shown inside the company's
// Stock Count page). The data is kept as small documents (groups/, items/, counts/, closing/, settings/, log/) in
// stock_count_docs. The Owner switches it on per company in the Control Panel. CC CREST admin / manager = "manager" on the
// page (items, prices, groups, closing); assigned CC CREST staff with Stock Count L3 or more are managers too; L2 can only enter counts.

const PAGE = path.join(__dirname, '..', 'assets', 'stockcount', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID = '[A-Za-z0-9_-]{1,80}';
const MONTH = '\\d{4}-(?:0[1-9]|1[0-2])';
// every path the page may write (the change log has its own endpoint)
const PATH_RE = new RegExp(`^(?:(?:groups|items|closing|settings)/${ID}|counts/${MONTH}|counts/${MONTH}/(?:lines|packs)/${ID})$`);
const MANAGER_ONLY = new Set(['groups', 'items', 'closing', 'settings']);
const MAX_DOC = 600 * 1024;   // one document (a closing snapshot is the biggest)

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, c.file_prefix, COALESCE(s.enabled, false) AS enabled, COALESCE(s.rev, 0) AS rev
       FROM companies c LEFT JOIN stock_count_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  return r ? { name: r.name, short: r.file_prefix || '', enabled: r.enabled, rev: Number(r.rev) } : null;
}

// ============ CONTROL PANEL (Owner): switch the feature on per company ============

router.get('/stock-count/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM stock_count_docs d WHERE d.company_id = c.id AND d.coll = 'items')::int AS items,
       (SELECT COUNT(*) FROM stock_count_docs d WHERE d.company_id = c.id AND d.coll = 'closing')::int AS closed
     FROM companies c LEFT JOIN stock_count_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows);
});

router.put('/stock-count/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const enabled = !!(req.body && req.body.enabled === true);
  await pool.query(
    `INSERT INTO stock_count_settings (company_id, enabled, rev, updated_at) VALUES ($1,$2,1, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, rev = stock_count_settings.rev + 1, updated_at = now()`,
    [req.params.id, enabled]
  );
  if (enabled) {   // the page shows the company name in its header
    await pool.query(
      `INSERT INTO stock_count_docs (company_id, path, coll, data, updated_by) VALUES ($1,'settings/company','settings',$2::jsonb,$3)
       ON CONFLICT (company_id, path) DO NOTHING`,
      [req.params.id, JSON.stringify({ name: s.name, short: s.short }), req.user.sub]
    );
  }
  await logActivity(req.user.sub, 'Updated Stock Count settings', s.name, enabled ? 'on' : 'off');
  res.json({ ok: true });
});

// ============ COMPANY SIDE ============

// The page itself (shown in an iframe); the data endpoints below do the real checks.
router.get('/stock-count/app', requireAuth, (req, res) => {
  res.sendFile(PAGE);
});

const BASE = '/companies/:companyId/stock-count';
// company users (clients) never see the stock count; CC CREST people use the "Stock Count" level of their permission list
const noClients = (req, res, next) => (req.user && req.user.role === 'client' ? res.status(403).json({ error: 'Not allowed' }) : next());
const guard = (level) => [requireAuth, noClients, scopeToCompany, requirePage('stock', level)];
// "manager" on the page = CC CREST admin / manager, or an assigned staff member with Stock Count level L3 or more
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || req.pageAccess.level >= 3));
async function enabledSettings(req, res) {
  const s = await loadSettings(req.params.companyId);
  if (!s || !s.enabled) { bad(res, '这家公司还没有开通库存盘点。 Stock count is not switched on for this company.'); return null; }
  return s;
}

// Whether the feature is on for this company, and what this user may do on the page
router.get(BASE, ...guard(1), async (req, res) => {
  const s = await loadSettings(req.params.companyId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({
    enabled: s.enabled, name: s.name, short: s.short, uid: String(req.user.sub),
    mgr: isMgr(req), canWrite: isMgr(req) || req.pageAccess.level >= 2
  });
});

const toList = (rows) => rows.map((r) => Object.assign({ id: r.id }, r.data));

// Everything the page shows, in one request: the master data, the selected month's count and the month's change log.
// The page asks again every few seconds with the revision it already has, and gets "same" back when nothing changed.
router.get(BASE + '/sync', ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  const cid = req.params.companyId;
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : null;
  const logMonth = MONTH_RE.test(req.query.logMonth || '') ? req.query.logMonth : null;
  if (!month || !logMonth) return bad(res, 'month and logMonth are required');
  if (req.query.rev !== undefined && String(s.rev) === String(req.query.rev)) return res.json({ same: true, rev: s.rev, month, logMonth });

  const colls = ['settings', 'groups', 'items', 'counts', 'closing', 'counts/' + month + '/lines', 'counts/' + month + '/packs'];
  const { rows } = await pool.query(
    `SELECT path, coll, data FROM stock_count_docs
      WHERE company_id = $1 AND (coll = ANY($2::text[]) OR (coll = 'log' AND data->>'day' >= $3 AND data->>'day' <= $4))`,
    [cid, colls, logMonth + '-01', logMonth + '-31']
  );
  const by = {};
  rows.forEach((r) => { (by[r.coll] = by[r.coll] || []).push({ id: r.path.slice(r.coll.length + 1), data: r.data }); });
  const get = (c) => toList(by[c] || []);
  const log = get('log');
  const ids = [...new Set(log.map((d) => Number(d.by)).filter((n) => Number.isInteger(n) && n > 0))];
  const names = {};
  if (ids.length) {
    const u = await pool.query('SELECT id, display_name, login_id FROM users WHERE id = ANY($1::int[])', [ids]);
    u.rows.forEach((x) => { names[String(x.id)] = x.display_name || x.login_id; });
  }
  res.json({
    rev: s.rev, month, logMonth, names,
    settings: get('settings'), groups: get('groups'), items: get('items'), counts: get('counts'), closing: get('closing'),
    lines: get('counts/' + month + '/lines'), packs: get('counts/' + month + '/packs'), log
  });
});

async function bumpRev(client, companyId) {
  await client.query(
    `INSERT INTO stock_count_settings (company_id, enabled, rev) VALUES ($1,false,1)
     ON CONFLICT (company_id) DO UPDATE SET rev = stock_count_settings.rev + 1`,
    [companyId]
  );
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Writes: [{op: 'set' | 'update' | 'delete', path, data}] — all or nothing
router.post(BASE + '/batch', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const ops = req.body && req.body.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 100) return bad(res, 'Invalid request');
  const mgr = isMgr(req), uid = String(req.user.sub);
  const months = new Set();
  for (const o of ops) {
    if (!o || !['set', 'update', 'delete'].includes(o.op) || typeof o.path !== 'string' || !PATH_RE.test(o.path)) return bad(res, 'Invalid request');
    const top = o.path.split('/')[0];
    if (MANAGER_ONLY.has(top) && !mgr) return res.status(403).json({ error: '只有 manager 可以做这个操作。 Only a manager can do this.' });
    if (o.op !== 'delete') {
      if (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC) return bad(res, 'Invalid request');
      // who did it is whoever is signed in, whatever the page says
      if ('by' in o.data) o.data.by = uid;
      if (top === 'closing') o.data.closedBy = uid;
    }
    if (top === 'counts') months.add(o.path.split('/')[1]);
  }
  const cid = req.params.companyId;
  if (months.size) {   // a closed month is locked: reopen it first
    const { rows } = await pool.query('SELECT path FROM stock_count_docs WHERE company_id = $1 AND path = ANY($2::text[])', [cid, [...months].map((m) => 'closing/' + m)]);
    if (rows.length) return bad(res, rows[0].path.slice(8) + ' 已结账，不能再改数量。请 manager 先重开。 That month is closed.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      const coll = o.path.slice(0, o.path.lastIndexOf('/'));
      if (o.op === 'delete') await client.query('DELETE FROM stock_count_docs WHERE company_id = $1 AND path = $2', [cid, o.path]);
      else {
        await client.query(
          `INSERT INTO stock_count_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5, now())
           ON CONFLICT (company_id, path) DO UPDATE SET data = ${o.op === 'update' ? 'stock_count_docs.data || EXCLUDED.data' : 'EXCLUDED.data'}, updated_by = $5, updated_at = now()`,
          [cid, o.path, coll, JSON.stringify(o.data), req.user.sub]
        );
      }
    }
    await bumpRev(client, cid);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  for (const o of ops) {   // closing / reopening a month goes into the system's activity log
    if (o.path.startsWith('closing/') && o.op !== 'update') {
      const s = await loadSettings(cid);
      await logActivity(req.user.sub, o.op === 'delete' ? 'Reopened stock count month' : 'Closed stock count month', s ? s.name : '', o.path.slice(8));
    }
  }
  res.json({ ok: true });
});

// The page builds its Excel files in the browser; this puts the system's print stamp (date + user, in the print footer)
// on them before they are saved, like every other download.
router.post(BASE + '/stamp', ...guard(1), express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Invalid request');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.body); } catch (e) { return bad(res, 'Cannot read this Excel file.'); }
  docs.stampWorkbook(wb, docs.stampText(await docs.userNameFor(req)));
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// Change log: one document per person per day, entries are added at the end (a new document is started when one gets big)
router.post(BASE + '/log', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const day = req.body && req.body.day, entries = req.body && req.body.entries;
  if (!DAY_RE.test(String(day || '')) || !Array.isArray(entries) || !entries.length || entries.length > 300 || !entries.every(isObj)) return bad(res, 'Invalid request');
  const add = JSON.stringify(entries);
  if (add.length > 300 * 1024) return bad(res, 'Invalid request');
  const cid = req.params.companyId, uid = String(req.user.sub), base = 'log/' + day + '_' + uid;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [Number(cid), base]);
    for (let k = 1; k < 50; k++) {
      const p = base + (k > 1 ? '_' + k : '');
      const cur = await client.query('SELECT data FROM stock_count_docs WHERE company_id = $1 AND path = $2', [cid, p]);
      const prev = cur.rows[0] ? (cur.rows[0].data.entries || []) : [];
      if (prev.length && JSON.stringify(prev).length + add.length > 200000) continue;
      await client.query(
        `INSERT INTO stock_count_docs (company_id, path, coll, data, updated_by, updated_at) VALUES ($1,$2,'log',$3::jsonb,$4, now())
         ON CONFLICT (company_id, path) DO UPDATE SET data = EXCLUDED.data, updated_by = $4, updated_at = now()`,
        [cid, p, JSON.stringify({ day, by: uid, entries: prev.concat(entries) }), req.user.sub]
      );
      break;
    }
    await bumpRev(client, cid);
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
  console.error('stockCount route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
