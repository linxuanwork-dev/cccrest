const express = require('express');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');
const T = require('../lib/tng');
const G = require('../lib/tngReport');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// TNG / DuitNow QR Daily Settlement Report: the original MMSDO monthly settlement report is uploaded (by hand, or by the folder watcher into the inbox of
// this page), the system finds the outlets in it and makes one PDF + one Excel per outlet. The page is server/assets/tng/app.html. The Owner switches it
// on per company in the Control Panel. Page level = the "sales" level: L1 look / download, L2 upload and make, L3 (manager) also delete.

const PAGE = path.join(__dirname, '..', 'assets', 'tng', 'app.html');
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const OK_EXT = /\.(xlsx|csv)$/i;
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };

async function isEnabled(companyId) {
  const { rows } = await pool.query('SELECT enabled FROM tng_settings WHERE company_id = $1', [companyId]);
  return !!(rows[0] && rows[0].enabled);
}

// ============ CONTROL PANEL (Owner) ============

router.get('/tng-report/companies', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM tng_files f WHERE f.company_id = c.id)::int AS files
     FROM companies c LEFT JOIN tng_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows);
});

router.put('/tng-report/companies/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows: co } = await pool.query('SELECT id, name FROM companies WHERE id = $1', [Number(req.params.id) || 0]);
  if (!co[0]) return res.status(404).json({ error: 'Not found' });
  const enabled = !!(req.body && req.body.enabled === true);
  await pool.query(
    `INSERT INTO tng_settings (company_id, enabled, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, updated_at = now()`, [co[0].id, enabled]);
  await logActivity(req.user.sub, 'Updated TNG Report settings', co[0].name, enabled ? 'on' : 'off');
  res.json({ ok: true });
});

// ============ the page ============

router.get('/tng-report/app', requireAuth, (req, res) => { res.sendFile(PAGE); });

const BASE = '/companies/:companyId/tng-report';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('sales', level)];
const isMgr = (req) => !!(req.pageAccess && (req.pageAccess.ccCrest || req.pageAccess.level >= 3));
async function needEnabled(req, res) {
  if (await isEnabled(req.params.companyId)) return true;
  bad(res, '这家公司还没有开通 TNG Report。 TNG Report is not switched on for this company.');
  return false;
}
const userName = async (id) => { const { rows } = await pool.query('SELECT display_name, login_id FROM users WHERE id = $1', [id]); return rows[0] ? (rows[0].display_name || rows[0].login_id || '') : ''; };

router.get(BASE, ...guard(1), async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ enabled: await isEnabled(req.params.companyId), name: rows[0].name, mgr: isMgr(req), canWrite: !!(req.pageAccess && req.pageAccess.level >= 2), userName: await userName(req.user.sub) });
});

// ---- outlet settings ----

router.get(BASE + '/outlets', ...guard(1), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const { rows } = await pool.query('SELECT outlet_key, original_name, display_name, short_code, company_name, reg_no FROM tng_outlets WHERE company_id = $1 ORDER BY id', [req.params.companyId]);
  const { rows: co } = await pool.query('SELECT name, registration_no FROM companies WHERE id = $1', [req.params.companyId]);
  res.json({ outlets: rows.map((r) => ({ key: r.outlet_key, originalName: r.original_name, displayName: r.display_name, short: r.short_code, companyName: r.company_name, regNo: r.reg_no })), companyName: co[0].name, companyRegNo: co[0].registration_no || '' });
});

router.put(BASE + '/outlets', ...guard(2), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const list = Array.isArray(req.body && req.body.outlets) ? req.body.outlets : [];
  const cl = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  for (const o of list.slice(0, 60)) {
    const key = cl(o.key, 160).toLowerCase(); if (!key) continue;
    await pool.query(
      `INSERT INTO tng_outlets (company_id, outlet_key, original_name, display_name, short_code, company_name, reg_no) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, outlet_key) DO UPDATE SET original_name = $3, display_name = $4, short_code = $5, company_name = $6, reg_no = $7, updated_at = now()`,
      [req.params.companyId, key, cl(o.originalName, 160), cl(o.displayName, 120), cl(o.short, 12).replace(/[^A-Za-z0-9_-]/g, '').toUpperCase(), cl(o.companyName, 160), cl(o.regNo, 60)]);
  }
  res.json({ ok: true });
});

// ---- the files ----

async function loadSettings(companyId) {
  const { rows } = await pool.query('SELECT outlet_key, original_name, display_name, short_code, company_name, reg_no FROM tng_outlets WHERE company_id = $1', [companyId]);
  const map = new Map(); rows.forEach((r) => map.set(r.outlet_key, r));
  return map;
}

// reads + checks a stored file: { parsed, outlets, checks }
async function analyse(row) {
  const parsed = await T.parseReport(row.data, row.original_name);
  const outlets = T.groupOutlets(parsed.rows);
  return { parsed, outlets, checks: T.runChecks(parsed, outlets) };
}

function outletSummary(outlets) { return outlets.map((o) => ({ key: o.key, name: o.name, count: o.rows.length, net: o.rows.reduce((a, r) => a + r.net, 0) })); }

// saves a file (also called by the folder watcher upload). overwrite = replace the file that has the same Report Reference.
async function saveFile(companyId, name, buf, opts) {
  const o = opts || {};
  const ext = name.split('.').pop().toLowerCase();
  const hash = sha(buf);
  const { rows: same } = await pool.query('SELECT id, original_name, period, report_ref FROM tng_files WHERE company_id = $1 AND sha256 = $2 ORDER BY id DESC LIMIT 1', [companyId, hash]);
  if (same[0] && !o.overwrite) return { duplicate: true, id: same[0].id, name: same[0].original_name, period: same[0].period };
  const parsed = await T.parseReport(buf, name);   // throws a readable message when it is not an MMSDO report
  const outlets = T.groupOutlets(parsed.rows);
  const summary = { outlets: outletSummary(outlets), total: parsed.total, rows: parsed.rows.length };
  const ref = parsed.meta.reference || '';
  if (ref && !o.overwrite && !o.viaToken) {
    const { rows: r2 } = await pool.query('SELECT id, created_at FROM tng_files WHERE company_id = $1 AND report_ref = $2 AND period = $3 ORDER BY id DESC LIMIT 1', [companyId, ref, parsed.meta.period]);
    if (r2[0]) return { sameReference: true, id: r2[0].id, createdAt: r2[0].created_at, reference: ref };
  }
  let id;
  if (o.overwrite && ref) {
    const { rows: r3 } = await pool.query('SELECT id FROM tng_files WHERE company_id = $1 AND report_ref = $2 AND period = $3 ORDER BY id DESC LIMIT 1', [companyId, ref, parsed.meta.period]);
    if (r3[0]) {
      await pool.query(`UPDATE tng_files SET original_name = $2, mime = $3, size = $4, sha256 = $5, data = $6, summary = $7::jsonb, status = 'done', replaced_at = now(), uploaded_by = $8 WHERE id = $1`,
        [r3[0].id, name, MIME[ext] || 'application/octet-stream', buf.length, hash, buf, JSON.stringify(summary), o.userId || null]);
      return { id: r3[0].id, replaced: true, period: parsed.meta.period, reference: ref };
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO tng_files (company_id, original_name, mime, size, sha256, data, report_ref, period, status, summary, uploaded_via, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING id`,
    [companyId, name, MIME[ext] || 'application/octet-stream', buf.length, hash, buf, ref, parsed.meta.period, o.viaToken ? 'new' : 'done', JSON.stringify(summary), o.viaToken || null, o.userId || null]);
  return { id: rows[0].id, period: parsed.meta.period, reference: ref };
}
router.saveFile = saveFile;
router.isEnabled = isEnabled;

const cleanName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);

router.post(BASE + '/files', ...guard(2), express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const name = cleanName(req.query.name);
  if (!OK_EXT.test(name)) return bad(res, '只能上传 .xlsx 或 .csv（.xls 请先在 Excel 另存为 .xlsx）。 Only .xlsx or .csv files (save an old .xls as .xlsx first).');
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Empty file.');
  let r;
  try { r = await saveFile(req.params.companyId, name, req.body, { overwrite: req.query.overwrite === '1', userId: req.user.sub }); } catch (e) { return bad(res, e.message, 422); }
  if (r.sameReference) return res.status(409).json({ error: '这份报告（' + r.reference + '）之前已经上传过。要覆盖吗？ This report was uploaded before. Replace it?', sameReference: true, id: r.id, createdAt: r.createdAt });
  if (!r.duplicate) await logActivity(req.user.sub, r.replaced ? 'Replaced a TNG report' : 'Uploaded a TNG report', String(req.params.companyId), name + ' (' + (r.period || '') + ')');
  res.status(r.duplicate ? 200 : 201).json(r);
});

router.get(BASE + '/files', ...guard(1), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const { rows } = await pool.query(
    `SELECT f.id, f.original_name, f.size, f.report_ref, f.period, f.status, f.summary, f.created_at, f.replaced_at, u.display_name AS by_name
       FROM tng_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.company_id = $1 ORDER BY (f.status = 'new') DESC, f.period DESC, f.created_at DESC LIMIT 400`, [req.params.companyId]);
  res.json({ files: rows.map((r) => ({ id: r.id, name: r.original_name, size: r.size, reference: r.report_ref, period: r.period, status: r.status, createdAt: r.created_at, replacedAt: r.replaced_at, by: r.by_name || '', outlets: (r.summary && r.summary.outlets) || [], total: (r.summary && r.summary.total) || null })) });
});

async function loadFile(req, res) {
  const { rows } = await pool.query('SELECT * FROM tng_files WHERE id = $1 AND company_id = $2', [Number(req.params.id) || 0, req.params.companyId]);
  if (!rows[0]) { res.status(404).json({ error: 'Not found' }); return null; }
  return rows[0];
}

// the checks + the outlets of one file (what the page shows before the reports are made)
router.get(BASE + '/files/:id', ...guard(1), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const row = await loadFile(req, res); if (!row) return;
  let a; try { a = await analyse(row); } catch (e) { return bad(res, e.message, 422); }
  const settings = await loadSettings(req.params.companyId);
  const outlets = a.outlets.map((o, i) => {
    const s = settings.get(o.key); const sum = T.summarise(o.rows, a.parsed.meta.period);
    return { index: i, key: o.key, name: o.name, count: o.rows.length, net: sum.totals.net, gross: sum.totals.gross, activeDays: sum.activeDays, configured: !!(s && (s.display_name || s.short_code)),
      setting: s ? { displayName: s.display_name, short: s.short_code, companyName: s.company_name, regNo: s.reg_no } : null, sign: (row.sign || {})[o.key] || {} };
  });
  res.json({ id: row.id, name: row.original_name, status: row.status, period: a.parsed.meta.period, meta: a.parsed.meta, total: a.parsed.total, rowCount: a.parsed.rows.length, checks: a.checks, outlets, createdAt: row.created_at });
});

router.get(BASE + '/files/:id/original', ...guard(1), async (req, res) => {
  const row = await loadFile(req, res); if (!row) return;
  res.setHeader('Content-Type', row.mime); res.setHeader('Content-Disposition', 'attachment; filename="' + row.original_name.replace(/"/g, '') + '"'); res.send(row.data);
});

router.post(BASE + '/files/:id/status', ...guard(2), async (req, res) => {
  const status = req.body && req.body.status;
  if (!['new', 'done'].includes(status)) return bad(res, 'Invalid request');
  const { rowCount } = await pool.query('UPDATE tng_files SET status = $3 WHERE id = $1 AND company_id = $2', [Number(req.params.id) || 0, req.params.companyId, status]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.put(BASE + '/files/:id/sign', ...guard(2), async (req, res) => {
  const row = await loadFile(req, res); if (!row) return;
  const key = String((req.body && req.body.key) || '').toLowerCase(); if (!key) return bad(res, 'Invalid request');
  const cl = (v) => String(v == null ? '' : v).trim().slice(0, 80);
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const b = req.body || {}; const sign = Object.assign({}, row.sign || {});
  sign[key] = { preparedBy: cl(b.preparedBy), preparedDate: d(b.preparedDate), checkedBy: cl(b.checkedBy), checkedDate: d(b.checkedDate), approvedBy: cl(b.approvedBy), approvedDate: d(b.approvedDate) };
  await pool.query('UPDATE tng_files SET sign = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(sign)]);
  res.json({ ok: true });
});

router.delete(BASE + '/files/:id', ...guard(3), async (req, res) => {
  const row = await loadFile(req, res); if (!row) return;
  await pool.query('DELETE FROM tng_files WHERE id = $1', [row.id]);
  await logActivity(req.user.sub, 'Deleted a TNG report file', String(req.params.companyId), row.original_name);
  res.json({ ok: true });
});

// ---- making the reports ----

const todayMy = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const fileSafe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

async function makeContexts(req, row) {
  const a = await analyse(row);
  const settings = await loadSettings(req.params.companyId);
  const { rows: co } = await pool.query('SELECT name, registration_no FROM companies WHERE id = $1', [req.params.companyId]);
  const info = await docs.companyInfo(req.params.companyId);
  const me = await userName(req.user.sub);
  const used = new Set();
  const items = a.outlets.map((o) => {
    const s = settings.get(o.key) || {};
    const sg = Object.assign({}, (row.sign || {})[o.key] || {});
    if (!sg.preparedBy) { sg.preparedBy = me; if (!sg.preparedDate) sg.preparedDate = todayMy(); }
    let short = s.short_code || fileSafe(o.name).toUpperCase().slice(0, 12) || 'OUTLET'; let k = short, i = 2; while (used.has(k)) k = short + i++; used.add(k); short = k;
    return {
      key: o.key, short,
      profile: { displayName: s.display_name || o.name, short: s.short_code || '', companyName: s.company_name || co[0].name, regNo: s.reg_no || co[0].registration_no || '' },
      meta: a.parsed.meta, mode: (o.rows.find((r) => r.mode) || {}).mode || '', summary: T.summarise(o.rows, a.parsed.meta.period), sign: sg,
      statementTotal: a.parsed.total ? a.parsed.total.net : null, allOutlets: a.outlets.length > 1
    };
  });
  return { items, period: a.parsed.meta.period, companyShort: info.PREFIX, companyName: co[0].name };
}

const send = (res, buf, name, type, inline) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + name + '"');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
};
const PDF = 'application/pdf', XLSX = MIME.xlsx;

router.get(BASE + '/files/:id/outlet/:idx/:kind', ...guard(1), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const row = await loadFile(req, res); if (!row) return;
  const kind = req.params.kind; if (!['pdf', 'xlsx'].includes(kind)) return res.status(404).json({ error: 'Not found' });
  let c; try { c = await makeContexts(req, row); } catch (e) { return bad(res, e.message, 422); }
  const ctx = c.items[Number(req.params.idx)]; if (!ctx) return res.status(404).json({ error: 'Not found' });
  const base = ctx.short + '-TNG-DAILY-' + c.period;
  if (kind === 'pdf') return send(res, await G.pdfBuffer(ctx), base + '.pdf', PDF, req.query.inline === '1');
  send(res, await G.excelBuffer(ctx), base + '.xlsx', XLSX);
});

router.get(BASE + '/files/:id/zip', ...guard(1), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const row = await loadFile(req, res); if (!row) return;
  let c; try { c = await makeContexts(req, row); } catch (e) { return bad(res, e.message, 422); }
  const zip = new JSZip();
  for (const ctx of c.items) { const base = ctx.short + '-TNG-DAILY-' + c.period; zip.file(base + '.pdf', await G.pdfBuffer(ctx)); zip.file(base + '.xlsx', await G.excelBuffer(ctx)); }
  send(res, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), c.companyShort + '-TNG-DAILY-ALL-' + c.period + '.zip', 'application/zip');
});

router.get(BASE + '/files/:id/merged', ...guard(1), async (req, res) => {
  if (!(await needEnabled(req, res))) return;
  const row = await loadFile(req, res); if (!row) return;
  let c; try { c = await makeContexts(req, row); } catch (e) { return bad(res, e.message, 422); }
  send(res, await G.mergedBuffer(c.items, c.items[0].meta, c.companyName), c.companyShort + '-TNG-DAILY-ALL-' + c.period + '.xlsx', XLSX);
});

module.exports = router;
