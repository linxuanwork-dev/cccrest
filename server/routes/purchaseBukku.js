const express = require('express');
const ExcelJS = require('exceljs');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');
const { renderLetterheadHeader, renderTable, PDFDocument } = require('../lib/pdf');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Purchases -> Bukku import file. The fixed fields (account, item description) and the supplier / employee Contact Code list
// are set per company in the Control Panel (Owner); staff only enter number, date, quantity and unit price on the
// company's Purchases Bill page.

const TEMPLATES = {
  bill: path.join(__dirname, '..', 'assets', 'bukku', 'purchase-bill-template.xlsx'),
  claim: path.join(__dirname, '..', 'assets', 'bukku', 'purchase-expense-claim-template.xlsx')
};
// 1-based Excel columns of the Bukku templates' "Worksheet" tab
const COLS = {
  bill: { first: 31, code: 2, name: 3, no: 4, date: 6, account: 14, desc: 15, qty: 16, price: 19 },
  claim: { first: 33, empCode: 2, empName: 3, code: 4, name: 5, no: 6, date: 8, account: 16, desc: 17, qty: 18, price: 21 }
};
const bad = (res, msg) => res.status(400).json({ error: msg });

function numberOf(v) {
  const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

async function loadConfig(companyId) {
  const { rows } = await pool.query('SELECT enabled, account, item_description FROM purchase_bukku_settings WHERE company_id = $1', [companyId]);
  const s = rows[0] || { enabled: false, account: '6000', item_description: 'Purchases' };
  const { rows: contacts } = await pool.query('SELECT name, code FROM purchase_bukku_contacts WHERE company_id = $1 ORDER BY name', [companyId]);
  return { enabled: s.enabled, account: s.account, itemDescription: s.item_description, contacts };
}

// ============ CONTROL PANEL (Owner) ============

router.get('/purchase-bukku/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, COALESCE(s.enabled, false) AS enabled,
       (SELECT COUNT(*) FROM purchase_bukku_contacts k WHERE k.company_id = c.id)::int AS contact_count
     FROM companies c LEFT JOIN purchase_bukku_settings s ON s.company_id = c.id
     ORDER BY COALESCE(s.enabled, false) DESC, c.name`
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, contactCount: r.contact_count })));
});

router.get('/purchase-bukku/companies/:id', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(Object.assign({ id: rows[0].id, name: rows[0].name }, await loadConfig(rows[0].id)));
});

router.put('/purchase-bukku/companies/:id', requireRole('admin'), async (req, res) => {
  const { rows: co } = await pool.query('SELECT id, name FROM companies WHERE id = $1', [req.params.id]);
  if (!co[0]) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const account = String(b.account == null ? '' : b.account).trim();
  const desc = String(b.itemDescription == null ? '' : b.itemDescription).trim();
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(account)) return bad(res, 'Account 需为 1–20 个字符（字母、数字、. _ -）。 Account must be 1–20 characters.');
  if (!desc || desc.length > 100) return bad(res, 'Item Description 不能为空（最多 100 个字符）。 Item Description is required (max 100 characters).');
  if (!Array.isArray(b.contacts) || b.contacts.length > 2000) return bad(res, 'contacts must be a list (max 2000).');

  const seen = new Set(), contacts = [];
  for (const c of b.contacts) {
    const name = String((c && c.name) || '').trim().replace(/\s+/g, ' ');
    const code = String((c && c.code) || '').trim();
    if (!name && !code) continue;
    if (!name || !code) return bad(res, '每一行都要有名称和 Contact Code。 Every row needs a name and a Contact Code.');
    if (name.length > 150 || code.length > 30 || /\s/.test(code)) return bad(res, 'Contact Code 不能有空格（最多 30 个字符）：' + code);
    const key = name.toUpperCase();
    if (seen.has(key)) return bad(res, '名称重复 Duplicate name: ' + name);
    seen.add(key);
    contacts.push({ name, code });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO purchase_bukku_settings (company_id, enabled, account, item_description, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (company_id) DO UPDATE SET enabled = $2, account = $3, item_description = $4, updated_at = now()`,
      [co[0].id, b.enabled === true, account, desc]
    );
    await client.query('DELETE FROM purchase_bukku_contacts WHERE company_id = $1', [co[0].id]);
    for (const c of contacts) {
      await client.query('INSERT INTO purchase_bukku_contacts (company_id, name, code) VALUES ($1,$2,$3)', [co[0].id, c.name, c.code]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await logActivity(req.user.sub, 'Updated Purchases → Bukku settings', co[0].name,
    (b.enabled === true ? 'on' : 'off') + '; account ' + account + '; ' + contacts.length + ' contact(s)');
  res.json(Object.assign({ id: co[0].id, name: co[0].name }, await loadConfig(co[0].id)));
});

// ============ COMPANY SIDE: saved bills ============
// Bills are kept in the system (purchase_bukku_entries): staff key them in, can change or delete them later, filter by
// month, and download the Bukku file / PDF list for the ticked bills (or for the whole month when none is ticked).

const REAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const toDmy = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

async function requireEnabled(req, res) {
  const cfg = await loadConfig(req.params.companyId);
  if (!cfg.enabled) { bad(res, '这家公司还没有开通这个功能。 This feature is not switched on for this company.'); return null; }
  return cfg;
}

// -> { error } or the cleaned entry
function validateEntry(body, cfg) {
  const b = body || {};
  const type = b.type === 'claim' ? 'claim' : 'bill';
  const no = String(b.no == null ? '' : b.no).trim();
  if (!no) return { error: 'No.（账单号码）必填。 The bill number is required.' };
  if (/[\s,]/.test(no)) return { error: 'No. 不能有空格或逗号：' + no + ' — it cannot contain a space or comma.' };
  if (no.length > 40) return { error: 'No. 太长 too long.' };
  const date = String(b.date || '').trim();
  const dm = REAL_DATE_RE.exec(date);
  const real = dm && new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]));
  if (!dm || real.getUTCFullYear() !== +dm[1] || real.getUTCMonth() !== +dm[2] - 1 || real.getUTCDate() !== +dm[3]) return { error: '请选一个有效的日期。 Pick a valid date.' };
  const byCode = new Map(cfg.contacts.map((c) => [c.code, c]));
  const contact = byCode.get(String(b.contactCode || ''));
  if (!contact) return { error: '供应商不在名单里（请 Owner 在 Control Panel 加入）。 The supplier is not in the contact list.' };
  let emp = null;
  if (type === 'claim') {
    emp = byCode.get(String(b.employeeCode || ''));
    if (!emp) return { error: 'Expense Claim 需要选员工。 Pick the employee for an expense claim.' };
  }
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) return { error: '请至少填一个项目行。 Add at least one line.' };
  const lines = [];
  for (const l of b.lines) {
    const qty = numberOf(l && l.quantity), price = numberOf(l && l.unitPrice);
    if (!(qty > 0)) return { error: 'Quantity 要大于 0。 Quantity must be more than 0.' };
    if (!(price >= 0)) return { error: 'Unit Price 不对。 Unit Price is not valid.' };
    lines.push({ quantity: qty, unitPrice: price });
  }
  return { type, no, date, contact, emp, lines };
}

const ENTRY_COLS = `id, entry_type, contact_code, contact_name, employee_code, employee_name, bill_no, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, lines, updated_at`;
const lineTotal = (lines) => Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
function publicEntry(r) {
  return {
    id: r.id, type: r.entry_type, contactCode: r.contact_code, contactName: r.contact_name, employeeCode: r.employee_code, employeeName: r.employee_name,
    no: r.bill_no, date: r.bill_date, lines: r.lines, amount: lineTotal(r.lines), updatedAt: r.updated_at
  };
}
const diffShape = (e) => ({ type: e.type, supplier: e.contact.name, employee: e.emp ? e.emp.name : '', no: e.no, date: e.date, lines: e.lines.map((l) => l.quantity + ' x ' + l.unitPrice) });
const dbShape = (r) => ({ type: r.entry_type, supplier: r.contact_name, employee: r.employee_name || '', no: r.bill_no, date: r.bill_date, lines: r.lines.map((l) => l.quantity + ' x ' + l.unitPrice) });

// ids (comma list) wins; otherwise the month (YYYY-MM); otherwise everything of the company
async function selectEntries(companyId, ids, month) {
  const params = [companyId];
  let where = 'company_id = $1';
  const idList = (Array.isArray(ids) ? ids : String(ids || '').split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000);
  if (idList.length) { params.push(idList); where += ' AND id = ANY($' + params.length + '::int[])'; }
  else if (/^\d{4}-\d{2}$/.test(String(month || ''))) { params.push(month + '-01'); where += " AND bill_date >= $" + params.length + "::date AND bill_date < ($" + params.length + "::date + interval '1 month')"; }
  const { rows } = await pool.query(`SELECT ${ENTRY_COLS} FROM purchase_bukku_entries WHERE ${where} ORDER BY bill_date, id`, params);
  return rows;
}

router.get('/companies/:companyId/purchase-bukku', requireAuth, scopeToCompany, requirePage('purchases', 1), async (req, res) => {
  const cfg = await loadConfig(req.params.companyId);
  // clients/staff only learn whether it is on; the full list is only needed when it is
  res.json(cfg.enabled ? cfg : { enabled: false });
});

router.get('/companies/:companyId/purchase-bukku/entries', requireAuth, scopeToCompany, requirePage('purchases', 1), async (req, res) => {
  const cfg = await requireEnabled(req, res); if (!cfg) return;
  const { rows: months } = await pool.query("SELECT DISTINCT to_char(bill_date, 'YYYY-MM') AS m FROM purchase_bukku_entries WHERE company_id = $1 ORDER BY m DESC", [req.params.companyId]);
  const rows = await selectEntries(req.params.companyId, null, req.query.month);
  res.json({ months: months.map((r) => r.m), entries: rows.map(publicEntry) });
});

router.post('/companies/:companyId/purchase-bukku/entries', requireAuth, scopeToCompany, requirePage('purchases', 2), async (req, res) => {
  const cfg = await requireEnabled(req, res); if (!cfg) return;
  const e = validateEntry(req.body, cfg);
  if (e.error) return bad(res, e.error);
  try {
    const { rows } = await pool.query(
      `INSERT INTO purchase_bukku_entries (company_id, entry_type, contact_code, contact_name, employee_code, employee_name, bill_no, bill_date, lines, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10) RETURNING ${ENTRY_COLS}`,
      [req.params.companyId, e.type, e.contact.code, e.contact.name, e.emp ? e.emp.code : null, e.emp ? e.emp.name : null, e.no, e.date, JSON.stringify(e.lines), req.user.sub]
    );
    await docs.logEvent(req, req.params.companyId, 'purchase_bukku_entry', e.no, 'created', diffDetails(null, diffShape(e)));
    res.status(201).json(publicEntry(rows[0]));
  } catch (err) {
    if (err.code === '23505') return bad(res, '这个供应商已经有同样号码的账单：' + e.no + ' — that bill number already exists for this supplier.');
    throw err;
  }
});
const diffDetails = (before, after) => docs.diffObjects(before, after);

router.put('/companies/:companyId/purchase-bukku/entries/:entryId', requireAuth, scopeToCompany, requirePage('purchases', 3), async (req, res) => {
  const cfg = await requireEnabled(req, res); if (!cfg) return;
  const { rows: old } = await pool.query(`SELECT ${ENTRY_COLS} FROM purchase_bukku_entries WHERE id = $1 AND company_id = $2`, [req.params.entryId, req.params.companyId]);
  if (!old[0]) return res.status(404).json({ error: 'Not found' });
  const e = validateEntry(req.body, cfg);
  if (e.error) return bad(res, e.error);
  try {
    const { rows } = await pool.query(
      `UPDATE purchase_bukku_entries SET entry_type = $3, contact_code = $4, contact_name = $5, employee_code = $6, employee_name = $7, bill_no = $8, bill_date = $9,
         lines = $10::jsonb, updated_by = $11, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING ${ENTRY_COLS}`,
      [req.params.entryId, req.params.companyId, e.type, e.contact.code, e.contact.name, e.emp ? e.emp.code : null, e.emp ? e.emp.name : null, e.no, e.date, JSON.stringify(e.lines), req.user.sub]
    );
    await docs.logUpdate(req, req.params.companyId, 'purchase_bukku_entry', old[0].bill_no, diffDetails(dbShape(old[0]), diffShape(e)));
    res.json(publicEntry(rows[0]));
  } catch (err) {
    if (err.code === '23505') return bad(res, '这个供应商已经有同样号码的账单：' + e.no + ' — that bill number already exists for this supplier.');
    throw err;
  }
});

router.delete('/companies/:companyId/purchase-bukku/entries/:entryId', requireAuth, scopeToCompany, requirePage('purchases', 3), async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM purchase_bukku_entries WHERE id = $1 AND company_id = $2 RETURNING ${ENTRY_COLS}`, [req.params.entryId, req.params.companyId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await docs.logEvent(req, req.params.companyId, 'purchase_bukku_entry', rows[0].bill_no, 'deleted', diffDetails(dbShape(rows[0]), null));
  res.json({ ok: true });
});

// Bukku import file of the ticked bills (body.ids) or of a month (body.month); all of one kind: Purchase Bill or Expense Claim
router.post('/companies/:companyId/purchase-bukku/export', requireAuth, scopeToCompany, requirePage('purchases', 1), async (req, res) => {
  const companyId = req.params.companyId;
  const cfg = await requireEnabled(req, res); if (!cfg) return;
  const body = req.body || {};
  const rows = await selectEntries(companyId, body.ids, body.month);
  if (!rows.length) return bad(res, '没有可以导出的账单。 There are no bills to export.');
  if (rows.length > 300) return bad(res, 'Too many bills in one file (max 300) — pick a month or tick fewer bills.');
  const types = Array.from(new Set(rows.map((r) => r.entry_type)));
  if (types.length > 1) return bad(res, '选中的账单有 Purchase Bill 和 Expense Claim 两种，Bukku 要分开导入，请分开导出。 The selection mixes Purchase Bills and Expense Claims — export them separately.');
  const type = types[0];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATES[type]);
  const ws = wb.getWorksheet('Worksheet') || wb.worksheets[0];
  const C = COLS[type];
  for (let r = C.first; r <= ws.rowCount; r++) ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => { cell.value = null; });
  let r = C.first;
  for (const e of rows) {
    e.lines.forEach((l, idx) => {
      const row = ws.getRow(r);
      if (idx === 0) {
        if (type === 'claim') { row.getCell(C.empCode).value = e.employee_code; row.getCell(C.empName).value = e.employee_name; }
        row.getCell(C.code).value = e.contact_code;
        row.getCell(C.name).value = e.contact_name;
        row.getCell(C.no).value = e.bill_no;
        row.getCell(C.date).value = toDmy(e.bill_date);
      }
      row.getCell(C.account).value = cfg.account;
      row.getCell(C.desc).value = cfg.itemDescription;
      row.getCell(C.qty).value = l.quantity;
      row.getCell(C.price).value = l.unitPrice;
      row.commit();
      r++;
    });
  }

  const first = rows[0].bill_date;     // file name month = month of the first bill
  const info = await docs.companyInfo(companyId);
  const fallback = info.PREFIX + (type === 'claim' ? '-BUKKU-CLAIMS RECORD-' : '-BUKKU-PURCHASES RECORD-') + first.slice(2, 4) + '_' + first.slice(5, 7);
  const base = await docs.fileBase('purchase_bukku', companyId, { YY: first.slice(2, 4), MM: first.slice(5, 7), YYYY: first.slice(0, 4) }, fallback);
  const filename = base + '.xlsx';
  docs.stampWorkbook(wb, docs.stampText(await docs.userNameFor(req)));
  await docs.logEvent(req, companyId, 'purchase_bukku', filename, 'generated', [{ field: 'bills', from: '', to: String(rows.length) }]);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('X-File-Name', encodeURIComponent(filename));
  await wb.xlsx.write(res);
  res.end();
});

// PDF list of the ticked bills (?ids=1,2) or of a month (?month=2026-08), on the company letterhead
router.get('/companies/:companyId/purchase-bukku/entries.pdf', requireAuth, scopeToCompany, requirePage('purchases', 1), async (req, res) => {
  const companyId = req.params.companyId;
  const cfg = await requireEnabled(req, res); if (!cfg) return;
  const rows = (await selectEntries(companyId, req.query.ids, req.query.month)).map(publicEntry);
  const { rows: co } = await pool.query('SELECT name, registration_no, address, letterhead_data_url FROM companies WHERE id = $1', [companyId]);
  if (!co[0]) return res.status(404).json({ error: 'Company not found' });

  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  const base = await docs.fileBase('company_report', companyId, { TITLE: 'PURCHASES-BILL' }, 'Purchases-Bill');
  await docs.logEvent(req, companyId, 'company_report', base + '.pdf', 'downloaded', []);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + base.replace(/"/g, '') + '.pdf"');
  doc.pipe(res);
  const period = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) && !req.query.ids ? req.query.month : '';
  renderLetterheadHeader(doc, co[0], 'Purchases Bill', period);
  renderTable(doc, [
    { key: 'no', label: 'Invoice No.', width: 1.1 },
    { key: 'supplier', label: 'Supplier', width: 1.8 },
    { key: 'type', label: 'Type', width: 0.8 },
    { key: 'date', label: 'Date', width: 0.9 },
    { key: 'amount', label: 'Amount', width: 1, align: 'right' }
  ], rows.map((e) => ({ no: e.no, supplier: e.contactName + (e.employeeName ? ' / ' + e.employeeName : ''), type: e.type === 'claim' ? 'Claim' : 'Bill', date: toDmy(e.date), amount: 'RM ' + e.amount.toFixed(2) })));
  docs.stampPdfkitPages(doc, docs.stampText(await docs.userNameFor(req)));
  doc.end();
});

router.use((err, req, res, next) => {
  console.error('purchaseBukku route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
