const express = require('express');
const ExcelJS = require('exceljs');
const path = require('path');
const { pool } = require('../db');
const { requireRole, requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const { logActivity } = require('../lib/activity');
const docs = require('../lib/docs');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'put'].forEach((method) => {
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
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
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

// ============ COMPANY SIDE ============

router.get('/companies/:companyId/purchase-bukku', requireAuth, scopeToCompany, requirePage('purchases', 1), async (req, res) => {
  const cfg = await loadConfig(req.params.companyId);
  // clients/staff only learn whether it is on; the full list is only needed when it is
  res.json(cfg.enabled ? cfg : { enabled: false });
});

router.post('/companies/:companyId/purchase-bukku/export', requireAuth, scopeToCompany, requirePage('purchases', 2), async (req, res) => {
  const companyId = req.params.companyId;
  const cfg = await loadConfig(companyId);
  if (!cfg.enabled) return bad(res, '这家公司还没有开通这个功能。 This feature is not switched on for this company.');
  const body = req.body || {};
  const type = body.type === 'claim' ? 'claim' : 'bill';
  const bills = body.bills;
  if (!Array.isArray(bills) || !bills.length) return bad(res, '请至少填一张账单。 Add at least one bill.');
  if (bills.length > 300) return bad(res, 'Too many bills in one file (max 300).');

  const byCode = new Map(cfg.contacts.map((c) => [c.code, c]));
  const clean = [];
  let lineCount = 0;
  for (let i = 0; i < bills.length; i++) {
    const b = bills[i] || {}, tag = '第 ' + (i + 1) + ' 张（Bill ' + (i + 1) + '）：';
    const no = String(b.no == null ? '' : b.no).trim();
    if (!no) return bad(res, tag + 'No.（账单号码）必填。 The bill number is required.');
    if (/[\s,]/.test(no)) return bad(res, tag + 'No. 不能有空格或逗号：' + no + ' — it cannot contain a space or comma.');
    if (no.length > 40) return bad(res, tag + 'No. 太长 too long.');
    const date = String(b.date || '').trim();
    const dm = DATE_RE.exec(date);
    if (!dm || +dm[2] < 1 || +dm[2] > 12 || +dm[1] < 1 || +dm[1] > 31) return bad(res, tag + 'Date 要是 DD/MM/YYYY。 Date must be DD/MM/YYYY.');
    const contact = byCode.get(String(b.contactCode || ''));
    if (!contact) return bad(res, tag + '供应商不在名单里（请 Owner 在 Control Panel 加入）。 The supplier is not in the contact list.');
    let emp = null;
    if (type === 'claim') {
      emp = byCode.get(String(b.employeeCode || ''));
      if (!emp) return bad(res, tag + 'Expense Claim 需要选员工。 Pick the employee for an expense claim.');
    }
    if (!Array.isArray(b.lines) || !b.lines.length) return bad(res, tag + '没有项目行。 No lines.');
    const lines = [];
    for (const l of b.lines) {
      const qty = numberOf(l && l.quantity), price = numberOf(l && l.unitPrice);
      if (!(qty > 0)) return bad(res, tag + 'Quantity 要大于 0。 Quantity must be more than 0.');
      if (!(price >= 0)) return bad(res, tag + 'Unit Price 不对。 Unit Price is not valid.');
      lines.push({ qty, price });
    }
    lineCount += lines.length;
    clean.push({ contact, emp, no, date, lines });
  }
  if (lineCount > 2000) return bad(res, 'Too many lines in one file (max 2000).');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATES[type]);
  const ws = wb.getWorksheet('Worksheet') || wb.worksheets[0];
  const C = COLS[type];
  for (let r = C.first; r <= ws.rowCount; r++) ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => { cell.value = null; });
  let r = C.first;
  for (const b of clean) {
    b.lines.forEach((l, idx) => {
      const row = ws.getRow(r);
      if (idx === 0) {
        if (type === 'claim') { row.getCell(C.empCode).value = b.emp.code; row.getCell(C.empName).value = b.emp.name; }
        row.getCell(C.code).value = b.contact.code;
        row.getCell(C.name).value = b.contact.name;
        row.getCell(C.no).value = b.no;
        row.getCell(C.date).value = b.date;
      }
      row.getCell(C.account).value = cfg.account;
      row.getCell(C.desc).value = cfg.itemDescription;
      row.getCell(C.qty).value = l.qty;
      row.getCell(C.price).value = l.price;
      row.commit();
      r++;
    });
  }

  const first = DATE_RE.exec(clean[0].date);
  const info = await docs.companyInfo(companyId);
  const fallback = info.PREFIX + (type === 'claim' ? '-BUKKU-CLAIMS RECORD-' : '-BUKKU-PURCHASES RECORD-') + first[3].slice(2) + '_' + first[2];
  const base = await docs.fileBase('purchase_bukku', companyId, { YY: first[3].slice(2), MM: first[2], YYYY: first[3] }, fallback);
  const filename = base + '.xlsx';
  docs.stampWorkbook(wb, docs.stampText(await docs.userNameFor(req)));
  await docs.logEvent(req, companyId, 'purchase_bukku', filename, 'generated', [{ field: 'bills', from: '', to: String(clean.length) }]);

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
