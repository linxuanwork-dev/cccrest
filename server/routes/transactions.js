const express = require('express');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { requirePage } = require('../lib/access');
const auditLog = require('../lib/auditLog');
const docs = require('../lib/docs');
const T = require('../core/transactions');
const F = require('../core/formats');
const readers = require('../core/readers');
const Bank = require('../core/bank');
const branchesLib = require('../lib/branches');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers - same wrapper as the other route files. An error with a status becomes that answer.
['get', 'post', 'put', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => (err && err.status ? res.status(err.status).json({ error: err.message }) : next(err)))
  )));
});

// The standard transactions of a company (phase 2). Purchases is the first module connected: the Purchases Bill page is read in, and Excel / CSV / PDF files too.
// Staff do the work (read in, classify, send for review, close exceptions); the Owner and Managers approve and export; only the Owner opens an approved one again.
const BASE = '/companies/:companyId/transactions';
const guard = (level) => [requireAuth, scopeToCompany, requirePage('purchases', level), (req, res, next) => (req.user.role === 'client' ? res.status(403).json({ error: 'Not allowed' }) : next())];
const idList = (v) => (Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter((x) => x > 0);
const actorOf = async (req) => ({ name: (await auditLog.userName(pool, req.user.sub)) || 'unknown', userId: req.user.sub, role: req.user.role });
const cid = (req) => parseInt(req.params.companyId, 10);

async function inTx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function purchasesOn(req) {
  const { rows } = await pool.query('SELECT enabled FROM purchase_bukku_settings WHERE company_id = $1', [cid(req)]);
  if (!rows[0] || !rows[0].enabled) throw Object.assign(new Error('The Purchases Bill page is not switched on for this company'), { status: 400 });
}

const dateStr = (d) => (d ? (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : '');
const out = (t) => ({
  id: t.id, internalNo: t.internal_no, date: dateStr(t.tx_date), type: t.type, counterparty: t.counterparty || '', billNo: (t.data && t.data.no) || '', ref: t.source_ref || '', amount: Number(t.amount), status: t.status,
  contactCode: t.contact_code || '', account: t.account || '', bukkuNo: t.bukku_no || '', openExceptions: t.open_exceptions || 0, approvedBy: t.approved_by || '', approvedAt: t.approved_at || null, exportedAt: t.exported_at || null,
  legacyExport: !!(t.data && t.data.legacyExport), direction: t.direction || '', bankAccount: t.bank_account || '', kind: (t.data && t.data.kind) || ''
});
const sendFile = async (res, format, table, baseName) => {
  const f = await F.render(format, table);
  const name = baseName + '.' + f.ext;
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-File-Name', encodeURIComponent(name));
  res.send(f.buffer);
};
async function companyName(req) { return (await docs.companyInfo(cid(req))).name; }

const LIST_HEADER = ['Internal No.', 'Date', 'Type', 'Supplier / Payer', 'Bill No.', 'Reference', 'Amount', 'Status', 'Bukku No.', 'Open exceptions', 'Approved by'];
const listRow = (t) => [t.internalNo, t.date, t.type, t.counterparty, t.billNo, t.ref, t.amount, t.status, t.bukkuNo, t.openExceptions, t.approvedBy];

async function listTx(req) {
  const args = [cid(req)]; const where = ['t.company_id = $1'];
  const q = req.query;
  if (q.status) { args.push(String(q.status).split(',').filter((s) => T.STATUSES.includes(s))); where.push('t.status = ANY($' + args.length + '::text[])'); }
  if (q.type) { args.push(String(q.type)); where.push('t.type = $' + args.length); }
  if (/^\d{4}-\d{2}$/.test(String(q.month || ''))) { args.push(q.month); where.push("to_char(t.tx_date, 'YYYY-MM') = $" + args.length); }
  if (q.q) { args.push('%' + String(q.q).replace(/[\\%_]/g, '\\$&') + '%'); where.push('(t.counterparty ILIKE $' + args.length + " OR t.internal_no ILIKE $" + args.length + " OR t.data->>'no' ILIKE $" + args.length + ')'); }
  if (String(q.open || '') === '1') where.push('EXISTS (SELECT 1 FROM exceptions e WHERE e.transaction_id = t.id AND NOT e.resolved)');
  const limit = Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 500));
  const { rows } = await pool.query(
    `SELECT t.*, (SELECT count(*)::int FROM exceptions e WHERE e.transaction_id = t.id AND NOT e.resolved) AS open_exceptions
       FROM transactions t WHERE ${where.join(' AND ')} ORDER BY t.tx_date, t.id LIMIT ${limit}`, args);
  return rows.map(out);
}

router.get(BASE + '/summary', ...guard(1), async (req, res) => {
  const by = (await pool.query('SELECT status, count(*)::int n, COALESCE(sum(amount), 0)::float total FROM transactions WHERE company_id = $1 GROUP BY status', [cid(req)])).rows;
  const open = (await pool.query('SELECT count(*)::int n FROM exceptions WHERE company_id = $1 AND NOT resolved', [cid(req)])).rows[0].n;
  res.json({ statuses: T.STATUSES, byStatus: by, openExceptions: open });
});

// the list; ?format=xlsx|csv|pdf gives it as a file
router.get(BASE, ...guard(1), async (req, res) => {
  const rows = await listTx(req);
  if (!req.query.format) return res.json(rows);
  const total = ['Total', '', '', '', '', '', Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, '', '', '', ''];
  const info = await docs.companyInfo(cid(req));
  await sendFile(res, req.query.format, { company: info.name, title: 'Transactions', subtitle: (req.query.status ? 'status: ' + req.query.status + ' · ' : '') + rows.length + ' rows', header: LIST_HEADER, rows: rows.map(listRow), total, sheet: 'Transactions' },
    info.PREFIX + '-TRANSACTIONS-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
});

router.get(BASE + '/exceptions', ...guard(1), async (req, res) => {
  const resolved = String(req.query.resolved || '') === '1';
  const { rows } = await pool.query(
    `SELECT e.id, e.type, e.detail, e.resolved, e.resolved_by, e.resolved_at, e.resolve_note, e.created_at, t.internal_no, t.counterparty, t.id AS transaction_id, t.amount
       FROM exceptions e JOIN transactions t ON t.id = e.transaction_id WHERE e.company_id = $1 AND e.resolved = $2 ORDER BY e.id DESC LIMIT 1000`, [cid(req), resolved]);
  if (!req.query.format) return res.json(rows);
  const info = await docs.companyInfo(cid(req));
  await sendFile(res, req.query.format, { company: info.name, title: resolved ? 'Closed exceptions' : 'Open exceptions', subtitle: rows.length + ' rows',
    header: ['Transaction', 'Supplier / Payer', 'Amount', 'Exception', 'What was found', 'Closed by', 'Note'],
    rows: rows.map((r) => [r.internal_no, r.counterparty || '', Number(r.amount), r.type, r.detail || '', r.resolved_by || '', r.resolve_note || '']), sheet: 'Exceptions' }, info.PREFIX + '-EXCEPTIONS-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
});

// the import templates (the first row is the header the reader looks for)
router.get(BASE + '/template', ...guard(1), async (req, res) => {
  const kind = req.query.kind === 'bank' ? 'bank' : 'purchase'; const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const t = kind === 'bank'
    ? { title: 'Bank statement template', header: ['Date', 'Payer', 'Credit', 'Debit', 'Reference', 'Bank Account'], rows: [['2026-11-03', 'EXAMPLE PAYER', 1500, '', 'INV 1234', 'PBB 1234'], ['2026-11-04', 'EXAMPLE SUPPLIER SDN BHD', '', 800, 'IBG PAYMENT INV-001', 'PBB 1234']], sheet: 'Bank' }
    : { title: 'Purchase bill template', header: ['Date', 'Supplier', 'Contact Code', 'Bill No.', 'Reference', 'Description', 'Account', 'Item', 'Qty', 'Unit Price', 'Tax', 'Tags'], rows: [['2026-11-03', 'EXAMPLE SDN BHD', 'C-E0001', 'INV-001', '', 'Stationery', '6000', 'Paper A4', 2, 12.5, '', ''], ['2026-11-03', 'EXAMPLE SDN BHD', 'C-E0001', 'INV-001', '', '', '6000', 'Pens', 1, 8, '', '']], sheet: 'Purchases' };
  const f = await F.render(format, Object.assign({}, t, { title: undefined, company: undefined }));
  const name = 'TEMPLATE-' + kind.toUpperCase() + '.' + f.ext;
  res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(f.buffer);
});

// read the Purchases Bill page in (run it as often as you like)
router.post(BASE + '/sync', ...guard(2), async (req, res) => {
  await purchasesOn(req);
  const actor = await actorOf(req);
  res.json(await inTx((db) => T.syncPurchaseBills(db, cid(req), actor)));
});

// read a file in: Excel / CSV (?kind=purchase|bank) or PDF (a Public Bank statement or a QC GROUP HQ bill). The file is the raw request body, ?name= its file name.
router.post(BASE + '/import', ...guard(2), express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file received' });
  const name = String(req.query.name || 'file'); const actor = await actorOf(req);
  if (/\.pdf$/i.test(name) || req.body.slice(0, 4).toString() === '%PDF') {
    const r = await readers.readPdf(req.body, name, { branches: await branchesLib.list(cid(req)) });
    if (r.kind === 'bank_statement') return res.json(Object.assign({ kind: 'bank' }, await inTx((db) => T.importBankLines(db, cid(req), r.rows.map((x) => ({ date: x.date, amount: x.amount, direction: 'in', payer: x.payer, ref: x.ref, time: x.time, account: String(req.query.account || '') || (r.bank ? r.bank + ' ' + (r.account || '') : '') })), actor, name, 'PBB statement ' + (r.statementDate || '')))));
    return res.json(Object.assign({ kind: 'purchase' }, await inTx((db) => T.importHqBill(db, cid(req), r.bill, actor, name))));
  }
  const table = await readers.readTable(req.body, name);
  const kind = req.query.kind === 'bank' ? 'bank' : 'purchase';
  res.json(Object.assign({ kind }, await inTx((db) => (kind === 'bank' ? T.importBankTable(db, cid(req), table, actor, name, String(req.query.account || '')) : T.importPurchaseTable(db, cid(req), table, actor, name)))));
});


// ---------- bank matching ----------
router.get(BASE + '/bank/outstanding', ...guard(1), async (req, res) => res.json(await Bank.outstanding(pool, cid(req), req.query.side === 'in' ? 'sales' : 'purchase')));
router.get(BASE + '/bank/prompts', ...guard(1), async (req, res) => res.json(await Bank.prompts(pool, cid(req), { days: parseInt(req.query.days, 10) || 7 })));
// the bank report: every line, what it is matched to, what is left (?format=xlsx|csv|pdf gives it as a file)
router.get(BASE + '/bank/report', ...guard(1), async (req, res) => {
  const rows = await Bank.bankReport(pool, cid(req), { status: req.query.status, month: req.query.month, direction: req.query.direction });
  if (!req.query.format) return res.json(rows);
  const info = await docs.companyInfo(cid(req));
  const total = (d) => Math.round(rows.filter((r) => r.direction === d).reduce((s, r) => s + r.amount, 0) * 100) / 100;
  await sendFile(res, req.query.format, { company: info.name, title: 'Bank report', subtitle: rows.length + ' lines · money in ' + total('in').toFixed(2) + ' · money out ' + total('out').toFixed(2),
    header: ['Internal No.', 'Date', 'Bank account', 'In / Out', 'Payer / Payee', 'Reference', 'Amount', 'Status', 'Kind', 'Matched to', 'Bank charge', 'Left'],
    rows: rows.map((r) => [r.internalNo, r.date, r.account, r.direction === 'out' ? 'Out' : 'In', r.payer, r.ref, r.amount, r.status, r.kind, r.matchedTo, r.fee, r.left]), sheet: 'Bank report' },
    info.PREFIX + '-BANK-REPORT-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
});
// the Bukku account code of each bank account (the label on the statement -> the code in Bukku)
router.get(BASE + '/bank/accounts', ...guard(1), async (req, res) => res.json(await Bank.bankAccounts(pool, cid(req))));
router.put(BASE + '/bank/accounts', ...guard(2), async (req, res) => {
  const a = await actorOf(req); if (!['admin', 'manager'].includes(a.role)) return res.status(403).json({ error: 'Only the Owner or a Manager can set the Bukku account of a bank account' });
  await inTx((db) => Bank.setBankAccount(db, cid(req), req.body && req.body.label, req.body && req.body.account, a, req.body && req.body.reason)); res.json({ ok: true });
});
// the Bukku Money Out file of approved money-out lines (direct expense, suspense, director, subcon): Excel (the Bukku template), CSV or a PDF list
router.post(BASE + '/bank/export-money-out', ...guard(2), async (req, res) => {
  const format = ['xlsx', 'csv', 'pdf'].includes(req.body && req.body.format) ? req.body.format : 'xlsx';
  const a = await actorOf(req); const r = await inTx((db) => Bank.exportMoneyOut(db, cid(req), idList(req.body && req.body.ids), a));
  try {
    const dates = r.lines.map((l) => l.date).sort(); const months = dates.map((d) => d.slice(0, 7).replace('-', '_'));
    const span = months.length ? (months[0] === months[months.length - 1] ? months[0] : months[0] + '_' + months[months.length - 1]) : 'NO_DATE';
    const info = await docs.companyInfo(cid(req));
    const base = await docs.fileBase('bank_money_out', cid(req), { SPAN: span }, info.PREFIX + '-BUKKU-MONEY_OUT-' + span);
    let file;
    if (format === 'xlsx') { docs.stampWorkbook(r.workbook, docs.stampText(await docs.userNameFor(req))); file = { buffer: Buffer.from(await r.workbook.xlsx.writeBuffer()), mime: F.FORMATS.xlsx.mime, ext: 'xlsx' }; }
    else if (format === 'csv') file = { buffer: Buffer.from(await r.workbook.csv.writeBuffer({ sheetName: 'Worksheet' })), mime: F.FORMATS.csv.mime, ext: 'csv' };
    else file = await F.render('pdf', { company: info.name, title: 'Bank payments for Bukku (Money Out)', subtitle: r.lines.length + ' lines',
      header: ['Date', 'Contact', 'No.', 'Reference', 'Payment account', 'Account', 'Item', 'Amount'],
      rows: r.lines.map((l) => [l.date, l.legalName || l.contactCode, l.no, l.ref, String(l.paymentAccount || ''), String(l.account || ''), l.itemDescription, l.amount]),
      total: ['Total', '', '', '', '', '', '', Math.round(r.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100] });
    const name = base + '.' + file.ext;
    await inTx((db) => T.recordExportFile(db, cid(req), r.txs, name));
    await docs.logEvent(req, cid(req), 'bank_money_out', name, 'generated', [{ field: 'lines', from: '', to: String(r.txs.length) }]);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-File-Name', encodeURIComponent(name));
    res.send(file.buffer);
  } catch (err) { await T.releaseExport(pool, cid(req), r.txs).catch(() => {}); throw err; }
});
router.post(BASE + '/bank/confirm-suggestions', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(await inTx((db) => Bank.confirmSuggestions(db, cid(req), idList(req.body && req.body.ids), a, req.body && req.body.minConfidence))); });
router.post(BASE + '/transfer', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(await inTx((db) => Bank.pairTransfer(db, cid(req), parseInt(req.body && req.body.outId, 10), parseInt(req.body && req.body.inId, 10), a, req.body && req.body.note))); });
router.post(BASE + '/unmatch', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(await inTx((db) => Bank.unmatch(db, cid(req), parseInt(req.body && req.body.matchId, 10), a, req.body && req.body.reason))); });
router.get(BASE + '/:id/suggestions', ...guard(1), async (req, res) => res.json(await Bank.suggest(pool, cid(req), parseInt(req.params.id, 10))));
router.get(BASE + '/:id/transfer-candidates', ...guard(1), async (req, res) => res.json(await Bank.transferCandidates(pool, cid(req), parseInt(req.params.id, 10))));
router.post(BASE + '/:id/match', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(await inTx((db) => Bank.matchBank(db, cid(req), parseInt(req.params.id, 10), req.body || {}, a))); });
router.post(BASE + '/:id/bank-kind', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(out(await inTx((db) => Bank.setKind(db, cid(req), parseInt(req.params.id, 10), req.body || {}, a)))); });

router.get(BASE + '/:id', ...guard(1), async (req, res) => {
  const id = parseInt(req.params.id, 10); const tx = await T.getTx(pool, cid(req), id);
  const exc = (await pool.query('SELECT id, type, detail, resolved, resolved_by, resolved_at, resolve_note, created_at FROM exceptions WHERE transaction_id = $1 ORDER BY id', [id])).rows;
  const hist = (await pool.query("SELECT at, who, action, field, before, after, reason FROM audit_log WHERE module = 'transactions' AND company_id = $1 AND record = $2 ORDER BY id", [cid(req), tx.internal_no])).rows;
  const matches = (await pool.query(
    `SELECT m.id, m.applied, m.method, m.note, m.voided, m.void_reason, m.created_by, m.created_at, b.internal_no AS bank_no, o.internal_no AS other_no, o.counterparty AS other_name, b.tx_date AS bank_date
       FROM matches m JOIN transactions b ON b.id = m.bank_tx_id JOIN transactions o ON o.id = m.other_tx_id WHERE m.company_id = $1 AND (m.bank_tx_id = $2 OR m.other_tx_id = $2) ORDER BY m.id`, [cid(req), id])).rows;
  res.json({ transaction: Object.assign(out(tx), { lines: tx.lines, data: tx.data, direction: tx.direction || '', bankAccount: tx.bank_account || '' }), exceptions: exc, history: hist, matches });
});

router.post(BASE + '/:id/classify', ...guard(2), async (req, res) => {
  const actor = await actorOf(req);
  const tx = await inTx((db) => T.classify(db, cid(req), parseInt(req.params.id, 10), { contact_code: req.body && req.body.contact_code, account: req.body && req.body.account }, actor));
  res.json(out(tx));
});
router.post(BASE + '/submit', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json({ ok: true, ids: await inTx((db) => T.submit(db, cid(req), idList(req.body && req.body.ids), a)) }); });
router.post(BASE + '/send-back', ...guard(2), async (req, res) => {
  const a = await actorOf(req); if (!['admin', 'manager'].includes(a.role)) return res.status(403).json({ error: 'Only the Owner or a Manager can send a transaction back' });
  res.json({ ok: true, ids: await inTx((db) => T.sendBack(db, cid(req), idList(req.body && req.body.ids), a, req.body && req.body.reason)) });
});
router.post(BASE + '/approve', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(Object.assign({ ok: true }, await inTx((db) => T.approve(db, cid(req), idList(req.body && req.body.ids), a)))); });
router.post(BASE + '/reopen', ...guard(2), async (req, res) => { const a = await actorOf(req); res.json(out(await inTx((db) => T.reopen(db, cid(req), parseInt(req.body && req.body.id, 10), a, req.body && req.body.reason)))); });
router.post(BASE + '/exceptions/:eid/resolve', ...guard(2), async (req, res) => {
  const a = await actorOf(req); await inTx((db) => T.resolveException(db, cid(req), parseInt(req.params.eid, 10), req.body && req.body.note, a)); res.json({ ok: true });
});

// the Bukku import file of approved purchase bills: Excel (the template as it is) or CSV; a PDF gives the readable list of the batch for the file
router.post(BASE + '/export', ...guard(2), async (req, res) => {
  const format = ['xlsx', 'csv', 'pdf'].includes(req.body && req.body.format) ? req.body.format : 'xlsx';
  const ids = idList(req.body && req.body.ids); const a = await actorOf(req);
  const r = await inTx((db) => T.exportPurchaseBills(db, cid(req), ids, a));
  try {
    const months = r.bills.map((b) => b.bill_date).filter(Boolean).sort().map((d) => d.slice(0, 7).replace('-', '_'));
    const span = months.length ? (months[0] === months[months.length - 1] ? months[0] : months[0] + '_' + months[months.length - 1]) : 'NO_DATE';
    const info = await docs.companyInfo(cid(req));
    const base = await docs.fileBase('purchase_bukku', cid(req), { SPAN: span }, info.PREFIX + '-BUKKU-PURCHASES_BILL-' + span);
    let file;
    if (format === 'xlsx') { docs.stampWorkbook(r.workbook, docs.stampText(await docs.userNameFor(req))); file = { buffer: Buffer.from(await r.workbook.xlsx.writeBuffer()), mime: F.FORMATS.xlsx.mime, ext: 'xlsx' }; }
    else if (format === 'csv') file = { buffer: Buffer.from(await r.workbook.csv.writeBuffer({ sheetName: 'Worksheet' })), mime: F.FORMATS.csv.mime, ext: 'csv' };
    else {
      const rows = r.bills.flatMap((b) => b.lines.map((l, i) => [b.bill_date, b.supplier, b.no, i ? '' : b.ref, l.account || '', l.desc, l.qty == null ? 1 : l.qty, Number(l.price), Math.round((l.qty == null ? 1 : l.qty) * Number(l.price) * 100) / 100]));
      file = await F.render('pdf', { company: info.name, title: 'Purchase bills for Bukku', subtitle: r.bills.length + ' bills', header: ['Date', 'Supplier', 'Bill No.', 'Reference', 'Account', 'Item', 'Qty', 'Unit price', 'Amount'], rows, total: ['Total', '', '', '', '', '', '', '', Math.round(rows.reduce((s, x) => s + x[8], 0) * 100) / 100] });
    }
    const name = base + '.' + file.ext;
    await inTx((db) => T.recordExportFile(db, cid(req), r.txs, name));
    await docs.logEvent(req, cid(req), 'transactions', name, 'generated', [{ field: 'bills', from: '', to: String(r.txs.length) }]);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-File-Name', encodeURIComponent(name));
    res.send(file.buffer);
  } catch (err) {   // the file could not be made: they go back to approved
    await T.releaseExport(pool, cid(req), r.txs).catch(() => {});
    throw err;
  }
});

router.use((err, req, res, next) => {
  console.error('transactions route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
