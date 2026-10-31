const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Bukku Purchase Bill entry for one company: quick grid, multi-line form, bill list with duplicate checks and the Bukku
// import file. The page itself is server/assets/purchasebill/app.html (shown inside the company's Purchases Bill page).
// The Owner switches it on per company and sets the company's short name, default account and old-file import in the
// Control Panel; CC CREST admin / manager = "manager" on the page, everyone else = "staff".

const PAGE = path.join(__dirname, '..', 'assets', 'purchasebill', 'app.html');
const bad = (res, msg) => res.status(400).json({ error: msg });
const normName = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
const normNo = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '');
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

function validIso(s) {
  const m = ISO_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

async function loadSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT c.name, c.file_prefix, s.enabled, s.account FROM companies c LEFT JOIN purchase_bukku_settings s ON s.company_id = c.id WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0];
  if (!r) return null;
  return { name: r.name, short: r.file_prefix || '', enabled: !!r.enabled, account: r.account || '' };
}

// ============ CONTROL PANEL (Owner): company settings of the feature ============

router.get('/purchase-bukku/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM purchase_bukku_contacts k WHERE k.company_id = c.id)::int AS suppliers,
       (SELECT COUNT(*) FROM purchase_bukku_bills b WHERE b.company_id = c.id)::int AS bills
     FROM companies c LEFT JOIN purchase_bukku_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, suppliers: r.suppliers, bills: r.bills })));
});

router.get('/purchase-bukku/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM purchase_bukku_contacts WHERE company_id = $1)::int AS suppliers, (SELECT COUNT(*) FROM purchase_bukku_bills WHERE company_id = $1)::int AS bills`,
    [req.params.id]
  );
  res.json({ id: Number(req.params.id), name: s.name, short: s.short, enabled: s.enabled, account: s.account || '6000', suppliers: rows[0].suppliers, bills: rows[0].bills });
});

router.put('/purchase-bukku/companies/:id', requireRole('admin'), async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const account = String(b.account == null ? '' : b.account).trim();
  const short = String(b.short == null ? '' : b.short).trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(account)) return bad(res, 'Account 需为 1–20 个字符（字母、数字、. _ -）。 Account must be 1–20 characters.');
  if (short && !/^[A-Z0-9_-]{1,20}$/.test(short)) return bad(res, '简称只能用字母、数字、- _（最多 20 个字符）。 The short name may only use letters, digits, - and _.');
  await pool.query(
    `INSERT INTO purchase_bukku_settings (company_id, enabled, account, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (company_id) DO UPDATE SET enabled = $2, account = $3, updated_at = now()`,
    [req.params.id, b.enabled === true, account]
  );
  // the short name is the company's file prefix (also set on its Company Profile)
  await pool.query('UPDATE companies SET file_prefix = $1 WHERE id = $2', [short || null, req.params.id]);
  await logActivity(req.user.sub, 'Updated Purchase Bill entry settings', s.name, (b.enabled === true ? 'on' : 'off') + '; account ' + account + '; short ' + (short || '—'));
  res.json({ ok: true });
});

// ---- import an old Bukku Purchase Bill file: its bills become "exported" (so they count for duplicate checks) and its
// Contacts sheet adds suppliers. Same supplier + same number already in the system is skipped. ----
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.xlsx$/i.test(file.originalname || '')) return cb(new Error('请上传 .xlsx 文件。 Only .xlsx files are accepted.'));
    cb(null, true);
  }
});

function cellValue(cell) {
  let v = cell && cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
  }
  return v == null ? '' : v;
}
const textOf = (v) => (v instanceof Date ? '' : String(v == null ? '' : v).trim());
function parseCellDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.getUTCFullYear() + '-' + String(v.getUTCMonth() + 1).padStart(2, '0') + '-' + String(v.getUTCDate()).padStart(2, '0');
  const m = String(v || '').trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : '';
}

router.post('/purchase-bukku/companies/:id/import', requireRole('admin'), (req, res, next) => {
  importUpload.single('file')(req, res, (err) => (err ? bad(res, err.message) : next()));
}, async (req, res) => {
  const s = await loadSettings(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return bad(res, '请选择一个 .xlsx 文件。 Choose an .xlsx file.');
  const settings = { account: s.account || '' };
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch (e) { return bad(res, '读不了这个 Excel 文件。 Cannot read this Excel file.'); }

  const rowsOf = (ws) => { const out = []; ws.eachRow({ includeEmpty: true }, (row) => { const arr = []; for (let c = 1; c <= row.cellCount; c++) arr.push(cellValue(row.getCell(c))); out.push(arr); }); return out; };
  const client = await pool.connect();
  let addedSup = 0, added = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    const supRows = (await client.query('SELECT id, name, code, account, tags FROM purchase_bukku_contacts WHERE company_id = $1', [req.params.id])).rows;
    const supByName = new Map(supRows.map((x) => [normName(x.name), x]));

    const cs = wb.worksheets.find((w) => /contact/i.test(w.name));
    if (cs) {
      const rows = rowsOf(cs);
      const h = (rows[0] || []).map((x) => String(x).toUpperCase());
      const iN = h.findIndex((x) => x.includes('LEGAL')), iC = h.findIndex((x) => x.includes('CODE')), iA = h.findIndex((x) => x.includes('ACCOUNT')), iT = h.findIndex((x) => x.includes('TAG'));
      for (const r of rows.slice(1)) {
        const name = normName(iN >= 0 ? r[iN] : '');
        if (!name) continue;
        const ex = supByName.get(name);
        const code = textOf(iC >= 0 ? r[iC] : '') || (ex && ex.code) || '';
        const account = textOf(iA >= 0 ? r[iA] : '') || (ex && ex.account) || '';
        const tags = textOf(iT >= 0 ? r[iT] : '') || (ex && ex.tags) || '';
        if (ex) await client.query('UPDATE purchase_bukku_contacts SET code = $1, account = $2, tags = $3 WHERE id = $4', [code, account, tags, ex.id]);
        else { const ins = await client.query('INSERT INTO purchase_bukku_contacts (company_id, name, code, account, tags) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, code, account, tags', [req.params.id, name, code, account, tags]); supByName.set(name, ins.rows[0]); addedSup++; }
      }
    }

    const ws = wb.worksheets.find((w) => /^worksheet$/i.test(w.name)) || wb.worksheets[0];
    const rows = rowsOf(ws);
    const hi = rows.findIndex((r) => r.some((c) => /legal name/i.test(String(c))));
    if (hi < 0) throw Object.assign(new Error('找不到 Legal Name 表头。 The "Legal Name" header row was not found.'), { client: true });
    const H = rows[hi].map((x) => String(x).toLowerCase());
    const col = (t) => H.findIndex((x) => x.startsWith(t));
    const C = { code: col('contact code'), name: col('legal name'), no: col('no.'), ref: col('reference'), date: col('date'), tags: col('tags'), desc: col('description'), acc: col('account'), item: col('item description'), qty: col('quantity'), price: col('unit price'), tax: col('tax') };
    const get = (r, i) => (i >= 0 ? r[i] : '');
    const bills = [];
    let cur = null;
    for (const r of rows.slice(hi + 1)) {
      if (String(r[0]).trim() === '#') continue;
      const name = normName(get(r, C.name)), item = textOf(get(r, C.item));
      const price = parseFloat(String(get(r, C.price)).replace(/,/g, ''));
      if (!name && !item) continue;
      const line = { desc: item.toUpperCase(), account: textOf(get(r, C.acc)), qty: parseFloat(get(r, C.qty)) || 1, price: isNaN(price) ? 0 : price, tax: textOf(get(r, C.tax)) };
      const no = textOf(get(r, C.no));
      if (name && !(cur && cur.supplier === name && cur.no === no && no)) {
        cur = { supplier: name, code: textOf(get(r, C.code)), no, ref: textOf(get(r, C.ref)), date: parseCellDate(get(r, C.date)), tags: textOf(get(r, C.tags)), desc: C.desc >= 0 ? textOf(get(r, C.desc)) : '', lines: [] };
        bills.push(cur);
      }
      if (cur) cur.lines.push(line);
    }
    const existing = (await client.query('SELECT no, supplier FROM purchase_bukku_bills WHERE company_id = $1', [req.params.id])).rows;
    const have = new Set(existing.map((x) => normNo(x.no) + '|' + normName(x.supplier)));
    for (const b of bills) {
      const key = normNo(b.no) + '|' + b.supplier;
      if (normNo(b.no) && have.has(key)) { skipped++; continue; }
      const sup = supByName.get(b.supplier);
      b.lines.forEach((l) => { if (!l.account) l.account = (sup && sup.account) || settings.account; });
      const total = Math.round(b.lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;
      await client.query(
        `INSERT INTO purchase_bukku_bills (company_id, supplier, code, no, ref, bill_date, tags, description, lines, total, status, imported, exported_at, created_by, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'exported',true,now(),$11,$11, 'epoch')`,
        [req.params.id, b.supplier, b.code, b.no, b.ref, validIso(b.date) ? b.date : null, b.tags, b.desc, JSON.stringify(b.lines), total, req.user.sub]
      );
      have.add(key);
      added++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.client) return bad(res, err.message);
    throw err;
  } finally {
    client.release();
  }
  await logActivity(req.user.sub, 'Imported old Bukku purchase bill file', s.name, `${added} bill(s) added, ${skipped} skipped, ${addedSup} supplier(s) added`);
  await docs.logEvent(req, req.params.id, 'purchase_bukku', req.file.originalname || 'import.xlsx', 'created', [{ field: 'bills added', from: '', to: String(added) }, { field: 'skipped', from: '', to: String(skipped) }, { field: 'suppliers added', from: '', to: String(addedSup) }]);
  res.json({ added, skipped, addedSup });
});

// ============ COMPANY SIDE ============

// The entry page (shown in an iframe on the company's Purchases Bill page); the data endpoints below do the real checks.
router.get('/purchase-bill/app', requireAuth, (req, res) => {
  res.sendFile(PAGE);
});

// Whether the feature is on for this company (the main page uses it to decide what to show)
router.get('/companies/:companyId/purchase-bukku', requireAuth, scopeToCompany, requirePage('purchases', 1), async (req, res) => {
  const s = await loadSettings(req.params.companyId);
  res.json({ enabled: !!(s && s.enabled) });
});

const BASE = '/companies/:companyId/purchase-bill';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('purchases', level)];
const isMgr = (req) => !!(req.pageAccess && req.pageAccess.ccCrest);
async function enabledSettings(req, res) {
  const s = await loadSettings(req.params.companyId);
  if (!s || !s.enabled) { bad(res, '这家公司还没有开通这个功能。 This feature is not switched on for this company.'); return null; }
  return s;
}
const needMgr = (req, res) => { if (isMgr(req)) return true; res.status(403).json({ error: '只有 manager 可以做这个操作。 Only a manager can do this.' }); return false; };

const billOut = (r) => ({
  id: String(r.id), supplier: r.supplier, code: r.code, no: r.no, ref: r.ref, date: r.bill_date || '', tags: r.tags, desc: r.description,
  lines: r.lines, total: Number(r.total), status: r.status, dupAck: r.dup_ack, imported: r.imported,
  createdAt: new Date(r.created_at).getTime(), updatedAt: r.imported ? 0 : new Date(r.updated_at).getTime()
});
const supOut = (r) => ({ id: String(r.id), name: r.name, code: r.code, account: r.account, tags: r.tags });
const BILL_COLS = `id, supplier, code, no, ref, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, tags, description, lines, total, status, dup_ack, imported, created_at, updated_at`;

router.get(BASE, ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  const [sup, bills] = await Promise.all([
    pool.query('SELECT id, name, code, account, tags FROM purchase_bukku_contacts WHERE company_id = $1 ORDER BY name', [req.params.companyId]),
    pool.query(`SELECT ${BILL_COLS} FROM purchase_bukku_bills WHERE company_id = $1`, [req.params.companyId])
  ]);
  res.json({ mgr: isMgr(req), company: { name: s.name, short: s.short, account: s.account }, suppliers: sup.rows.map(supOut), bills: bills.rows.map(billOut) });
});

// ---- suppliers (manager only) ----
function cleanSupplier(b) {
  const name = normName(b && b.name);
  if (!name || name.length > 150) return { error: '请填供应商名称（Legal Name）。 The supplier name is required.' };
  const code = String((b && b.code) || '').trim().toUpperCase().slice(0, 30);
  if (/\s/.test(code)) return { error: 'Contact Code 不能有空格。 The Contact Code cannot contain spaces.' };
  return { name, code, account: String((b && b.account) || '').trim().slice(0, 20), tags: String((b && b.tags) || '').trim().slice(0, 100) };
}
async function saveSupplier(companyId, id, s) {
  if (id) {
    const { rows } = await pool.query('UPDATE purchase_bukku_contacts SET name = $3, code = $4, account = $5, tags = $6 WHERE id = $1 AND company_id = $2 RETURNING id, name, code, account, tags', [id, companyId, s.name, s.code, s.account, s.tags]);
    return rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO purchase_bukku_contacts (company_id, name, code, account, tags) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, name) DO UPDATE SET code = $3, account = $4, tags = $5 RETURNING id, name, code, account, tags`,
    [companyId, s.name, s.code, s.account, s.tags]
  );
  return rows[0];
}
router.post(BASE + '/suppliers', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const s = cleanSupplier(req.body);
  if (s.error) return bad(res, s.error);
  res.status(201).json(supOut(await saveSupplier(req.params.companyId, null, s)));
});
router.put(BASE + '/suppliers/:id', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const s = cleanSupplier(req.body);
  if (s.error) return bad(res, s.error);
  try {
    const row = await saveSupplier(req.params.companyId, Number(req.params.id) || 0, s);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(supOut(row));
  } catch (err) {
    if (err.code === '23505') return bad(res, '已经有同名的供应商。 A supplier with that name already exists.');
    throw err;
  }
});
router.delete(BASE + '/suppliers/:id', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  await pool.query('DELETE FROM purchase_bukku_contacts WHERE id = $1 AND company_id = $2', [Number(req.params.id) || 0, req.params.companyId]);
  res.json({ ok: true });
});

// ---- bills ----
function cleanBill(b) {
  b = b || {};
  const supplier = normName(b.supplier);
  if (!supplier || supplier.length > 150) return { error: '请填供应商。 The supplier is required.' };
  const no = String(b.no == null ? '' : b.no).trim().toUpperCase();
  if (!no || no.length > 60) return { error: '请填单号 No.（最多 60 个字符）。 The bill number is required.' };
  if (!validIso(b.date)) return { error: '请选一个有效的日期。 Pick a valid date.' };
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) return { error: '请至少填一个项目行。 Add at least one line.' };
  const lines = [];
  for (const l of b.lines) {
    const desc = String((l && l.desc) || '').trim().toUpperCase().slice(0, 200);
    const rawPrice = l && l.price;
    const price = rawPrice === '' || rawPrice == null ? NaN : Number(rawPrice), qty = Number(l && l.qty);
    if (!desc || !Number.isFinite(price) || price < 0) return { error: '每一行都要有项目和单价。 Every line needs an item and a unit price.' };
    lines.push({ desc, account: String((l && l.account) || '').trim().slice(0, 20), qty: Number.isFinite(qty) && qty > 0 ? qty : 1, price, tax: String((l && l.tax) || '').trim().toUpperCase().slice(0, 20) });
  }
  const total = Math.round(lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;
  return { supplier, no, date: b.date, lines, total, code: String(b.code || '').trim().toUpperCase().slice(0, 30), ref: String(b.ref || '').trim().slice(0, 60), tags: String(b.tags || '').trim().slice(0, 100), desc: String(b.desc || '').trim().slice(0, 200), dupAck: b.dupAck === true };
}
async function staffSupplierProblem(req, supplier) {
  if (isMgr(req)) return null;
  const { rows } = await pool.query('SELECT name FROM purchase_bukku_contacts WHERE company_id = $1', [req.params.companyId]);
  return rows.some((r) => normName(r.name) === supplier) ? null : '供应商不在名单，请从下拉选择或通知 manager 新增。 The supplier is not in the list — ask a manager to add it.';
}

router.post(BASE + '/bills', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = cleanBill(req.body);
  if (b.error) return bad(res, b.error);
  const problem = await staffSupplierProblem(req, b.supplier);
  if (problem) return bad(res, problem);
  const { rows } = await pool.query(
    `INSERT INTO purchase_bukku_bills (company_id, supplier, code, no, ref, bill_date, tags, description, lines, total, dup_ack, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12) RETURNING ${BILL_COLS}`,
    [req.params.companyId, b.supplier, b.code, b.no, b.ref, b.date, b.tags, b.desc, JSON.stringify(b.lines), b.total, b.dupAck, req.user.sub]
  );
  res.status(201).json(billOut(rows[0]));
});

router.put(BASE + '/bills/:id', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const id = Number(req.params.id) || 0;
  const { rows: old } = await pool.query(`SELECT ${BILL_COLS} FROM purchase_bukku_bills WHERE id = $1 AND company_id = $2`, [id, req.params.companyId]);
  if (!old[0]) return res.status(404).json({ error: 'Not found' });
  if (old[0].status === 'exported' && !isMgr(req)) return res.status(403).json({ error: '已导出的单据只有 manager 可以修改。 Only a manager can change an exported bill.' });
  const b = cleanBill(req.body);
  if (b.error) return bad(res, b.error);
  const problem = await staffSupplierProblem(req, b.supplier);
  if (problem) return bad(res, problem);
  const { rows } = await pool.query(
    `UPDATE purchase_bukku_bills SET supplier = $3, code = $4, no = $5, ref = $6, bill_date = $7, tags = $8, description = $9, lines = $10::jsonb, total = $11,
       dup_ack = $12, updated_by = $13, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING ${BILL_COLS}`,
    [id, req.params.companyId, b.supplier, b.code, b.no, b.ref, b.date, b.tags, b.desc, JSON.stringify(b.lines), b.total, b.dupAck, req.user.sub]
  );
  const shape = (x) => ({ supplier: x.supplier, no: x.no, date: x.date || x.bill_date, tags: x.tags, lines: x.lines.map((l) => l.desc + ' | ' + l.account + ' | ' + l.qty + ' x ' + l.price) });
  await docs.logUpdate(req, req.params.companyId, 'purchase_bukku_bill', old[0].no, docs.diffObjects(shape(old[0]), shape(b)));
  res.json(billOut(rows[0]));
});

function idList(v) { return (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000); }

// Mark bills exported / back to not exported (manager only)
router.post(BASE + '/bills/status', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const ids = idList(req.body && req.body.ids), status = req.body && req.body.status;
  if (!ids.length || !['draft', 'exported'].includes(status)) return bad(res, 'Invalid request');
  const r = await pool.query(
    `UPDATE purchase_bukku_bills SET status = $3, exported_at = CASE WHEN $3 = 'exported' THEN now() ELSE NULL END, updated_by = $4, updated_at = now()
     WHERE company_id = $1 AND id = ANY($2::int[])`,
    [req.params.companyId, ids, status, req.user.sub]
  );
  await docs.logEvent(req, req.params.companyId, 'purchase_bukku', status === 'exported' ? 'marked exported' : 'marked not exported', 'updated', [{ field: 'bills', from: '', to: String(r.rowCount) }]);
  res.json({ ok: true, changed: r.rowCount });
});

router.delete(BASE + '/bills/:id', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const { rows } = await pool.query('DELETE FROM purchase_bukku_bills WHERE id = $1 AND company_id = $2 RETURNING supplier, no, total', [Number(req.params.id) || 0, req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await docs.logEvent(req, req.params.companyId, 'purchase_bukku_bill', rows[0].no, 'deleted', [{ field: 'supplier', from: rows[0].supplier, to: '' }, { field: 'total', from: String(rows[0].total), to: '' }]);
  res.json({ ok: true });
});

// ---- Bukku "Bills (Credit Purchase) - Extended Mode - MY" import file of the ticked bills (manager only) ----
const HEADER = ['Contact Code (1)', 'Legal Name (2)', 'No. (3)', 'Reference No.', 'Date (D) *', 'Payment Term (4)', 'Due Date (D) (5)', 'Currency (6)', 'Rate (7)', 'Tags (8)', 'Description', 'Product (9)', 'Account (10) *', 'Item Description *', 'Quantity (11)', 'UOM (12)', 'Location (13)', 'Unit Price *', 'Discount (14)', 'Tax (15)'];
const NOTES = ['TEMPLATE FOR BILLS (CREDIT PURCHASE) - EXTENDED MODE - MY', '', 'INSTRUCTIONS FOR IMPORT (PLEASE READ FIRST)',
  "Lines that start with '#' are comments and will be ignored by the system during import.",
  "DO NOT remove the line started with '$', the system requires it to identify the columns.",
  "DO NOT remove the first column with '#' and '$', system will read data from 2nd column.",
  "Fields marked with '*' are required.",
  '- To create a transaction with more than one line item, you can either:',
  '    > Add additional lines with the same data in the columns before column M.',
  '    > Add additional lines with all columns left blank before column M.', '', 'NOTES:',
  '(D) Accepted format for dates is "DD/MM/YYYY".',
  "(1) The transaction's supplier, enter the Contact's Contact Code (eg. C-A0001). If left blank, the supplier will be matched by Legal Name instead (Column 2).",
  "(2) The supplier's Legal Name (eg. Acme Sdn Bhd). Used to match the supplier only if Contact Code is blank or doesn't match an existing code.",
  "(3) The transaction's unique number, enter the actual number or a number format with number placeholder (eg. IV-[5DIGIT]) for automated running number, default number format is used if left blank.",
  "(4) The transaction's payment term, enter the Payment Term's name (eg. NET30), you may leave blank to set a Due Date.",
  "(5) The transaction's due date, only use this if Payment Term is not provided, default to the transaction's Date if left blank.",
  "(6) The transaction's currency, enter the 3 character ISO currency code (eg. MYR), default to home currency if left blank.",
  "(7) The transaction's exchange rate used to convert the amount into home currency, default to 1 if left blank.",
  "(8) Assign the transaction to multiple tags, enter the Tag's name and you may specific multiple tags with with commas.",
  "(9) The line item's product, enter the Product's name.",
  "(10) The line item's account, enter the Account's code.",
  "(11) The line item's quantity, default to 1 if left blank.",
  "(12) The line item's product UOM (Unit of Measurements), only used when product is selected, it will set to the default / base UOM if left blank.",
  "(13) The line item's product location, enter the Location's code, only used when inventory product is selected, it will set to default location if left blank.",
  '(14) The line item’s discount, enter amount value (eg. 5.00) or percentage value (eg. 5%).',
  "(15) The purchase tax applicable for the line item, enter the Tax's code.", ''];
const numOrText = (v) => { const s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? Number(s) : s; };
const COL_WIDTHS = [3, 12, 34, 14, 12, 12, 10, 10, 8, 6, 12, 14, 10, 10, 40, 8, 6, 8, 12, 8, 8];

router.post(BASE + '/export', ...guard(2), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  if (!needMgr(req, res)) return;
  const ids = idList(req.body && req.body.ids);
  if (!ids.length) return bad(res, '请先勾选要导出的单据。 Tick the bills to export first.');
  const { rows } = await pool.query(`SELECT ${BILL_COLS} FROM purchase_bukku_bills WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY bill_date, id`, [req.params.companyId, ids]);
  if (!rows.length) return bad(res, '没有找到这些单据。 Those bills were not found.');
  const { rows: sups } = await pool.query('SELECT name, code, account, tags FROM purchase_bukku_contacts WHERE company_id = $1 ORDER BY name', [req.params.companyId]);
  const supByName = new Map(sups.map((x) => [normName(x.name), x]));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Worksheet');
  NOTES.forEach((t) => ws.addRow(['#', t]));
  ws.addRow(['$', ...HEADER]);
  for (const b of rows) {
    const sup = supByName.get(normName(b.supplier));
    const code = (sup && sup.code) || b.code || '';
    b.lines.forEach((l, i) => {
      const r = ws.addRow(['',
        ...(i === 0 ? [code, b.supplier, b.no, b.ref || '', dmy(b.bill_date), '', '', '', '', b.tags || '', b.description || '', ''] : Array(12).fill('')),
        numOrText(l.account || (sup && sup.account) || s.account), l.desc, l.qty == null ? 1 : l.qty, '', '', Number(l.price), '', l.tax || '']);
      // No. / Contact Code / Reference / Date stay text so Excel does not reformat things like "0626/0321"
      [2, 4, 5, 6].forEach((c) => { const cell = r.getCell(c); if (cell.value !== '') cell.numFmt = '@'; });
      r.getCell(19).numFmt = '#,##0.00';
    });
  }
  ws.columns.forEach((c, i) => { c.width = COL_WIDTHS[i] || 10; });
  const cs = wb.addWorksheet('Contacts');
  cs.addRow(['Legal Name', 'Contact Code', 'ACCOUNT', 'TAGS']);
  sups.forEach((x) => cs.addRow([x.name, x.code || '', numOrText(x.account || ''), x.tags || '']));
  cs.columns.forEach((c, i) => { c.width = [40, 14, 10, 14][i]; });

  const months = rows.map((b) => b.bill_date).filter(Boolean).sort().map((d) => d.slice(0, 7).replace('-', '_'));
  const span = months.length ? (months[0] === months[months.length - 1] ? months[0] : months[0] + '_' + months[months.length - 1]) : 'NO_DATE';
  const info = await docs.companyInfo(req.params.companyId);
  const base = await docs.fileBase('purchase_bukku', req.params.companyId, { SPAN: span }, info.PREFIX + '-BUKKU-PURCHASES_BILL-' + span);
  const filename = base + '.xlsx';
  docs.stampWorkbook(wb, docs.stampText(await docs.userNameFor(req)));
  await docs.logEvent(req, req.params.companyId, 'purchase_bukku', filename, 'generated', [{ field: 'bills', from: '', to: String(rows.length) }]);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('X-File-Name', encodeURIComponent(filename));
  await wb.xlsx.write(res);
  res.end();
});

router.use((err, req, res, next) => {
  console.error('purchaseBukku route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
