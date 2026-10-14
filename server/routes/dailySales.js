const express = require('express');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { logActivity } = require('../lib/activity');
const rules = require('../lib/dailySalesRules');
const { buildInvoiceWorkbook } = require('../lib/dailySalesExcel');
const { buildReportPdf } = require('../lib/dailySalesPdf');

const router = express.Router();
const BASE = '/companies/:companyId/dsi';

// Express 4 doesn't forward rejected promises from async handlers; wrap them so a
// failure becomes a JSON 500 (see the error handler at the bottom) instead of a hung request.
['get', 'post', 'put', 'patch', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});
const MANAGER_ONLY_MSG = '此项目只有 Manager 可以修改';

function canEditConfig(req) {
  return req.user.role === 'admin' || req.user.role === 'manager';
}

function requireConfigEditor(req, res, next) {
  if (!canEditConfig(req)) return res.status(403).json({ error: MANAGER_ONLY_MSG });
  next();
}

async function getBranch(companyId, branchId) {
  const { rows } = await pool.query('SELECT * FROM dsi_branches WHERE id = $1 AND company_id = $2', [branchId, companyId]);
  return rows[0] || null;
}

async function getMenu(branchId) {
  const { rows } = await pool.query(
    'SELECT id, product, unit_price::float AS unit_price, sort_order FROM dsi_menu_items WHERE branch_id = $1 ORDER BY sort_order, id',
    [branchId]
  );
  return rows;
}

function monthRange(year, month) {
  const start = `${year}-${rules.pad2(month)}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  return { start, end: `${ny}-${rules.pad2(nm)}-01` };
}

async function getMonthData(branchId, year, month) {
  const { start, end } = monthRange(year, month);
  const qtyRes = await pool.query(
    `SELECT q.item_id, EXTRACT(DAY FROM q.entry_date)::int AS day, q.qty
     FROM dsi_quantities q JOIN dsi_menu_items i ON i.id = q.item_id
     WHERE i.branch_id = $1 AND q.entry_date >= $2 AND q.entry_date < $3`,
    [branchId, start, end]
  );
  const spRes = await pool.query(
    `SELECT s.item_id, EXTRACT(DAY FROM s.entry_date)::int AS day, s.price::float AS price
     FROM dsi_specials s JOIN dsi_menu_items i ON i.id = s.item_id
     WHERE i.branch_id = $1 AND s.entry_date >= $2 AND s.entry_date < $3`,
    [branchId, start, end]
  );
  const qtyMap = {};
  qtyRes.rows.forEach((r) => { qtyMap[`${r.day}:${r.item_id}`] = r.qty; });
  const specialMap = {};
  spRes.rows.forEach((r) => { specialMap[`${r.day}:${r.item_id}`] = r.price; });
  return { qtyMap, specialMap };
}

function publicBranch(b, menu) {
  return {
    id: b.id, code: b.code, reportPrefix: b.report_prefix, companyName: b.company_name,
    regNo: b.reg_no, address: b.address, contactCode: b.contact_code, legalName: b.legal_name,
    invoicePrefix: b.invoice_prefix, invoiceSuffix: b.invoice_suffix, paymentTerm: b.payment_term,
    tags: b.tags, accountCode: b.account_code, includeZero: b.include_zero,
    menu: menu.map((m) => ({ id: m.id, product: m.product, unitPrice: m.unit_price }))
  };
}

function parseYearMonth(src) {
  const year = Number(src.year);
  const month = Number(src.month);
  return rules.validYearMonth(year, month) ? { year, month } : null;
}

function cleanText(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 300);
}

// Validates + normalises a menu array from the client: [{ id?, product, unitPrice }]
function parseMenuInput(menu) {
  if (!Array.isArray(menu) || menu.length === 0) return { error: '菜单至少要有一个项目。' };
  const seen = new Set();
  const items = [];
  for (let i = 0; i < menu.length; i++) {
    const product = cleanText(menu[i].product, 200);
    const price = Number(menu[i].unitPrice);
    if (!product) return { error: `菜单第 ${i + 1} 项没有名字。` };
    if (seen.has(product.toLowerCase())) return { error: `菜单名字重复：${product}` };
    seen.add(product.toLowerCase());
    if (menu[i].unitPrice === '' || menu[i].unitPrice == null || isNaN(price) || price < 0) return { error: `「${product}」的单价无效。` };
    items.push({ id: menu[i].id ? Number(menu[i].id) : null, product, unitPrice: Math.round(price * 100) / 100 });
  }
  return { items };
}

// ============ BRANCHES ============

router.get(`${BASE}/branches`, requireAuth, scopeToCompany, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM dsi_branches WHERE company_id = $1 ORDER BY sort_order, id', [req.params.companyId]);
  const out = [];
  for (const b of rows) out.push(publicBranch(b, await getMenu(b.id)));
  res.json(out);
});

router.post(`${BASE}/branches`, requireAuth, scopeToCompany, requireConfigEditor, async (req, res) => {
  const body = req.body || {};
  const code = cleanText(body.code, 10).toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(code)) return res.status(400).json({ error: '分店代号只能是英文字母或数字（最多 6 个）。' });
  const reportPrefix = cleanText(body.reportPrefix, 30).toUpperCase();
  if (!reportPrefix) return res.status(400).json({ error: '请填写报告前缀。' });
  const companyName = cleanText(body.companyName, 200);
  if (!companyName) return res.status(400).json({ error: '请填写公司名。' });
  const parsed = parseMenuInput(body.menu);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const dup = await pool.query('SELECT 1 FROM dsi_branches WHERE company_id = $1 AND code = $2', [req.params.companyId, code]);
  if (dup.rows[0]) return res.status(409).json({ error: `分店代号 ${code} 已经存在。` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orderRows } = await client.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dsi_branches WHERE company_id = $1', [req.params.companyId]);
    const { rows } = await client.query(
      `INSERT INTO dsi_branches (company_id, code, report_prefix, company_name, reg_no, address, contact_code, legal_name,
         invoice_prefix, invoice_suffix, payment_term, tags, account_code, include_zero, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.params.companyId, code, reportPrefix, companyName, cleanText(body.regNo, 100), cleanText(body.address, 300),
        cleanText(body.contactCode, 50) || 'C-C0001', cleanText(body.legalName, 100) || 'Cash Sales',
        cleanText(body.invoicePrefix, 30) || `${code}-INV-`, cleanText(body.invoiceSuffix, 10) || '-01',
        cleanText(body.paymentTerm, 30) || 'NET30', cleanText(body.tags, 100), cleanText(body.accountCode, 30) || '5000',
        !!body.includeZero, orderRows[0].n]
    );
    for (let i = 0; i < parsed.items.length; i++) {
      await client.query('INSERT INTO dsi_menu_items (branch_id, sort_order, product, unit_price) VALUES ($1,$2,$3,$4)',
        [rows[0].id, i + 1, parsed.items[i].product, parsed.items[i].unitPrice]);
    }
    await client.query('COMMIT');
    const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
    await logActivity(req.user.sub, 'Added daily-sales branch', co[0].name, `${reportPrefix} (${code})`);
    res.status(201).json(publicBranch(rows[0], await getMenu(rows[0].id)));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.patch(`${BASE}/branches/:branchId`, requireAuth, scopeToCompany, requireConfigEditor, async (req, res) => {
  const b = await getBranch(req.params.companyId, req.params.branchId);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const pick = (key, max, current) => (typeof body[key] === 'string' ? cleanText(body[key], max) : current);

  const next = {
    report_prefix: pick('reportPrefix', 30, b.report_prefix).toUpperCase(),
    company_name: pick('companyName', 200, b.company_name),
    reg_no: pick('regNo', 100, b.reg_no),
    address: pick('address', 300, b.address),
    contact_code: pick('contactCode', 50, b.contact_code),
    legal_name: pick('legalName', 100, b.legal_name),
    invoice_prefix: pick('invoicePrefix', 30, b.invoice_prefix),
    invoice_suffix: pick('invoiceSuffix', 10, b.invoice_suffix),
    payment_term: pick('paymentTerm', 30, b.payment_term),
    tags: pick('tags', 100, b.tags),
    account_code: pick('accountCode', 30, b.account_code),
    include_zero: typeof body.includeZero === 'boolean' ? body.includeZero : b.include_zero
  };
  if (!next.report_prefix) return res.status(400).json({ error: '请填写报告前缀。' });
  if (!next.company_name) return res.status(400).json({ error: '请填写公司名。' });
  if (!next.account_code) return res.status(400).json({ error: 'Account Code 不可空白。' });
  if (!next.contact_code && !next.legal_name) return res.status(400).json({ error: 'Contact Code 和 Legal Name 至少要填一个。' });

  const { rows } = await pool.query(
    `UPDATE dsi_branches SET report_prefix=$1, company_name=$2, reg_no=$3, address=$4, contact_code=$5, legal_name=$6,
       invoice_prefix=$7, invoice_suffix=$8, payment_term=$9, tags=$10, account_code=$11, include_zero=$12
     WHERE id=$13 RETURNING *`,
    [next.report_prefix, next.company_name, next.reg_no, next.address, next.contact_code, next.legal_name, next.invoice_prefix,
      next.invoice_suffix, next.payment_term, next.tags, next.account_code, next.include_zero, b.id]
  );
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Updated daily-sales settings', co[0].name, rows[0].report_prefix);
  res.json(publicBranch(rows[0], await getMenu(b.id)));
});

// Replace the whole menu. Items with an id are updated in place (keeping their saved quantities);
// ids not present in the request are deleted, along with their quantities/specials.
router.put(`${BASE}/branches/:branchId/menu`, requireAuth, scopeToCompany, requireConfigEditor, async (req, res) => {
  const b = await getBranch(req.params.companyId, req.params.branchId);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const parsed = parseMenuInput((req.body || {}).menu);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const existing = await getMenu(b.id);
  const existingIds = new Set(existing.map((m) => m.id));
  for (const it of parsed.items) {
    if (it.id && !existingIds.has(it.id)) return res.status(400).json({ error: '菜单资料已过期，请重新载入后再修改。' });
  }
  const keepIds = new Set(parsed.items.filter((i) => i.id).map((i) => i.id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of existing) {
      if (!keepIds.has(m.id)) await client.query('DELETE FROM dsi_menu_items WHERE id = $1', [m.id]);
    }
    for (let i = 0; i < parsed.items.length; i++) {
      const it = parsed.items[i];
      if (it.id) {
        await client.query('UPDATE dsi_menu_items SET sort_order=$1, product=$2, unit_price=$3 WHERE id=$4', [i + 1, it.product, it.unitPrice, it.id]);
      } else {
        await client.query('INSERT INTO dsi_menu_items (branch_id, sort_order, product, unit_price) VALUES ($1,$2,$3,$4)', [b.id, i + 1, it.product, it.unitPrice]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Updated daily-sales menu', co[0].name, b.report_prefix);
  res.json(publicBranch(b, await getMenu(b.id)));
});

// ============ MONTH DATA (quantities + specials) ============

router.get(`${BASE}/branches/:branchId/month`, requireAuth, scopeToCompany, async (req, res) => {
  const b = await getBranch(req.params.companyId, req.params.branchId);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const ym = parseYearMonth(req.query);
  if (!ym) return res.status(400).json({ error: '请先选择有效的年份和月份。' });
  const { qtyMap, specialMap } = await getMonthData(b.id, ym.year, ym.month);
  res.json({ year: ym.year, month: ym.month, qty: qtyMap, specials: specialMap });
});

async function saveCells(req, res, kind) {
  const b = await getBranch(req.params.companyId, req.params.branchId);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const ym = parseYearMonth(body);
  if (!ym) return res.status(400).json({ error: '请先选择有效的年份和月份。' });
  const cells = Array.isArray(body.cells) ? body.cells : [];
  if (cells.length > 5000) return res.status(400).json({ error: 'Too many cells in one request.' });

  const menu = await getMenu(b.id);
  const itemIds = new Set(menu.map((m) => m.id));
  const lastDay = rules.daysInMonth(ym.year, ym.month);
  const ops = [];

  for (const c of cells) {
    const day = Number(c.day);
    const itemId = Number(c.itemId);
    if (!Number.isInteger(day) || day < 1 || day > lastDay) return res.status(400).json({ error: `日期无效：${c.day}` });
    if (!itemIds.has(itemId)) return res.status(400).json({ error: '菜单项目无效。' });
    const date = `${ym.year}-${rules.pad2(ym.month)}-${rules.pad2(day)}`;
    const raw = kind === 'qty' ? c.qty : c.price;
    if (raw === '' || raw == null) { ops.push({ date, itemId, value: null }); continue; }
    const num = Number(raw);
    if (kind === 'qty') {
      if (!Number.isInteger(num) || num < 0) return res.status(400).json({ error: '数量只能是 0 或正整数。' });
      ops.push({ date, itemId, value: num === 0 ? null : num });
    } else {
      if (isNaN(num) || num < 0) return res.status(400).json({ error: '特价必须是 ≥ 0 的数字。' });
      ops.push({ date, itemId, value: Math.round(num * 100) / 100 });
    }
  }

  const table = kind === 'qty' ? 'dsi_quantities' : 'dsi_specials';
  const col = kind === 'qty' ? 'qty' : 'price';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const op of ops) {
      if (op.value == null) {
        await client.query(`DELETE FROM ${table} WHERE item_id = $1 AND entry_date = $2`, [op.itemId, op.date]);
      } else {
        await client.query(
          `INSERT INTO ${table} (item_id, entry_date, ${col}) VALUES ($1,$2,$3)
           ON CONFLICT (item_id, entry_date) DO UPDATE SET ${col} = EXCLUDED.${col}`,
          [op.itemId, op.date, op.value]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ saved: ops.length });
}

router.put(`${BASE}/branches/:branchId/quantities`, requireAuth, scopeToCompany, (req, res) => saveCells(req, res, 'qty'));
router.put(`${BASE}/branches/:branchId/specials`, requireAuth, scopeToCompany, requireConfigEditor, (req, res) => saveCells(req, res, 'price'));

// ============ CHECK + REPORTS ============

async function prepareReport(req, res, source) {
  const b = await getBranch(req.params.companyId, req.params.branchId);
  if (!b) { res.status(404).json({ error: 'Not found' }); return null; }
  const ym = parseYearMonth(source);
  if (!ym) { res.status(400).json({ error: '请先选择有效的年份和月份。' }); return null; }
  const menu = await getMenu(b.id);
  const { qtyMap, specialMap } = await getMonthData(b.id, ym.year, ym.month);
  const built = rules.buildMonth(b, menu, qtyMap, specialMap, ym.year, ym.month);
  const errors = rules.runChecks(b, menu, built, ym.year, ym.month);
  return { branch: b, menu, built, errors, ...ym };
}

router.post(`${BASE}/branches/:branchId/check`, requireAuth, scopeToCompany, async (req, res) => {
  const ctx = await prepareReport(req, res, req.body || {});
  if (!ctx) return;
  res.json({
    ok: ctx.errors.length === 0,
    errors: ctx.errors,
    summary: { invoiceDays: ctx.built.invoices.length, totalCents: ctx.built.monthTotalCents }
  });
});

router.get(`${BASE}/branches/:branchId/report.xlsx`, requireAuth, scopeToCompany, async (req, res) => {
  const ctx = await prepareReport(req, res, req.query);
  if (!ctx) return;
  if (ctx.errors.length) return res.status(422).json({ error: ctx.errors.join(' '), errors: ctx.errors });

  const wb = await buildInvoiceWorkbook(ctx.branch, ctx.built);
  const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  await logActivity(req.user.sub, 'Generated daily-sales Bukku invoice file', co[0].name,
    `${ctx.branch.report_prefix} ${rules.pad2(ctx.month)}/${ctx.year} — ${ctx.built.invoices.length} invoices, RM ${rules.formatCents(ctx.built.monthTotalCents)}`);

  const filename = `${rules.reportFileBase(ctx.branch, ctx.year, ctx.month)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

router.get(`${BASE}/branches/:branchId/report.pdf`, requireAuth, scopeToCompany, async (req, res) => {
  const ctx = await prepareReport(req, res, req.query);
  if (!ctx) return;
  if (ctx.errors.length) return res.status(422).json({ error: ctx.errors.join(' '), errors: ctx.errors });

  const filename = `${rules.reportFileBase(ctx.branch, ctx.year, ctx.month)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = buildReportPdf(ctx.branch, ctx.menu, ctx.built, cleanText(req.query.preparedBy, 100));
  doc.pipe(res);
  doc.end();
});

router.use((err, req, res, next) => {
  console.error('dailySales route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
