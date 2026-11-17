const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');
const bukkuApi = require('./bukkuApi').bukku;

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
      await learn(client, req.params.id, b.supplier, b.date, b.lines, true);   // old bills teach each supplier's usual items and last prices
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
  lines: r.lines, total: Number(r.total), status: r.status, dupAck: r.dup_ack, imported: r.imported, revised: !!r.revised, hq: r.hq || null,
  createdAt: new Date(r.created_at).getTime(), updatedAt: r.imported ? 0 : new Date(r.updated_at).getTime(),
  approved: !!r.approved_at, noOriginal: !!r.no_original, inBukku: !!r.in_bukku_at, payDue: r.pay_due || '', payStatus: r.pay_task_status || '',
  bukkuNo: r.bukku_txn_no || '', bukkuSent: !!r.bukku_sent_at, bukkuError: r.bukku_send_error || '', payMode: r.pay_mode || '', bukkuStatus: r.bukku_sent_status || ''
});
const supOut = (r) => ({ id: String(r.id), name: r.name, code: r.code, account: r.account, tags: r.tags });
const BILL_COLS = `id, supplier, code, no, ref, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, tags, description, lines, total, status, dup_ack, imported, revised, hq, created_at, updated_at,
  approved_at, no_original, in_bukku_at, to_char(pay_due, 'YYYY-MM-DD') AS pay_due, bukku_txn_no, bukku_sent_at, bukku_send_error, pay_mode, bukku_sent_status,
  (SELECT t.status FROM work_tasks t WHERE t.purchase_bill_id = purchase_bukku_bills.id AND t.kind = 'pay' ORDER BY t.id DESC LIMIT 1) AS pay_task_status`;

// ---- the company's Stock Count items (when it uses Stock Count): purchase lines can be linked to them ----
async function stockOf(companyId) {
  const on = await pool.query('SELECT enabled FROM stock_count_settings WHERE company_id = $1', [companyId]);
  if (!on.rows[0] || !on.rows[0].enabled) return null;
  const { rows } = await pool.query(`SELECT path, data FROM stock_count_docs WHERE company_id = $1 AND coll = 'items'`, [companyId]);
  return rows.map((r) => ({
    id: r.path.slice(6), name: String(r.data.name || ''), unit: String(r.data.unit || ''), sub: String(r.data.sub || ''),
    pack: Number(r.data.pack) > 1 ? Number(r.data.pack) : 0, account: String(r.data.account || ''), active: r.data.active !== false
  }));
}
async function stockIdsProblem(companyId, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return null;
  const { rows } = await pool.query('SELECT path FROM stock_count_docs WHERE company_id = $1 AND path = ANY($2::text[])', [companyId, want.map((i) => 'items/' + i)]);
  return rows.length === want.length ? null : '有一个盘点货品不存在（可能已被删除）。 A Stock Count item in this bill no longer exists.';
}
const ITEM_COLS = `id, supplier, alias, stock_item_id, unit, per, price, to_char(last_date, 'YYYY-MM-DD') AS last_date, account, tax, uses`;
const itemOut = (r) => ({
  id: String(r.id), supplier: r.supplier, alias: r.alias, item: r.stock_item_id, unit: r.unit, per: Number(r.per),
  price: r.price == null ? null : Number(r.price), date: r.last_date || '', account: r.account, tax: r.tax, uses: r.uses
});

// Remember what each supplier sold us (name, buying unit, last price) so the next bill is mostly clicking; `bump` = count this as a new use.
async function learn(db, companyId, supplier, date, lines, bump) {
  for (const l of lines) {
    for (const alias of [...new Set([l.desc, l.as].filter(Boolean))]) {
      await db.query(
        `INSERT INTO purchase_bukku_items (company_id, supplier, alias, stock_item_id, unit, per, price, last_date, account, tax, uses)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11)
         ON CONFLICT (company_id, supplier, alias) DO UPDATE SET
           stock_item_id = CASE WHEN EXCLUDED.stock_item_id <> '' THEN EXCLUDED.stock_item_id ELSE purchase_bukku_items.stock_item_id END,
           unit = CASE WHEN EXCLUDED.unit <> '' THEN EXCLUDED.unit ELSE purchase_bukku_items.unit END,
           per = CASE WHEN EXCLUDED.unit <> '' THEN EXCLUDED.per ELSE purchase_bukku_items.per END,
           price = CASE WHEN EXCLUDED.last_date IS NOT NULL AND (purchase_bukku_items.last_date IS NULL OR EXCLUDED.last_date >= purchase_bukku_items.last_date)
                        THEN EXCLUDED.price ELSE purchase_bukku_items.price END,
           last_date = GREATEST(purchase_bukku_items.last_date, EXCLUDED.last_date),
           account = CASE WHEN EXCLUDED.account <> '' THEN EXCLUDED.account ELSE purchase_bukku_items.account END,
           tax = CASE WHEN EXCLUDED.tax <> '' THEN EXCLUDED.tax ELSE purchase_bukku_items.tax END,
           uses = purchase_bukku_items.uses + EXCLUDED.uses, updated_at = now()`,
        [companyId, supplier, alias, l.item || '', l.unit || '', l.per > 0 ? l.per : 1, l.price, validIso(date) ? date : null, l.account || '', l.tax || '', bump ? 1 : 0]
      );
    }
  }
}

// ---- read a QC GROUP (HQ) bill PDF into a purchase bill: the page fills the entry form with it (nothing is saved here) ----
router.post(BASE + '/pdf-parse', ...guard(2), express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const cid = req.params.companyId;
  const s = await loadSettings(cid);
  if (!s || !s.enabled) return bad(res, 'Purchases Bill 还没有开通。 The Purchases Bill page is not switched on for this company.');
  if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Invalid request');
  const sup = (await pool.query(
    "SELECT name, code, account FROM purchase_bukku_contacts WHERE company_id = $1 AND (code = 'C-Q0001' OR name ILIKE 'QC GROUP%') ORDER BY (code = 'C-Q0001') DESC LIMIT 1", [cid]
  )).rows[0];
  if (!sup) return bad(res, '找不到供应商 QC GROUP，这个功能只能读 QC GROUP 的 HQ 单。 Supplier QC GROUP not found: only QC GROUP HQ bills can be read.');
  let text;
  try { text = (await require('pdf-parse/lib/pdf-parse.js')(req.body)).text; } catch (e) { return bad(res, '读不到这个 PDF。 Cannot read this PDF.'); }
  const bill = require('../lib/hqBill').parseBill(text, String(req.query.name || ''));
  if (!bill.items.length) return bad(res, '这个 PDF 里找不到账单的行（要 QC GROUP 的 HQ 单）。 No bill lines found: it must be a QC GROUP HQ bill.');
  // the Account of each line: the same settings as the Tuition & Allowance HQ bills (registration / module / other)
  let pa = { registration: '6000', seasonal: '6000-01', module: '6001', other: '6002' };
  try {
    const c = (await pool.query("SELECT data FROM tuition_docs WHERE company_id = $1 AND path = 'settings/config'", [cid])).rows[0];
    if (c && c.data && c.data.hq && c.data.hq.purchaseAccounts) pa = Object.assign(pa, c.data.hq.purchaseAccounts);
  } catch (e) { /* the company has no Tuition & Allowance: the defaults are used */ }
  const accOf = (k) => (k === 'registration' ? pa.registration : k === 'seasonal' ? pa.seasonal : k === 'module' ? pa.module : pa.other);
  res.json({
    hq: bill,
    supplier: String(sup.name).toUpperCase().replace(/\s+/g, ' ').trim(), no: bill.invoiceNo, date: bill.date, branch: bill.branch, total: bill.total, itemsTotal: bill.itemsTotal, totalMatches: bill.totalMatches,
    lines: bill.items.map((l) => ({ desc: [l.title, l.fields.module, l.fields.jersey, l.fields.game, l.fields.client].filter(Boolean).join(' - ').toUpperCase().slice(0, 200), qty: l.qty || 1, price: l.price, account: accOf(l.kind) }))
  });
});

router.get(BASE, ...guard(1), async (req, res) => {
  const s = await enabledSettings(req, res); if (!s) return;
  const [sup, bills, items, stock] = await Promise.all([
    pool.query('SELECT id, name, code, account, tags FROM purchase_bukku_contacts WHERE company_id = $1 ORDER BY name', [req.params.companyId]),
    pool.query(`SELECT ${BILL_COLS} FROM purchase_bukku_bills WHERE company_id = $1`, [req.params.companyId]),
    pool.query(`SELECT ${ITEM_COLS} FROM purchase_bukku_items WHERE company_id = $1 ORDER BY supplier, alias`, [req.params.companyId]),
    stockOf(req.params.companyId)
  ]);
  res.json({
    mgr: isMgr(req), company: { name: s.name, short: s.short, account: s.account }, suppliers: sup.rows.map(supOut), bills: bills.rows.map(billOut),
    items: items.rows.map(itemOut), hasStock: !!stock, stock: stock || []
  });
});

// ---- each supplier's usual items (and the link to Stock Count items) ----
function cleanItem(b) {
  b = b || {};
  const supplier = normName(b.supplier), alias = String(b.alias == null ? '' : b.alias).toUpperCase().replace(/\s+/g, ' ').trim();
  if (!supplier || supplier.length > 150) return { error: '请填供应商。 The supplier is required.' };
  if (!alias || alias.length > 200) return { error: '请填项目名称。 The item name is required.' };
  const per = Number(b.per == null || b.per === '' ? 1 : b.per);
  if (!Number.isFinite(per) || per <= 0 || per > 1000000) return { error: '「一个盘点单位 = 几个」要大于 0。 The number per Stock Count unit must be more than 0.' };
  const price = b.price === '' || b.price == null ? null : Number(b.price);
  if (price !== null && (!Number.isFinite(price) || price < 0)) return { error: '单价不对。 The price is not valid.' };
  return {
    supplier, alias, item: String(b.item || '').trim().slice(0, 80), unit: String(b.unit || '').trim().toUpperCase().slice(0, 20),
    per: Math.round(per * 10000) / 10000, price: price === null ? null : Math.round(price * 10000) / 10000,
    account: String(b.account || '').trim().slice(0, 20), tax: String(b.tax || '').trim().toUpperCase().slice(0, 20)
  };
}
router.post(BASE + '/items', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = cleanItem(req.body);
  if (b.error) return bad(res, b.error);
  const problem = await stockIdsProblem(req.params.companyId, [b.item]);
  if (problem) return bad(res, problem);
  const { rows } = await pool.query(
    `INSERT INTO purchase_bukku_items (company_id, supplier, alias, stock_item_id, unit, per, price, account, tax)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (company_id, supplier, alias) DO UPDATE SET stock_item_id = $4, unit = $5, per = $6, price = $7, account = $8, tax = $9, updated_at = now()
     RETURNING ${ITEM_COLS}`,
    [req.params.companyId, b.supplier, b.alias, b.item, b.unit, b.per, b.price, b.account, b.tax]
  );
  res.status(201).json(itemOut(rows[0]));
});
router.put(BASE + '/items/:id', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = cleanItem(req.body);
  if (b.error) return bad(res, b.error);
  const problem = await stockIdsProblem(req.params.companyId, [b.item]);
  if (problem) return bad(res, problem);
  try {
    const { rows } = await pool.query(
      `UPDATE purchase_bukku_items SET supplier = $3, alias = $4, stock_item_id = $5, unit = $6, per = $7, price = $8, account = $9, tax = $10, updated_at = now()
        WHERE id = $1 AND company_id = $2 RETURNING ${ITEM_COLS}`,
      [Number(req.params.id) || 0, req.params.companyId, b.supplier, b.alias, b.item, b.unit, b.per, b.price, b.account, b.tax]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(itemOut(rows[0]));
  } catch (err) {
    if (err.code === '23505') return bad(res, '这个供应商已经有同名的项目。 That supplier already has an item with this name.');
    throw err;
  }
});
router.delete(BASE + '/items/:id', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  await pool.query('DELETE FROM purchase_bukku_items WHERE id = $1 AND company_id = $2', [Number(req.params.id) || 0, req.params.companyId]);
  res.json({ ok: true });
});
// Many at once (pasted from Excel): supplier | name on the invoice | Stock Count item (system name) | buying unit | how many per 1 Stock Count unit | price
router.post(BASE + '/items/bulk', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 3000) return bad(res, 'Invalid request');
  const stock = await stockOf(req.params.companyId);
  const byName = new Map((stock || []).map((x) => [normName(x.name), x.id]));
  let saved = 0; const skipped = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, r] of rows.entries()) {
      const sys = normName(r && r.stock);
      if (sys && !byName.has(sys)) { skipped.push({ row: i + 1, alias: String((r && r.alias) || ''), why: '系统里找不到这个盘点货品：' + sys }); continue; }
      const b = cleanItem({ supplier: r && r.supplier, alias: r && r.alias, item: sys ? byName.get(sys) : '', unit: r && r.unit, per: r && r.per, price: r && r.price });
      if (b.error) { skipped.push({ row: i + 1, alias: String((r && r.alias) || ''), why: b.error }); continue; }
      await client.query(
        `INSERT INTO purchase_bukku_items (company_id, supplier, alias, stock_item_id, unit, per, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (company_id, supplier, alias) DO UPDATE SET stock_item_id = $4, unit = $5, per = $6,
           price = COALESCE($7, purchase_bukku_items.price), updated_at = now()`,
        [req.params.companyId, b.supplier, b.alias, b.item, b.unit, b.per, b.price]
      );
      saved++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ saved, skipped });
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
// the Bukku suppliers (read through the Bukku API, Control Panel > Bukku API) become suppliers here: new names are added with their
// Contact Code, existing ones only get a code when they have none (their Account / Tags are left alone)
router.post(BASE + '/suppliers/from-bukku', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const { rows: src } = await pool.query(
    `SELECT legal_name, contact_code FROM bukku_contacts WHERE company_id = $1 AND NOT is_archived AND 'supplier' = ANY(types) ORDER BY legal_name`,
    [req.params.companyId]
  );
  if (!src.length) return bad(res, '还没有从 Bukku 读到供应商。请 Owner 先在 Control Panel > Bukku API 同步。 No Bukku suppliers yet - the Owner syncs them in Control Panel > Bukku API.');
  const { rows: have } = await pool.query('SELECT name, code FROM purchase_bukku_contacts WHERE company_id = $1', [req.params.companyId]);
  const byName = new Map(have.map((r) => [normName(r.name), r]));
  let added = 0, coded = 0, same = 0;
  for (const r of src) {
    const name = normName(r.legal_name);
    if (!name || name.length > 150) continue;
    const code = /\s/.test(r.contact_code || '') ? '' : String(r.contact_code || '').trim().toUpperCase().slice(0, 30);
    const ex = byName.get(name);
    if (!ex) {
      await pool.query('INSERT INTO purchase_bukku_contacts (company_id, name, code, account, tags) VALUES ($1,$2,$3,\'\',\'\') ON CONFLICT (company_id, name) DO NOTHING', [req.params.companyId, name, code]);
      byName.set(name, { name, code });
      added++;
    } else if (!ex.code && code) {
      await pool.query('UPDATE purchase_bukku_contacts SET code = $3 WHERE company_id = $1 AND name = $2', [req.params.companyId, ex.name, code]);
      coded++;
    } else same++;
  }
  res.json({ ok: true, total: src.length, added, coded, same });
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

// ---- the flow of a bill: Approve -> in Bukku (ticked by a person) -> pay at the bank (a task in the work list) ----
router.post(BASE + '/bills/stage', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res)) return;
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length || ids.length > 500) return bad(res, 'Invalid request');
  const cid = req.params.companyId, uid = req.user.sub;
  let r;
  if (b.action === 'no-original') {
    // anyone who enters bills can flag a bill that still has no official document (or clear the flag)
    r = await pool.query('UPDATE purchase_bukku_bills SET no_original = $3 WHERE company_id = $1 AND id = ANY($2::int[])', [cid, ids, b.value !== false]);
  } else {
    if (!needMgr(req, res)) return;
    if (b.action === 'approve') {
      r = await pool.query('UPDATE purchase_bukku_bills SET approved_at = now(), approved_by = $3 WHERE company_id = $1 AND id = ANY($2::int[]) AND approved_at IS NULL', [cid, ids, uid]);
    } else if (b.action === 'unapprove') {
      r = await pool.query('UPDATE purchase_bukku_bills SET approved_at = NULL, approved_by = NULL WHERE company_id = $1 AND id = ANY($2::int[]) AND in_bukku_at IS NULL', [cid, ids]);
    } else if (b.action === 'in-bukku') {
      r = await pool.query('UPDATE purchase_bukku_bills SET in_bukku_at = now(), in_bukku_by = $3, approved_at = COALESCE(approved_at, now()), approved_by = COALESCE(approved_by, $3) WHERE company_id = $1 AND id = ANY($2::int[]) AND in_bukku_at IS NULL', [cid, ids, uid]);
    } else if (b.action === 'not-in-bukku') {
      r = await pool.query('UPDATE purchase_bukku_bills SET in_bukku_at = NULL, in_bukku_by = NULL WHERE company_id = $1 AND id = ANY($2::int[]) AND NOT EXISTS (SELECT 1 FROM work_tasks t WHERE t.purchase_bill_id = purchase_bukku_bills.id AND t.kind = \'pay\')', [cid, ids]);
    } else return bad(res, 'Invalid request');
  }
  res.json({ ok: true, changed: r.rowCount });
});

// "This bill must be paid": a "pay at the bank" task goes to the work list (a manager does it, the Owner checks it)
router.post(BASE + '/bills/request-payment', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length || ids.length > 200) return bad(res, 'Invalid request');
  const due = String(b.due || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(new Date(due + 'T00:00:00Z'))) return bad(res, '请选还款日。 Choose the day the bill must be paid.');
  const cid = req.params.companyId;
  // who goes to the bank: the one chosen, else a manager of this company's staff, else the one asking
  let assignee = Number(b.assigneeId) || 0;
  if (assignee) {
    const { rows } = await pool.query("SELECT id FROM users WHERE id = $1 AND active AND role IN ('admin','manager','staff')", [assignee]);
    if (!rows[0]) return bad(res, '不能把事项交给这个人。 You cannot give work to this person.');
  } else {
    const { rows } = await pool.query(
      `SELECT ms.manager_user_id AS id FROM company_staff cs JOIN manager_staff ms ON ms.staff_id = cs.staff_id
         JOIN users u ON u.id = ms.manager_user_id AND u.active WHERE cs.company_id = $1 ORDER BY (ms.manager_user_id = $2) DESC, ms.manager_user_id LIMIT 1`,
      [cid, req.user.sub]
    );
    assignee = rows[0] ? rows[0].id : req.user.sub;
  }
  const { rows: bills } = await pool.query(
    `SELECT id, supplier, no, total, in_bukku_at,
       EXISTS (SELECT 1 FROM work_tasks t WHERE t.purchase_bill_id = purchase_bukku_bills.id AND t.kind = 'pay') AS has_task
       FROM purchase_bukku_bills WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY bill_date, id`, [cid, ids]);
  const out = { created: 0, notInBukku: 0, already: 0 };
  for (const x of bills) {
    if (!x.in_bukku_at) { out.notInBukku++; continue; }
    if (x.has_task) { out.already++; continue; }
    await pool.query(
      `INSERT INTO work_tasks (company_id, title, kind, assignee_user_id, due_date, purchase_bill_id, created_by) VALUES ($1,$2,'pay',$3,$4,$5,$6)`,
      [cid, ('去银行付款 Pay at bank: ' + x.supplier + ' ' + (x.no || '') + ' · RM ' + Number(x.total).toFixed(2)).slice(0, 200), assignee, due, x.id, req.user.sub]
    );
    await pool.query('UPDATE purchase_bukku_bills SET pay_due = $2 WHERE id = $1', [x.id, due]);
    out.created++;
  }
  res.json({ ok: true, ...out });
});

// ---- send bills to Bukku through the API: a bill is first made and checked here (Approve + preview + confirm); the Owner decides per company
//     whether Bukku gets it as a draft or as a finished bill ----
async function bukkuCtx(companyId, defaultAccount) {
  const [acc, con, tag, sup] = await Promise.all([
    pool.query('SELECT bukku_id, code, name, type FROM bukku_accounts WHERE company_id = $1', [companyId]),
    pool.query('SELECT bukku_key, legal_name, contact_code, types FROM bukku_contacts WHERE company_id = $1 AND NOT is_archived', [companyId]),
    pool.query('SELECT bukku_id, name FROM bukku_tags WHERE company_id = $1', [companyId]),
    pool.query('SELECT name, code FROM purchase_bukku_contacts WHERE company_id = $1', [companyId])
  ]);
  return { accounts: acc.rows, contacts: con.rows, tags: tag.rows, suppliers: sup.rows, defaultAccount: defaultAccount || '' };
}
function bukkuFindContact(ctx, supplierName) {
  const n = normName(supplierName);
  const sup = ctx.suppliers.find((s) => normName(s.name) === n);
  const code = sup && sup.code ? String(sup.code).toUpperCase() : '';
  return (code && ctx.contacts.find((c) => String(c.contact_code || '').toUpperCase() === code)) || ctx.contacts.find((c) => normName(c.legal_name) === n) || null;
}
const bukkuAccountByCode = (ctx, raw) => {
  const code = String(raw || '').trim().split(/\s+/)[0].toUpperCase();
  return code ? ctx.accounts.find((a) => String(a.code || '').toUpperCase() === code) || null : null;
};

// What a bill becomes in Bukku (payment_mode credit / cash / claim). Returns the payload and everything that is wrong with it.
function buildBukkuBill(bill, ctx, opt) {
  const problems = [];
  const mode = ['credit', 'cash', 'claim'].includes(opt.mode) ? opt.mode : 'credit';
  const contact = bukkuFindContact(ctx, bill.supplier);
  let supplierId = null;
  if (!contact) problems.push('供应商「' + bill.supplier + '」在 Bukku 的联络人里找不到（看 Contact Code 或名称是否一样，再按 Control Panel 的「重新同步」）。');
  else if (!Number.isInteger(Number(contact.bukku_key))) problems.push('Bukku 的联络人「' + contact.legal_name + '」没有可用的 id，请重新同步。');
  else if (!(contact.types || []).includes('supplier')) problems.push('Bukku 里「' + contact.legal_name + '」不是供应商类型的联络人。');
  else supplierId = Number(contact.bukku_key);

  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  if (!lines.length) problems.push('这张单没有明细行。');
  const items = [];
  const codes = [];
  let sum = 0;
  lines.forEach((l, i) => {
    const n = i + 1;
    const qty = Number(l.qty), price = Number(l.price);
    if (!(qty > 0) || !Number.isFinite(price) || price < 0) { problems.push('第 ' + n + ' 行的数量或单价不对。'); return; }
    if (String(l.tax || '').trim()) { problems.push('第 ' + n + ' 行有税码「' + l.tax + '」，这个版本还不支持带税码的单，请先手动处理。'); return; }
    const acc = bukkuAccountByCode(ctx, l.account || ctx.defaultAccount);
    if (!acc) { problems.push('第 ' + n + ' 行的科目「' + (l.account || ctx.defaultAccount || '空') + '」在 Bukku 的科目表里找不到。'); return; }
    codes.push(acc.code);
    sum += qty * price;
    items.push({ type: null, account_id: Number(acc.bukku_id), description: String(l.desc || '').slice(0, 255), unit_price: price, quantity: qty });
  });
  if (items.length === lines.length && Math.abs(sum - Number(bill.total)) > 0.011) problems.push('明细合计 ' + sum.toFixed(2) + ' 和单据总额 ' + Number(bill.total).toFixed(2) + ' 不一样。');

  const tagNames = String(bill.tags || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const tagIds = [];
  tagNames.forEach((tn) => {
    const g = ctx.tags.find((x) => String(x.name).trim().toUpperCase() === tn.toUpperCase());
    if (g) tagIds.push(Number(g.bukku_id)); else problems.push('Tag「' + tn + '」在 Bukku 里找不到（先在 Bukku 建好，再按「重新同步」）。');
  });

  const payload = {
    payment_mode: mode, contact_id: supplierId, number: bill.no || undefined, number2: bill.ref || undefined, date: bill.bill_date,
    currency_code: 'MYR', exchange_rate: 1, tax_mode: 'exclusive', form_items: items, status: opt.status === 'ready' ? 'ready' : 'draft'
  };
  // a finished bill is a purchase we received: it is not sent on to MyInvois from here
  if (payload.status === 'ready') payload.myinvois_action = 'NORMAL';
  if (tagIds.length) payload.tag_ids = tagIds;
  if (bill.description) payload.description = String(bill.description).slice(0, 255);
  if (mode === 'credit') {
    payload.due_date = bill.pay_due || bill.bill_date;
  } else if (mode === 'cash') {
    const dep = ctx.accounts.find((a) => String(a.bukku_id) === String(opt.accountId));
    if (!dep) problems.push('现付：请选付款的银行 / 现金账户。');
    else payload.deposit_items = [{ line: 1, account_id: Number(dep.bukku_id), amount: Number(bill.total) }];
  } else {
    const emp = ctx.contacts.find((c) => String(c.bukku_key) === String(opt.employeeKey));
    if (!emp || !(emp.types || []).includes('employee')) problems.push('员工代付（claim）：请选 Bukku 里的员工联络人。');
    else { payload.contact2_id = supplierId; payload.contact_id = Number(emp.bukku_key); }
  }
  return { payload, problems, summary: { contact: contact ? contact.legal_name : '', accounts: [...new Set(codes)], tags: tagNames, mode } };
}

router.get(BASE + '/bukku-options', ...guard(2), async (req, res) => {
  if (!await enabledSettings(req, res) || !needMgr(req, res)) return;
  const cid = req.params.companyId;
  const conn = await bukkuApi.loadConn(cid);
  const [cash, emp, sent] = await Promise.all([
    pool.query(`SELECT bukku_id, code, name FROM bukku_accounts WHERE company_id = $1 AND type IN ('current_assets','bank','cash') ORDER BY code`, [cid]),
    pool.query(`SELECT bukku_key, legal_name FROM bukku_contacts WHERE company_id = $1 AND NOT is_archived AND 'employee' = ANY(types) ORDER BY legal_name`, [cid]),
    pool.query('SELECT COUNT(*)::int AS n FROM purchase_bukku_bills WHERE company_id = $1 AND bukku_txn_id IS NOT NULL', [cid])
  ]);
  res.json({
    connected: !!conn, sendEnabled: !!(conn && conn.send_enabled), sendStatus: conn && conn.send_status === 'ready' ? 'ready' : 'draft', sentCount: sent.rows[0].n,
    cashAccounts: cash.rows.map((r) => ({ id: String(r.bukku_id), label: (r.code ? r.code + ' ' : '') + r.name })),
    employees: emp.rows.map((r) => ({ key: r.bukku_key, name: r.legal_name }))
  });
});

async function loadBillsForBukku(cid, ids) {
  const { rows } = await pool.query(`SELECT ${BILL_COLS}, bukku_txn_id FROM purchase_bukku_bills WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY bill_date, id`, [cid, ids]);
  return rows;
}
const idsOf = (b, max) => (Array.isArray(b && b.ids) ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max) : []);

// Show what would be sent (nothing is sent)
router.post(BASE + '/bills/bukku-preview', ...guard(2), async (req, res) => {
  const s = await enabledSettings(req, res);
  if (!s || !needMgr(req, res)) return;
  const ids = idsOf(req.body, 50);
  if (!ids.length) return bad(res, 'Invalid request');
  const ctx = await bukkuCtx(req.params.companyId, s.account);
  const pconn = await bukkuApi.loadConn(req.params.companyId);
  const popt = Object.assign({}, req.body || {}, { status: pconn && pconn.send_status === 'ready' ? 'ready' : 'draft' });
  const out = (await loadBillsForBukku(req.params.companyId, ids)).map((r) => {
    const built = buildBukkuBill(r, ctx, popt);
    const problems = built.problems.slice();
    if (r.bukku_txn_id) problems.unshift('这张单已经送进 Bukku（' + (r.bukku_txn_no || '') + '）。');
    else if (!r.approved_at) problems.unshift('这张单还没有 Approve。');
    return { id: String(r.id), no: r.no, supplier: r.supplier, total: Number(r.total), ok: problems.length === 0, problems, summary: built.summary };
  });
  res.json({ bills: out });
});

router.post(BASE + '/bills/send-bukku', ...guard(2), async (req, res) => {
  const s = await enabledSettings(req, res);
  if (!s || !needMgr(req, res)) return;
  const cid = req.params.companyId;
  const conn = await bukkuApi.loadConn(cid);
  if (!conn) return bad(res, '这家公司还没有连接 Bukku（Control Panel > Bukku API）。');
  if (!conn.send_enabled) return bad(res, 'Owner 还没有在 Control Panel 打开「把采购单送进 Bukku」。');
  const ids = idsOf(req.body, 20);
  if (!ids.length) return bad(res, 'Invalid request');
  const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM purchase_bukku_bills WHERE company_id = $1 AND bukku_txn_id IS NOT NULL', [cid]);
  if (cnt[0].n === 0 && ids.length > 1) return bad(res, '第一次只送 1 张，到 Bukku 里确认草稿没问题，再批量送。 Send just one bill the first time and check the draft in Bukku.');
  const ctx = await bukkuCtx(cid, s.account);
  const status = conn.send_status === 'ready' ? 'ready' : 'draft';
  const sopt = Object.assign({}, req.body || {}, { status });
  const results = [];
  for (const r of await loadBillsForBukku(cid, ids)) {
    const base = { id: String(r.id), no: r.no, supplier: r.supplier };
    if (r.bukku_txn_id) { results.push({ ...base, status: 'skipped', message: '已经送过（' + (r.bukku_txn_no || '') + '）。' }); continue; }
    if (!r.approved_at) { results.push({ ...base, status: 'skipped', message: '还没有 Approve。' }); continue; }
    const built = buildBukkuBill(r, ctx, sopt);
    if (built.problems.length) { results.push({ ...base, status: 'problem', message: built.problems.join(' ') }); continue; }
    try {
      const resp = await bukkuApi.post(conn, '/purchases/bills', built.payload);
      const tx = resp && resp.transaction;
      if (!tx || tx.id == null) throw new Error('Bukku 没有回传单据 id。');
      await pool.query(
        `UPDATE purchase_bukku_bills SET bukku_txn_id = $2, bukku_txn_no = $3, bukku_sent_at = now(), bukku_sent_by = $4, bukku_send_error = NULL, pay_mode = $5, bukku_sent_status = $6,
           in_bukku_at = COALESCE(in_bukku_at, now()), in_bukku_by = COALESCE(in_bukku_by, $4) WHERE id = $1`,
        [r.id, tx.id, String(tx.number || '').slice(0, 60), req.user.sub, built.summary.mode, status]
      );
      await logActivity(req.user.sub, 'Sent a purchase bill to Bukku (' + (status === 'ready' ? 'finished bill' : 'draft') + ')', s.name, (r.supplier + ' ' + (r.no || '') + ' -> ' + (tx.number || tx.id)).slice(0, 300));
      results.push({ ...base, status: 'sent', message: (status === 'ready' ? '已送进 Bukku（正式）' : '已送进 Bukku 草稿') + (tx.number ? '（' + tx.number + '）' : '') + '。' });
    } catch (e) {
      await pool.query('UPDATE purchase_bukku_bills SET bukku_send_error = $2 WHERE id = $1', [r.id, String(e.message).slice(0, 400)]);
      results.push({ ...base, status: 'error', message: e.message });
    }
  }
  res.json({ results });
});

// ---- bills ----
// what was read from a QC GROUP bill PDF (kept with the bill, for its Sales Invoice): only a plain object with a list of items, not too big
function cleanHq(h) {
  if (!h || typeof h !== 'object' || !Array.isArray(h.items) || !h.items.length || h.items.length > 300) return null;
  const s = JSON.stringify(h);
  return s.length > 200000 ? null : JSON.parse(s);
}
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
    const line = { desc, account: String((l && l.account) || '').trim().slice(0, 20), qty: Number.isFinite(qty) && qty > 0 ? qty : 1, price, tax: String((l && l.tax) || '').trim().toUpperCase().slice(0, 20) };
    // Stock Count link: the Stock Count item this line is, and what it was bought in (a carton, a pack...: `per` of them make 1 Stock Count unit)
    const item = String((l && l.item) || '').trim().slice(0, 80);
    const unit = String((l && l.unit) || '').trim().toUpperCase().slice(0, 20);
    const rawPer = Number(l && l.per);
    const as = String((l && l.as) || '').trim().toUpperCase().slice(0, 200);
    if (item) line.item = item;
    if (unit) { line.unit = unit; line.per = Number.isFinite(rawPer) && rawPer > 0 ? Math.round(rawPer * 10000) / 10000 : 1; }
    if (as && as !== desc) line.as = as;
    lines.push(line);
  }
  const total = Math.round(lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;
  return { supplier, no, date: b.date, lines, total, code: String(b.code || '').trim().toUpperCase().slice(0, 30), ref: String(b.ref || '').trim().slice(0, 60), tags: String(b.tags || '').trim().slice(0, 100), desc: String(b.desc || '').trim().slice(0, 200), dupAck: b.dupAck === true, hq: cleanHq(b.hq) };
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
  const problem = await staffSupplierProblem(req, b.supplier) || await stockIdsProblem(req.params.companyId, b.lines.map((l) => l.item));
  if (problem) return bad(res, problem);
  const { rows } = await pool.query(
    `INSERT INTO purchase_bukku_bills (company_id, supplier, code, no, ref, bill_date, tags, description, lines, total, dup_ack, created_by, updated_by, hq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12,$13::jsonb) RETURNING ${BILL_COLS}`,
    [req.params.companyId, b.supplier, b.code, b.no, b.ref, b.date, b.tags, b.desc, JSON.stringify(b.lines), b.total, b.dupAck, req.user.sub, b.hq ? JSON.stringify(b.hq) : null]
  );
  try { await learn(pool, req.params.companyId, b.supplier, b.date, b.lines, true); } catch (err) { console.error('purchase items learn failed:', err); }
  try { await docs.logEvent(req, req.params.companyId, 'purchase_bukku_bill', b.no, 'created', [{ field: 'supplier', from: '', to: b.supplier }, { field: 'total', from: '', to: String(b.total) }]); } catch (err) { console.error('purchase bill history failed:', err); }
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
  const problem = await staffSupplierProblem(req, b.supplier) || await stockIdsProblem(req.params.companyId, b.lines.map((l) => l.item));
  if (problem) return bad(res, problem);
  const shape = (x) => ({ supplier: x.supplier, no: x.no, date: x.date || x.bill_date, tags: x.tags, ref: x.ref, desc: x.description !== undefined ? x.description : x.desc, lines: x.lines.map((l) => l.desc + ' | ' + l.account + ' | ' + l.qty + ' x ' + l.price) });
  const changes = docs.diffObjects(shape(old[0]), shape(b));
  const reopen = old[0].status === 'exported' && changes.length > 0;   // the Bukku copy is out of date: export it again, marked as revised
  const { rows } = await pool.query(
    `UPDATE purchase_bukku_bills SET supplier = $3, code = $4, no = $5, ref = $6, bill_date = $7, tags = $8, description = $9, lines = $10::jsonb, total = $11,
       dup_ack = $12, updated_by = $13, updated_at = now(),
       status = CASE WHEN $14::boolean THEN 'draft' ELSE status END, exported_at = CASE WHEN $14::boolean THEN NULL ELSE exported_at END,
       revised = revised OR $14::boolean, revised_at = CASE WHEN $14::boolean THEN now() ELSE revised_at END, hq = COALESCE($15::jsonb, hq)
     WHERE id = $1 AND company_id = $2 RETURNING ${BILL_COLS}`,
    [id, req.params.companyId, b.supplier, b.code, b.no, b.ref, b.date, b.tags, b.desc, JSON.stringify(b.lines), b.total, b.dupAck, req.user.sub, reopen, b.hq ? JSON.stringify(b.hq) : null]
  );
  try { await learn(pool, req.params.companyId, b.supplier, b.date, b.lines, false); } catch (err) { console.error('purchase items learn failed:', err); }
  if (reopen) changes.push({ field: 'status', from: 'exported', to: 'not exported (revised: export to Bukku again)' });
  await docs.logUpdate(req, req.params.companyId, 'purchase_bukku_bill', old[0].no, changes);
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
  const already = rows.filter((b) => b.status === 'exported');
  if (already.length) return bad(res, '这些单据已经导出过了，不能再导出：' + already.slice(0, 5).map((b) => b.no).join('、') + (already.length > 5 ? '……' : '') + '。要重新导出，请 manager 先选中它们，按「改回未导出」。 Already exported: ' + already.slice(0, 5).map((b) => b.no).join(', ') + (already.length > 5 ? '...' : '') + '. To export them again, a manager must first select them and press "Back to not exported".');
  // claim them first (one statement, so two people exporting the same bill at the same time cannot both get it)
  const claimed = await pool.query(
    `UPDATE purchase_bukku_bills SET status = 'exported', exported_at = now(), updated_by = $3, updated_at = now()
      WHERE company_id = $1 AND id = ANY($2::int[]) AND status <> 'exported' RETURNING id`,
    [req.params.companyId, rows.map((b) => b.id), req.user.sub]
  );
  const release = (ids) => pool.query(`UPDATE purchase_bukku_bills SET status = 'draft', exported_at = NULL WHERE company_id = $1 AND id = ANY($2::int[])`, [req.params.companyId, ids]);
  if (claimed.rows.length !== rows.length) {
    await release(claimed.rows.map((r) => r.id));
    return bad(res, '有单据刚刚被别人导出了，请刷新后再试。 Some bills were just exported by someone else: refresh and try again.');
  }
  try {
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
        ...(i === 0 ? [code, b.supplier, b.no, b.ref || '', dmy(b.bill_date), '', '', '', '', b.tags || '', ((b.description || '') + (b.revised ? (b.description ? ' ' : '') + '[REVISED ' + dmy(new Date().toISOString().slice(0, 10)) + ']' : '')), ''] : Array(12).fill('')),
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
  try { await pool.query('UPDATE purchase_bukku_bills SET revised = false WHERE company_id = $1 AND id = ANY($2::int[])', [req.params.companyId, rows.map((b) => b.id)]); } catch (err) { console.error('purchase revised clear failed:', err); }
  try { await docs.logEvent(req, req.params.companyId, 'purchase_bukku', 'Bukku export', 'updated', [{ field: 'exported bills', from: '', to: rows.map((b) => b.no).join(', ').slice(0, 400) }]); } catch (err) { console.error('purchase export history failed:', err); }
  } catch (err) {   // the file could not be made: the bills go back to "not exported"
    await release(claimed.rows.map((r) => r.id)).catch(() => {});
    throw err;
  }
});

router.use((err, req, res, next) => {
  console.error('purchaseBukku route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
