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
// page (items, prices, groups, closing); assigned CC CREST staff with Stock Count L3 or more are managers too; everyone else can only enter counts (L2+) or look (L1).

const PAGE = path.join(__dirname, '..', 'assets', 'stockcount', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID = '[A-Za-z0-9_-]{1,80}';
const MONTH = '\\d{4}-(?:0[1-9]|1[0-2])';
// every path the page may write (the change log has its own endpoint)
const PATH_RE = new RegExp(`^(?:(?:groups|items|closing|settings)/${ID}|counts/${MONTH}|counts/${MONTH}/(?:lines|packs)/${ID})$`);
const MAX_DOC = 600 * 1024;   // one document (a closing snapshot is the biggest)

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, c.file_prefix, COALESCE(s.enabled, false) AS enabled, COALESCE(s.rev, 0) AS rev, COALESCE(s.fifo_from, '') AS fifo_from
       FROM companies c LEFT JOIN stock_count_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  return r ? { name: r.name, short: r.file_prefix || '', enabled: r.enabled, rev: Number(r.rev), fifoFrom: r.fifo_from } : null;
}

// ============ CONTROL PANEL (Owner): switch the feature on per company ============

router.get('/stock-count/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled, COALESCE(s.fifo_from, '') AS fifo_from,
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
  const fifoFrom = String((req.body && req.body.fifoFrom) || '').trim();
  if (fifoFrom && !MONTH_RE.test(fifoFrom)) return bad(res, 'FIFO 起算月份格式不对（例 2026-01）。 The FIFO start month must look like 2026-01.');
  await pool.query(
    `INSERT INTO stock_count_settings (company_id, enabled, fifo_from, rev, updated_at) VALUES ($1,$2,$3,1, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, fifo_from = CASE WHEN $4::boolean THEN $3 ELSE stock_count_settings.fifo_from END,
       rev = stock_count_settings.rev + 1, updated_at = now()`,
    [req.params.id, enabled, fifoFrom, !!(req.body && 'fifoFrom' in req.body)]   // an old page that does not send the month leaves it as it is
  );
  if (enabled) {   // the page shows the company name in its header
    await pool.query(
      `INSERT INTO stock_count_docs (company_id, path, coll, data, updated_by) VALUES ($1,'settings/company','settings',$2::jsonb,$3)
       ON CONFLICT (company_id, path) DO NOTHING`,
      [req.params.id, JSON.stringify({ name: s.name, short: s.short }), req.user.sub]
    );
  }
  await logActivity(req.user.sub, 'Updated Stock Count settings', s.name, (enabled ? 'on' : 'off') + (fifoFrom ? '; FIFO from ' + fifoFrom : '; FIFO off'));
  res.json({ ok: true });
});

// ============ COMPANY SIDE ============

// The page itself (shown in an iframe); the data endpoints below do the real checks.
router.get('/stock-count/app', requireAuth, (req, res) => {
  res.sendFile(PAGE);
});

const BASE = '/companies/:companyId/stock-count';
// everyone (CC CREST staff and the company's own users) uses the "Stock Count" level of their permission list
const guard = (level) => [requireAuth, scopeToCompany, requirePage('stock', level)];
// "manager" on the page (prices, items, groups, closing) = CC CREST admin / manager, or an assigned CC CREST staff member with
// Stock Count level L3 or more. Company users (clients) are never managers, whatever their level: they can open the page and,
// with L2 or more, enter counts, but cannot change prices.
// A company user (client) at Stock Count L3 or more is a "client manager": may add items and groups and delete an item that
// has no records, but never change a price or close a month (prices will come from the purchase records: only CC CREST sets them).
const isClientMgr = (req) => !!(req.pageAccess && req.user.role === 'client' && req.pageAccess.level >= 3);
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || (req.user.role === 'staff' && req.pageAccess.level >= 3)));
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
    enabled: s.enabled, name: s.name, short: s.short, uid: String(req.user.sub), fifoFrom: s.fifoFrom,
    mgr: isMgr(req), canAdd: isMgr(req) || isClientMgr(req), canWrite: isMgr(req) || req.pageAccess.level >= 2
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
  const mgr = isMgr(req), clientMgr = isClientMgr(req), uid = String(req.user.sub);
  const months = new Set(), mustBeNew = [], mustExist = [], itemDeletes = [];
  const deny = () => res.status(403).json({ error: '你没有权限做这个操作。 You are not allowed to do this.' });
  for (const o of ops) {
    if (!o || !['set', 'update', 'delete'].includes(o.op) || typeof o.path !== 'string' || !PATH_RE.test(o.path)) return bad(res, 'Invalid request');
    const top = o.path.split('/')[0];
    if (!mgr && ['groups', 'items', 'closing', 'settings'].includes(top)) {
      // a client manager may add items and groups (a path that does not exist yet), edit and delete items, but never change a price
      if (top === 'closing' || top === 'settings' || !clientMgr) return deny();
      if (top === 'groups' && o.op !== 'set') return deny();
      if (o.op === 'set') mustBeNew.push(o.path);
      if (o.op === 'update') mustExist.push(o.path);
    }
    if (o.op === 'delete' && top === 'items') itemDeletes.push(o.path.slice(6));
    if (o.op !== 'delete') {
      if (!isObj(o.data) || JSON.stringify(o.data).length > MAX_DOC) return bad(res, 'Invalid request');
      // who did it is whoever is signed in, whatever the page says
      if ('by' in o.data) o.data.by = uid;
      if (top === 'closing') o.data.closedBy = uid;
      if (top === 'items' && !mgr) {   // only CC CREST sets prices (and the Account); a client manager's edit leaves them as they are
        if (o.op === 'set') { o.data.price = 0; delete o.data.priceAt; }
        else { delete o.data.price; delete o.data.priceAt; delete o.data.account; delete o.data.no; }
      }
    }
    if (top === 'counts') months.add(o.path.split('/')[1]);
  }
  const cid = req.params.companyId;
  if (mustBeNew.length) {
    const { rows } = await pool.query('SELECT 1 FROM stock_count_docs WHERE company_id = $1 AND path = ANY($2::text[])', [cid, mustBeNew]);
    if (rows.length) return deny();
  }
  if (mustExist.length) {   // an edit changes an item that is there; it never creates one
    const { rows } = await pool.query('SELECT path FROM stock_count_docs WHERE company_id = $1 AND path = ANY($2::text[])', [cid, mustExist]);
    if (rows.length !== new Set(mustExist).size) return deny();
  }
  if (itemDeletes.length) {   // an item that has records (a count, or a closed month) cannot be deleted: make it inactive instead
    const { rows } = await pool.query(
      `SELECT 1 FROM stock_count_docs d, unnest($2::text[]) AS i(id)
        WHERE d.company_id = $1
          AND ((d.coll LIKE 'counts/%/lines' AND right(d.path, length(i.id) + 1) = '/' || i.id)
            OR (d.coll = 'closing' AND d.data->'lines' ? i.id))
        LIMIT 1`,
      [cid, itemDeletes]
    );
    if (rows.length) return bad(res, '这个货品已经有盘点记录，不能删除，请改成「停用」。 This item has records and cannot be deleted — make it inactive instead.');
  }
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

// Purchase records for FIFO: the purchase bills dated after `from` up to `to`, as layers per Stock Count item (newest first). A bill line belongs
// to a Stock Count item through the supplier's item list (name on the invoice -> Stock Count item + buying unit); `q` is in Stock Count units
// and `c` the cost of one Stock Count unit. The page values the counted quantity from the newest layers backwards.
const normName = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
router.get(BASE + '/fifo', ...guard(1), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const from = DAY_RE.test(req.query.from || '') ? req.query.from : '1970-01-01';
  const to = DAY_RE.test(req.query.to || '') ? req.query.to : '2999-12-31';
  const cid = req.params.companyId;
  const [bills, maps] = await Promise.all([
    pool.query(`SELECT id, supplier, no, to_char(bill_date, 'YYYY-MM-DD') AS d, lines FROM purchase_bukku_bills
                 WHERE company_id = $1 AND bill_date > $2 AND bill_date <= $3 ORDER BY bill_date DESC, id DESC`, [cid, from, to]),
    pool.query('SELECT supplier, alias, stock_item_id, per FROM purchase_bukku_items WHERE company_id = $1', [cid])
  ]);
  const map = new Map(maps.rows.map((m) => [m.supplier + '|' + m.alias, m]));
  const layers = {}, unmapped = new Set();
  for (const b of bills.rows) {
    const sup = normName(b.supplier);
    for (const l of b.lines || []) {
      const m = map.get(sup + '|' + normName(l.desc)) || (l.as ? map.get(sup + '|' + normName(l.as)) : null);
      const item = (m && m.stock_item_id) || l.item || '';
      if (!item) { unmapped.add(sup + '|' + normName(l.desc)); continue; }
      const per = Number(l.per) > 0 ? Number(l.per) : (m && Number(m.per) > 0 ? Number(m.per) : 1);
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1, price = Number(l.price) || 0;
      const arr = layers[item] = layers[item] || [];
      if (arr.length < 80) arr.push({ d: b.d, no: b.no, sup: b.supplier, q: qty / per, c: price * per });
    }
  }
  res.json({ from, to, layers, unmapped: unmapped.size });
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
