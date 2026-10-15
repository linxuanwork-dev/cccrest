const express = require('express');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { isManagerLevel } = require('../lib/companyLevel');
const { logActivity } = require('../lib/activity');
const rules = require('../lib/dailySalesRules');
const { buildInvoiceWorkbook } = require('../lib/dailySalesExcel');
const { buildReportPdf } = require('../lib/dailySalesPdf');

const router = express.Router();
const BASE = '/companies/:companyId/dsi';
const MANAGER_ONLY_MSG = '此项目只有 Manager 可以修改';
const CHECKED_MSG = '此记录已标记为 Checked，只有 Manager 可以修改';

// Express 4 doesn't forward rejected promises from async handlers; wrap them so a
// failure becomes a JSON 500 (see the error handler at the bottom) instead of a hung request.
['get', 'post', 'put', 'patch', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

async function requireConfigEditor(req, res, next) {
  if (await isManagerLevel(req)) return next();
  res.status(403).json({ error: MANAGER_ONLY_MSG });
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
  const branches = [];
  for (const b of rows) branches.push(publicBranch(b, await getMenu(b.id)));
  res.json({ canManage: await isManagerLevel(req), branches });
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

// ============ RECORDS (one per branch + month) ============

// Totals are computed live from the saved quantities, so they can never go stale after a menu price change.
const RECORD_SELECT = `
  SELECT r.id, r.branch_id, b.code AS branch_code, b.report_prefix, r.year, r.month, r.status,
         r.created_at, r.saved_at, r.checked_at,
         su.display_name AS saved_by_name, cu.display_name AS checked_by_name,
         COALESCE(t.total, 0)::float AS total, COALESCE(t.days, 0)::int AS invoice_days
  FROM dsi_records r
  JOIN dsi_branches b ON b.id = r.branch_id
  LEFT JOIN users su ON su.id = r.saved_by
  LEFT JOIN users cu ON cu.id = r.checked_by
  LEFT JOIN LATERAL (
    SELECT SUM(dt.day_total) AS total, COUNT(*) FILTER (WHERE dt.day_total > 0) AS days
    FROM (
      SELECT q.entry_date, SUM(q.qty * COALESCE(s.price, i.unit_price)) AS day_total
      FROM dsi_menu_items i
      JOIN dsi_quantities q ON q.item_id = i.id
        AND q.entry_date >= make_date(r.year, r.month, 1)
        AND q.entry_date < (make_date(r.year, r.month, 1) + interval '1 month')
      LEFT JOIN dsi_specials s ON s.item_id = i.id AND s.entry_date = q.entry_date
      WHERE i.branch_id = r.branch_id
      GROUP BY q.entry_date
    ) dt
  ) t ON true
  WHERE b.company_id = $1`;

function publicRecord(r) {
  return {
    id: r.id, branchId: r.branch_id, branchCode: r.branch_code, reportPrefix: r.report_prefix,
    year: r.year, month: r.month, status: r.status,
    invoiceDays: r.invoice_days, totalCents: Math.round(r.total * 100),
    createdAt: r.created_at, savedAt: r.saved_at, savedBy: r.saved_by_name,
    checkedAt: r.checked_at, checkedBy: r.checked_by_name
  };
}

async function fetchRecords(companyId, recordId) {
  const sql = RECORD_SELECT + (recordId ? ' AND r.id = $2' : '') + ' ORDER BY r.year DESC, r.month DESC, b.sort_order, b.id';
  const { rows } = await pool.query(sql, recordId ? [companyId, recordId] : [companyId]);
  return rows.map(publicRecord);
}

async function getRecordRow(companyId, recordId) {
  const { rows } = await pool.query(
    `SELECT r.* FROM dsi_records r JOIN dsi_branches b ON b.id = r.branch_id WHERE r.id = $1 AND b.company_id = $2`,
    [recordId, companyId]
  );
  return rows[0] || null;
}

async function companyName(companyId) {
  const { rows } = await pool.query('SELECT name FROM companies WHERE id = $1', [companyId]);
  return rows[0].name;
}

router.get(`${BASE}/records`, requireAuth, scopeToCompany, async (req, res) => {
  res.json({ canManage: await isManagerLevel(req), records: await fetchRecords(req.params.companyId) });
});

router.post(`${BASE}/records`, requireAuth, scopeToCompany, async (req, res) => {
  const body = req.body || {};
  const b = await getBranch(req.params.companyId, Number(body.branchId));
  if (!b) return res.status(400).json({ error: '请选择分店。' });
  const ym = parseYearMonth(body);
  if (!ym) return res.status(400).json({ error: '请先选择有效的年份和月份（2025–2035）。' });

  const { rows } = await pool.query(
    `INSERT INTO dsi_records (branch_id, year, month, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (branch_id, year, month) DO NOTHING RETURNING id`,
    [b.id, ym.year, ym.month, req.user.sub]
  );
  if (!rows[0]) {
    const { rows: ex } = await pool.query('SELECT id, status FROM dsi_records WHERE branch_id = $1 AND year = $2 AND month = $3', [b.id, ym.year, ym.month]);
    return res.status(409).json({
      error: `${b.report_prefix} 已经有 ${ym.year}-${rules.pad2(ym.month)} 的记录（状态：${ex[0].status}），同一个月份不能重复。请打开现有记录。`,
      existingId: ex[0].id, existingStatus: ex[0].status
    });
  }
  await logActivity(req.user.sub, 'Created daily-sales record', await companyName(req.params.companyId), `${b.report_prefix} ${ym.year}-${rules.pad2(ym.month)}`);
  res.status(201).json((await fetchRecords(req.params.companyId, rows[0].id))[0]);
});

router.get(`${BASE}/records/:recordId`, requireAuth, scopeToCompany, async (req, res) => {
  const rec = await getRecordRow(req.params.companyId, req.params.recordId);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const branch = await getBranch(req.params.companyId, rec.branch_id);
  const { qtyMap, specialMap } = await getMonthData(rec.branch_id, rec.year, rec.month);
  const manager = await isManagerLevel(req);
  res.json({
    record: (await fetchRecords(req.params.companyId, rec.id))[0],
    branch: publicBranch(branch, await getMenu(branch.id)),
    qty: qtyMap,
    specials: specialMap,
    canManage: manager,
    locked: rec.status === 'checked' && !manager
  });
});

// Parses client cells into DB operations. kind: 'qty' | 'price'
function parseCells(cells, kind, ym, itemIds) {
  const lastDay = rules.daysInMonth(ym.year, ym.month);
  const ops = [];
  for (const c of cells) {
    const day = Number(c.day);
    const itemId = Number(c.itemId);
    if (!Number.isInteger(day) || day < 1 || day > lastDay) return { error: `日期无效：${c.day}` };
    if (!itemIds.has(itemId)) return { error: '菜单项目无效。' };
    const date = `${ym.year}-${rules.pad2(ym.month)}-${rules.pad2(day)}`;
    const raw = kind === 'qty' ? c.qty : c.price;
    if (raw === '' || raw == null) { ops.push({ date, itemId, value: null }); continue; }
    const num = Number(raw);
    if (kind === 'qty') {
      if (!Number.isInteger(num) || num < 0) return { error: '数量只能是 0 或正整数。' };
      ops.push({ date, itemId, value: num === 0 ? null : num });
    } else {
      if (isNaN(num) || num < 0) return { error: '特价必须是 ≥ 0 的数字。' };
      ops.push({ date, itemId, value: Math.round(num * 100) / 100 });
    }
  }
  return { ops };
}

async function applyOps(client, kind, ops) {
  const table = kind === 'qty' ? 'dsi_quantities' : 'dsi_specials';
  const col = kind === 'qty' ? 'qty' : 'price';
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
}

// Explicit save: writes every changed cell, then stamps who saved and when.
router.put(`${BASE}/records/:recordId`, requireAuth, scopeToCompany, async (req, res) => {
  const rec = await getRecordRow(req.params.companyId, req.params.recordId);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const manager = await isManagerLevel(req);
  if (rec.status === 'checked' && !manager) return res.status(403).json({ error: CHECKED_MSG });

  const body = req.body || {};
  const qtyCells = Array.isArray(body.qtyCells) ? body.qtyCells : [];
  const specialCells = Array.isArray(body.specialCells) ? body.specialCells : [];
  if (qtyCells.length + specialCells.length > 5000) return res.status(400).json({ error: 'Too many changes in one save.' });
  if (specialCells.length && !manager) return res.status(403).json({ error: MANAGER_ONLY_MSG });

  const ym = { year: rec.year, month: rec.month };
  const menu = await getMenu(rec.branch_id);
  const itemIds = new Set(menu.map((m) => m.id));
  const q = parseCells(qtyCells, 'qty', ym, itemIds);
  if (q.error) return res.status(400).json({ error: q.error });
  const s = parseCells(specialCells, 'price', ym, itemIds);
  if (s.error) return res.status(400).json({ error: s.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyOps(client, 'qty', q.ops);
    await applyOps(client, 'price', s.ops);
    await client.query('UPDATE dsi_records SET saved_by = $1, saved_at = now() WHERE id = $2', [req.user.sub, rec.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const record = (await fetchRecords(req.params.companyId, rec.id))[0];
  await logActivity(req.user.sub, rec.status === 'checked' ? 'Amended checked daily-sales record' : 'Saved daily-sales record',
    await companyName(req.params.companyId), `${record.reportPrefix} ${rec.year}-${rules.pad2(rec.month)} — RM ${rules.formatCents(record.totalCents)}`);
  res.json(record);
});

async function loadReportContext(req, res) {
  const rec = await getRecordRow(req.params.companyId, req.params.recordId);
  if (!rec) { res.status(404).json({ error: 'Not found' }); return null; }
  const branch = await getBranch(req.params.companyId, rec.branch_id);
  const menu = await getMenu(branch.id);
  const { qtyMap, specialMap } = await getMonthData(branch.id, rec.year, rec.month);
  const built = rules.buildMonth(branch, menu, qtyMap, specialMap, rec.year, rec.month);
  const errors = rules.runChecks(branch, menu, built, rec.year, rec.month);
  return { rec, branch, menu, built, errors, year: rec.year, month: rec.month };
}

// Manager level only: mark as checked (locks staff out of editing) or back to pending.
router.patch(`${BASE}/records/:recordId/status`, requireAuth, scopeToCompany, requireConfigEditor, async (req, res) => {
  const status = (req.body || {}).status;
  if (!['pending', 'checked'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const ctx = await loadReportContext(req, res);
  if (!ctx) return;

  if (status === 'checked') {
    if (ctx.errors.length) return res.status(422).json({ error: `不能标记为 Checked：${ctx.errors.join(' ')}`, errors: ctx.errors });
    await pool.query('UPDATE dsi_records SET status = $1, checked_by = $2, checked_at = now() WHERE id = $3', ['checked', req.user.sub, ctx.rec.id]);
  } else {
    await pool.query('UPDATE dsi_records SET status = $1, checked_by = NULL, checked_at = NULL WHERE id = $2', ['pending', ctx.rec.id]);
  }
  await logActivity(req.user.sub, status === 'checked' ? 'Marked daily-sales record as checked' : 'Set daily-sales record back to pending',
    await companyName(req.params.companyId), `${ctx.branch.report_prefix} ${ctx.year}-${rules.pad2(ctx.month)}`);
  res.json((await fetchRecords(req.params.companyId, ctx.rec.id))[0]);
});

// Manager level only: removes the record AND that month's saved quantities/special prices.
router.delete(`${BASE}/records/:recordId`, requireAuth, scopeToCompany, requireConfigEditor, async (req, res) => {
  const rec = await getRecordRow(req.params.companyId, req.params.recordId);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const { start, end } = monthRange(rec.year, rec.month);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['dsi_quantities', 'dsi_specials']) {
      await client.query(
        `DELETE FROM ${table} WHERE entry_date >= $2 AND entry_date < $3
           AND item_id IN (SELECT id FROM dsi_menu_items WHERE branch_id = $1)`,
        [rec.branch_id, start, end]
      );
    }
    await client.query('DELETE FROM dsi_records WHERE id = $1', [rec.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const branch = await getBranch(req.params.companyId, rec.branch_id);
  await logActivity(req.user.sub, 'Deleted daily-sales record', await companyName(req.params.companyId), `${branch.report_prefix} ${rec.year}-${rules.pad2(rec.month)}`);
  res.json({ ok: true });
});

// ============ CHECK + DOWNLOADS (from the saved record) ============

router.post(`${BASE}/records/:recordId/check`, requireAuth, scopeToCompany, async (req, res) => {
  const ctx = await loadReportContext(req, res);
  if (!ctx) return;
  res.json({
    ok: ctx.errors.length === 0,
    errors: ctx.errors,
    summary: { invoiceDays: ctx.built.invoices.length, totalCents: ctx.built.monthTotalCents }
  });
});

router.get(`${BASE}/records/:recordId/report.xlsx`, requireAuth, scopeToCompany, async (req, res) => {
  const ctx = await loadReportContext(req, res);
  if (!ctx) return;
  if (ctx.errors.length) return res.status(422).json({ error: ctx.errors.join(' '), errors: ctx.errors });

  const wb = await buildInvoiceWorkbook(ctx.branch, ctx.built);
  await logActivity(req.user.sub, 'Downloaded daily-sales Bukku invoice file', await companyName(req.params.companyId),
    `${ctx.branch.report_prefix} ${rules.pad2(ctx.month)}/${ctx.year} — ${ctx.built.invoices.length} invoices, RM ${rules.formatCents(ctx.built.monthTotalCents)}`);

  const filename = `${rules.reportFileBase(ctx.branch, ctx.year, ctx.month)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

router.get(`${BASE}/records/:recordId/report.pdf`, requireAuth, scopeToCompany, async (req, res) => {
  const ctx = await loadReportContext(req, res);
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
