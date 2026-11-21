// The standard transaction core (SPEC-system section 4; phase 2). Every company and module goes through the same road:
//   imported -> (matched / pending / missing_doc) -> classified -> in_review -> approved -> exported
// The module only decides how things are read in (core/readers.js + a source below) and which accounts are used.
// Two numbers: internal_no is given at import (SK-2026-11-0035); bukku_no is given when approved.
// Every step is written to the audit_log (module 'transactions', record = the internal number).
const { pool } = require('../db');
const auditLog = require('../lib/auditLog');
const settings = require('../lib/settings');
const { buildPurchaseBillWorkbook, normName } = require('./bukkuExport');

const STATUSES = ['imported', 'matched', 'pending', 'missing_doc', 'classified', 'in_review', 'approved', 'exported'];
// where a transaction may go from each status (anything else is refused)
const NEXT = {
  imported: ['matched', 'pending', 'missing_doc', 'classified'],
  matched: ['classified', 'pending'],
  pending: ['classified', 'missing_doc'],
  missing_doc: ['classified', 'pending'],
  classified: ['in_review', 'pending', 'missing_doc', 'imported'],
  in_review: ['approved', 'classified'],        // approved, or sent back
  approved: ['exported', 'in_review'],          // exported, or opened again (the Owner, with a reason)
  exported: []                                  // after the export a document is voided in Bukku, not changed here
};
const can = (from, to) => (NEXT[from] || []).includes(to);

const fail = (status, message) => Object.assign(new Error(message), { status });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isMgrRole = (a) => a && (a.role === 'admin' || a.role === 'manager');

async function audit(db, actor, companyId, tx, action, extra) {
  await auditLog.write(db, Object.assign({ who: (actor && actor.name) || 'system', userId: actor && actor.userId, companyId, module: 'transactions', record: tx.internal_no || tx.internalNo, action }, extra || {}));
}

/* ---------- the internal number: PREFIX-YYYY-MM-NNNN (per company and month, never reused) ---------- */
async function companyPrefix(db, companyId) {
  const set = await settings.get(companyId, 'short_name', null, db);
  if (set) return String(set).toUpperCase();
  const { rows } = await db.query('SELECT name, file_prefix FROM companies WHERE id = $1', [companyId]);
  const c = rows[0] || { name: '', file_prefix: null };
  const initials = String(c.name).replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3);
  return String(c.file_prefix || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || initials || 'TX';
}
async function nextInternalNo(db, companyId, date) {
  const month = /^\d{4}-\d{2}/.test(String(date || '')) ? String(date).slice(0, 7) : new Date().toISOString().slice(0, 7);
  const { rows } = await db.query(
    `INSERT INTO tx_counters (company_id, key, n) VALUES ($1, $2, 1) ON CONFLICT (company_id, key) DO UPDATE SET n = tx_counters.n + 1 RETURNING n`,
    [companyId, month]);
  return (await companyPrefix(db, companyId)) + '-' + month + '-' + String(rows[0].n).padStart(4, '0');
}

/* ---------- the purchase bill facts a check needs ---------- */
// what the company has for a supplier: { code, account } by normalised name, and the account used when nothing else is set
async function purchaseContext(db, companyId) {
  const sups = (await db.query('SELECT name, code, account, tags FROM purchase_bukku_contacts WHERE company_id = $1 ORDER BY name', [companyId])).rows;
  const st = (await db.query('SELECT account FROM purchase_bukku_settings WHERE company_id = $1', [companyId])).rows[0];
  return { suppliers: sups, byName: new Map(sups.map((s) => [normName(s.name), s])), defaultAccount: (st && st.account) || '' };
}

const linesOf = (tx) => (Array.isArray(tx.lines) ? tx.lines : []);
const accountOf = (line, sup, ctx) => String(line.account || (sup && sup.account) || (ctx && ctx.defaultAccount) || '').trim();

/* ---------- checks: what the system finds is written as exceptions; only a person closes one, with a note ---------- */
async function findIssues(db, tx, ctx) {
  const issues = [];
  const sup = ctx && ctx.byName ? ctx.byName.get(normName(tx.counterparty)) : null;
  if (!tx.tx_date) issues.push(['missing_date', 'The transaction has no date']);
  if (!(Number(tx.amount) !== 0)) issues.push(['zero_amount', 'The amount is 0']);
  if (tx.type === 'purchase') {
    if (!String(tx.counterparty || '').trim()) issues.push(['missing_contact', 'No supplier']);
    else if (!String(tx.contact_code || '').trim() && !(sup && sup.code)) issues.push(['missing_contact', 'The supplier "' + tx.counterparty + '" has no contact code in the supplier list']);
    const noAcc = linesOf(tx).filter((l) => !accountOf(l, sup, ctx));
    if (!linesOf(tx).length) issues.push(['missing_lines', 'The bill has no lines']);
    else if (noAcc.length) issues.push(['missing_account', noAcc.length + ' line(s) have no account (and the supplier / company have no default)']);
    const no = String((tx.data && tx.data.no) || '').trim();
    if (!no) issues.push(['missing_no', 'The supplier bill number is empty']);
    else if (!(tx.data && tx.data.dupAck)) {
      const dup = (await db.query(
        `SELECT internal_no FROM transactions WHERE company_id = $1 AND type = 'purchase' AND id <> $2 AND upper(btrim(counterparty)) = upper(btrim($3)) AND upper(btrim(data->>'no')) = upper(btrim($4)) LIMIT 1`,
        [tx.company_id, tx.id, tx.counterparty || '', no])).rows[0];
      if (dup) issues.push(['duplicate_no', 'The same supplier and bill number are already in ' + dup.internal_no]);
    }
  }
  if (tx.type === 'bank' && !(Number(tx.amount) > 0)) issues.push(['bad_amount', 'A bank line with money in must have an amount above 0']);
  return issues;
}

// writes the exceptions the checks found (an exception that is open already is not written twice); returns the number open now
async function runChecks(db, txId, ctx) {
  const tx = (await db.query('SELECT * FROM transactions WHERE id = $1', [txId])).rows[0];
  if (!tx) throw fail(404, 'Transaction not found');
  const c = ctx || (tx.type === 'purchase' ? await purchaseContext(db, tx.company_id) : null);
  // a person already closed this very finding (same kind, same words): it is not raised again
  const closed = new Set((await db.query('SELECT type, detail FROM exceptions WHERE transaction_id = $1 AND resolved', [tx.id])).rows.map((r) => r.type + '|' + (r.detail || '')));
  for (const [type, detail] of await findIssues(db, tx, c)) {
    if (closed.has(type + '|' + detail)) continue;
    const r = await db.query('INSERT INTO exceptions (company_id, transaction_id, type, detail) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [tx.company_id, tx.id, type, detail]);
    if (r.rows[0]) await audit(db, null, tx.company_id, tx, 'exception', { field: type, after: detail });
  }
  return (await db.query('SELECT count(*)::int n FROM exceptions WHERE transaction_id = $1 AND NOT resolved', [txId])).rows[0].n;
}

async function move(db, tx, to, actor, reason) {
  if (!can(tx.status, to)) throw fail(409, 'A transaction that is "' + tx.status + '" can not go to "' + to + '"');
  await db.query('UPDATE transactions SET status = $2, updated_at = now() WHERE id = $1', [tx.id, to]);
  await audit(db, actor, tx.company_id, tx, 'status', { field: 'status', before: tx.status, after: to, reason });
  tx.status = to;
}

/* ---------- sources: purchase bills of the Purchases Bill page ---------- */
const fingerprint = (b) => JSON.stringify([b.bill_date, Number(b.total), b.supplier, b.code, b.no, b.ref, b.tags, b.description, b.lines]);

async function upsertPurchaseBill(db, companyId, bill, ctx, actor, importId) {
  const origin = 'purchase_bukku_bills:' + bill.id;
  const sup = ctx.byName.get(normName(bill.supplier));
  const code = (sup && sup.code) || bill.code || '';
  const data = { supplier: bill.supplier, no: bill.no || '', ref: bill.ref || '', tags: bill.tags || '', description: bill.description || '', revised: !!bill.revised, hq: bill.hq || null, dupAck: !!bill.dup_ack, code: bill.code || '', fingerprint: fingerprint(bill) };
  const ex = (await db.query('SELECT * FROM transactions WHERE company_id = $1 AND origin = $2', [companyId, origin])).rows[0];
  if (!ex) {
    const internalNo = await nextInternalNo(db, companyId, bill.bill_date);
    const tx = (await db.query(
      `INSERT INTO transactions (company_id, tx_date, type, amount, counterparty, source_ref, import_id, internal_no, status, contact_code, lines, data, origin)
       VALUES ($1,$2,'purchase',$3,$4,$5,$6,$7,'imported',$8,$9::jsonb,$10::jsonb,$11) RETURNING *`,
      [companyId, bill.bill_date || null, r2(bill.total), bill.supplier, bill.ref || null, importId || null, internalNo, code || null, JSON.stringify(bill.lines || []), JSON.stringify(data), origin])).rows[0];
    await audit(db, actor, companyId, tx, 'imported', { after: 'purchase bill ' + (bill.no || '') + ' from ' + bill.supplier + ', ' + tx.amount });
    if (bill.status === 'exported') await db.query("UPDATE transactions SET data = data || '{\"legacyExport\": true}'::jsonb WHERE id = $1", [tx.id]);
    return { tx, created: true };
  }
  const changed = (ex.data && ex.data.fingerprint) !== data.fingerprint;
  if (ex.status === 'approved' || ex.status === 'exported') {
    if (changed) {   // the page changed the bill after it was approved: only a person can decide what to do
      const r = await db.query("INSERT INTO exceptions (company_id, transaction_id, type, detail) VALUES ($1,$2,'changed_after_approval','The bill in the Purchases Bill page was changed after it was approved') ON CONFLICT DO NOTHING RETURNING id", [companyId, ex.id]);
      if (r.rows[0]) await audit(db, actor, companyId, ex, 'exception', { field: 'changed_after_approval' });
    }
    return { tx: ex, created: false, changed: false, locked: true };
  }
  if (!changed) return { tx: ex, created: false, changed: false };
  const tx = (await db.query(
    `UPDATE transactions SET tx_date = $2, amount = $3, counterparty = $4, source_ref = $5, contact_code = $6, lines = $7::jsonb, data = $8::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
    [ex.id, bill.bill_date || null, r2(bill.total), bill.supplier, bill.ref || null, code || null, JSON.stringify(bill.lines || []), JSON.stringify(data)])).rows[0];
  await audit(db, actor, companyId, tx, 'updated', { field: 'source', after: 'the bill was changed in the Purchases Bill page' });
  if (tx.status === 'in_review') await move(db, tx, 'classified', actor, 'the bill was changed after it was submitted');
  return { tx, created: false, changed: true };
}

// the status a purchase bill earns by its data: classified when the supplier code and the accounts are there, otherwise it stays "imported"
async function autoClassify(db, tx, ctx, actor) {
  if (!['imported', 'classified', 'pending', 'missing_doc'].includes(tx.status)) return tx.status;
  const sup = ctx.byName.get(normName(tx.counterparty));
  const ok = (tx.contact_code || (sup && sup.code)) && linesOf(tx).length && linesOf(tx).every((l) => accountOf(l, sup, ctx));
  const to = ok ? 'classified' : tx.status === 'classified' ? 'imported' : tx.status;
  if (to !== tx.status && can(tx.status, to)) await move(db, tx, to, actor, ok ? 'supplier and accounts are set' : 'supplier or account is missing');
  return tx.status;
}

/* Reads all bills of the company into standard transactions (run it as often as you like: the same bill is the same transaction) */
async function syncPurchaseBills(db, companyId, actor) {
  const ctx = await purchaseContext(db, companyId);
  const bills = (await db.query(
    `SELECT id, supplier, code, no, ref, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, tags, description, lines, total, status, dup_ack, revised, hq, exported_at
       FROM purchase_bukku_bills WHERE company_id = $1 ORDER BY bill_date, id`, [companyId])).rows;
  const imp = (await db.query("INSERT INTO imports (company_id, module, month, file_name, row_count, created_by) VALUES ($1,'purchase_bukku',$2,'Purchases Bill page',$3,$4) RETURNING id",
    [companyId, new Date().toISOString().slice(0, 7), bills.length, (actor && actor.name) || null])).rows[0].id;
  const out = { created: 0, updated: 0, unchanged: 0, locked: 0, exceptions: 0, legacyExported: 0 };
  for (const b of bills) {
    const r = await upsertPurchaseBill(db, companyId, b, ctx, actor, imp);
    if (r.created) out.created++; else if (r.locked) out.locked++; else if (r.changed) out.updated++; else out.unchanged++;
    let tx = r.tx;
    if (b.status === 'exported' && !['approved', 'exported'].includes(tx.status)) {   // exported already in the old flow: it is exported here too (so the two lists agree)
      await db.query("UPDATE transactions SET status = 'exported', exported_at = COALESCE($2, now()), bukku_no = COALESCE(NULLIF(data->>'no', ''), bukku_no), data = data || '{\"legacyExport\": true}'::jsonb, updated_at = now() WHERE id = $1", [tx.id, b.exported_at]);
      await audit(db, actor, companyId, tx, 'status', { field: 'status', before: tx.status, after: 'exported', reason: 'exported in the Purchases Bill page before' });
      out.legacyExported++; continue;
    }
    tx = (await db.query('SELECT * FROM transactions WHERE id = $1', [tx.id])).rows[0];
    await autoClassify(db, tx, ctx, actor);
    if (!['approved', 'exported'].includes(tx.status)) out.exceptions += await runChecks(db, tx.id, ctx);
  }
  return Object.assign(out, { importId: imp, bills: bills.length });
}

/* ---------- the other ways in: an Excel / CSV table, and what a PDF gives ---------- */
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '');
const COLS = {
  purchase: {
    date: ['date', 'billdate', 'invoicedate', '日期'], supplier: ['supplier', 'legalname', 'vendor', 'name', '供应商'], code: ['contactcode', 'code', 'suppliercode'],
    no: ['billno', 'no', 'invoiceno', 'invoicenumber', 'number', 'singh', '单号'], ref: ['reference', 'referenceno', 'ref'], description: ['description', 'remark', 'remarks', 'note'],
    account: ['account', 'accountcode', 'acc'], item: ['item', 'itemdescription', 'itemdesc', 'product'], qty: ['qty', 'quantity'], price: ['unitprice', 'price', 'rate'], amount: ['amount', 'total', 'lineamount'], tax: ['tax', 'taxcode'], tags: ['tags', 'tag']
  },
  bank: { date: ['date', 'transactiondate', '日期'], payer: ['payer', 'name', 'description', 'payername', 'counterparty', '付款人'], amount: ['credit', 'amount', 'moneyin', 'deposit', '金额'], ref: ['reference', 'ref', 'remark', 'remarks', 'note'] }
};
function mapColumns(header, kind) {
  const idx = {}; const h = header.map(norm);
  for (const [key, names] of Object.entries(COLS[kind])) { const i = h.findIndex((x) => names.includes(x)); if (i >= 0) idx[key] = i; }
  return idx;
}
const num = (v) => { if (typeof v === 'number') return v; const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };
function toIsoDate(v) {
  const s = String(v == null ? '' : v).trim(); if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}

/* table: { header, rows } -> purchase transactions (rows with the same supplier and bill number are the lines of one bill) */
async function importPurchaseTable(db, companyId, table, actor, fileName) {
  const idx = mapColumns(table.header, 'purchase'); const bad = [];
  for (const need of ['supplier', 'no', 'date']) if (idx[need] === undefined) bad.push(need);
  if (bad.length) throw fail(422, 'The columns ' + bad.join(', ') + ' were not found. The first row must be the header: Date, Supplier, Bill No., Reference, Description, Account, Item, Qty, Unit Price, Tax, Contact Code, Tags.');
  const get = (r, k) => (idx[k] === undefined ? '' : r[idx[k]]);
  const bills = new Map(); const problems = [];
  table.rows.forEach((r, i) => {
    const supplier = String(get(r, 'supplier') || '').trim(), no = String(get(r, 'no') || '').trim();
    if (!supplier && !no) return;
    const key = normName(supplier) + '|' + no.toUpperCase();
    let b = bills.get(key);
    if (!b) { b = { supplier, no, date: toIsoDate(get(r, 'date')), code: String(get(r, 'code') || '').trim(), ref: String(get(r, 'ref') || '').trim(), description: String(get(r, 'description') || '').trim(), tags: String(get(r, 'tags') || '').trim(), lines: [], row: i + 2 }; bills.set(key, b); if (!b.date) problems.push('Row ' + (i + 2) + ': the date "' + get(r, 'date') + '" is not a date (use YYYY-MM-DD or DD/MM/YYYY)'); }
    const qty = idx.qty === undefined || get(r, 'qty') === '' ? 1 : num(get(r, 'qty'));
    let price = idx.price !== undefined && get(r, 'price') !== '' ? num(get(r, 'price')) : (idx.amount !== undefined ? num(get(r, 'amount')) / (qty || 1) : NaN);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) { problems.push('Row ' + (i + 2) + ': the quantity or price is not a number'); return; }
    b.lines.push({ account: String(get(r, 'account') || '').trim(), desc: String(get(r, 'item') || get(r, 'description') || '').trim() || 'Purchases', qty, price: r2(price), tax: String(get(r, 'tax') || '').trim() });
  });
  if (problems.length) throw fail(422, problems.slice(0, 8).join('\n') + (problems.length > 8 ? '\n… (' + problems.length + ' problems)' : ''));
  if (!bills.size) throw fail(422, 'No bill rows were found');
  const ctx = await purchaseContext(db, companyId);
  const imp = (await db.query("INSERT INTO imports (company_id, module, month, file_name, row_count, created_by) VALUES ($1,'purchase_file',$2,$3,$4,$5) RETURNING id",
    [companyId, new Date().toISOString().slice(0, 7), fileName || null, table.rows.length, (actor && actor.name) || null])).rows[0].id;
  const made = [];
  for (const b of bills.values()) {
    const total = r2(b.lines.reduce((s, l) => s + l.qty * l.price, 0));
    const sup = ctx.byName.get(normName(b.supplier)); const code = b.code || (sup && sup.code) || '';
    const data = { supplier: b.supplier, no: b.no, ref: b.ref, tags: b.tags, description: b.description, code: b.code, file: fileName || null };
    const internalNo = await nextInternalNo(db, companyId, b.date);
    const tx = (await db.query(
      `INSERT INTO transactions (company_id, tx_date, type, amount, counterparty, source_ref, import_id, internal_no, status, contact_code, lines, data, origin)
       VALUES ($1,$2,'purchase',$3,$4,$5,$6,$7,'imported',$8,$9::jsonb,$10::jsonb,$11) RETURNING *`,
      [companyId, b.date, total, b.supplier, b.ref || null, imp, internalNo, code || null, JSON.stringify(b.lines), JSON.stringify(data), 'file:' + imp + ':' + b.row])).rows[0];
    await audit(db, actor, companyId, tx, 'imported', { after: 'purchase bill ' + b.no + ' from ' + b.supplier + ', ' + total + (fileName ? ' (file ' + fileName + ')' : '') });
    await autoClassify(db, tx, ctx, actor); await runChecks(db, tx.id, ctx);
    made.push(tx.id);
  }
  return { importId: imp, created: made.length, ids: made };
}

// money-in lines of a bank statement (an Excel / CSV table or a Public Bank PDF): "pending" = money came in, the source is not known yet
async function importBankLines(db, companyId, lines, actor, fileName, label) {
  const imp = (await db.query("INSERT INTO imports (company_id, module, month, file_name, row_count, created_by) VALUES ($1,'bank',$2,$3,$4,$5) RETURNING id",
    [companyId, (lines[0] && lines[0].date ? lines[0].date.slice(0, 7) : null), fileName || label || null, lines.length, (actor && actor.name) || null])).rows[0].id;
  const made = [];
  for (const l of lines) {
    const internalNo = await nextInternalNo(db, companyId, l.date);
    const tx = (await db.query(
      `INSERT INTO transactions (company_id, tx_date, type, amount, counterparty, source_ref, import_id, internal_no, status, data, origin)
       VALUES ($1,$2,'bank',$3,$4,$5,$6,$7,'imported',$8::jsonb,$9) RETURNING *`,
      [companyId, l.date || null, r2(l.amount), l.payer || null, l.ref || null, imp, internalNo, JSON.stringify({ time: l.time || '', file: fileName || null }), 'file:' + imp + ':' + made.length])).rows[0];
    await audit(db, actor, companyId, tx, 'imported', { after: 'bank money in ' + tx.amount + ' from ' + (l.payer || '?') });
    await runChecks(db, tx.id, null);
    await move(db, tx, 'pending', actor, 'money came in, the source is not known yet');
    made.push(tx.id);
  }
  return { importId: imp, created: made.length, ids: made };
}
async function importBankTable(db, companyId, table, actor, fileName) {
  const idx = mapColumns(table.header, 'bank');
  for (const need of ['date', 'amount']) if (idx[need] === undefined) throw fail(422, 'The column "' + need + '" was not found. The first row must be the header: Date, Payer, Credit (amount), Reference.');
  const lines = []; const problems = [];
  table.rows.forEach((r, i) => {
    const date = toIsoDate(r[idx.date]); const amount = num(r[idx.amount]);
    if (!String(r[idx.date] || '').trim() && !String(r[idx.amount] || '').trim()) return;
    if (!date) { problems.push('Row ' + (i + 2) + ': the date "' + r[idx.date] + '" is not a date'); return; }
    if (!Number.isFinite(amount)) { problems.push('Row ' + (i + 2) + ': the amount is not a number'); return; }
    if (amount <= 0) return;   // only money in
    lines.push({ date, amount, payer: idx.payer === undefined ? '' : String(r[idx.payer] || '').trim(), ref: idx.ref === undefined ? '' : String(r[idx.ref] || '').trim() });
  });
  if (problems.length) throw fail(422, problems.slice(0, 8).join('\n'));
  if (!lines.length) throw fail(422, 'No money-in lines were found');
  return importBankLines(db, companyId, lines, actor, fileName);
}
// a QC GROUP HQ bill read from a PDF -> one purchase transaction
async function importHqBill(db, companyId, bill, actor, fileName) {
  const table = { header: ['Date', 'Supplier', 'Bill No.', 'Item', 'Qty', 'Unit Price'], rows: bill.items.map((it) => [bill.date, 'QC GROUP', bill.invoiceNo, [it.title, it.fields && it.fields.client].filter(Boolean).join(' - ').toUpperCase(), it.qty, it.price]) };
  return importPurchaseTable(db, companyId, table, actor, fileName);
}

/* ---------- the steps a person does ---------- */
async function getTx(db, companyId, id, forUpdate) {
  const tx = (await db.query('SELECT * FROM transactions WHERE id = $1 AND company_id = $2' + (forUpdate ? ' FOR UPDATE' : ''), [id, companyId])).rows[0];
  if (!tx) throw fail(404, 'Transaction not found');
  return tx;
}

async function classify(db, companyId, id, patch, actor) {
  const tx = await getTx(db, companyId, id, true);
  if (['approved', 'exported'].includes(tx.status)) throw fail(409, 'It is approved: open it again first');
  const fields = {}; const log = [];
  if (patch.contact_code !== undefined) { fields.contact_code = String(patch.contact_code).trim() || null; log.push(['contact_code', tx.contact_code, fields.contact_code]); }
  if (patch.account !== undefined) {
    const acc = String(patch.account).trim(); fields.account = acc || null; log.push(['account', tx.account, acc]);
    if (acc && tx.type === 'purchase') { fields.lines = JSON.stringify(linesOf(tx).map((l) => (l.account ? l : Object.assign({}, l, { account: acc })))); }   // lines without an account get it
  }
  if (!Object.keys(fields).length) throw fail(400, 'Nothing to change');
  const sets = Object.keys(fields).map((k, i) => k + ' = $' + (i + 2) + (k === 'lines' ? '::jsonb' : ''));
  const t2 = (await db.query('UPDATE transactions SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1 RETURNING *', [id, ...Object.values(fields)])).rows[0];
  for (const [f, b, a] of log) await audit(db, actor, companyId, tx, 'classified', { field: f, before: b, after: a });
  const ctx = t2.type === 'purchase' ? await purchaseContext(db, companyId) : { byName: new Map(), defaultAccount: '' };
  if (t2.type === 'purchase') await autoClassify(db, t2, ctx, actor);
  else if (can(t2.status, 'classified') && (t2.contact_code || t2.account)) await move(db, t2, 'classified', actor, 'classified by hand');
  await runChecks(db, id, t2.type === 'purchase' ? ctx : null);
  return (await db.query('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];
}

async function submit(db, companyId, ids, actor) {
  const done = [];
  for (const id of ids) {
    const tx = await getTx(db, companyId, id, true);
    if (tx.status !== 'classified') throw fail(409, tx.internal_no + ' is "' + tx.status + '": only classified transactions can be sent for review');
    await db.query('UPDATE transactions SET submitted_by = $2 WHERE id = $1', [id, (actor && actor.name) || null]);
    await move(db, tx, 'in_review', actor); done.push(id);
  }
  return done;
}
async function sendBack(db, companyId, ids, actor, reason) {
  if (String(reason || '').trim().length < 3) throw fail(400, 'A reason is required');
  for (const id of ids) { const tx = await getTx(db, companyId, id, true); await move(db, tx, 'classified', actor, reason); }
  return ids;
}

/* Approve a batch (the Owner or a Manager): every one must be in review with no open exception. All or nothing. Locks them and gives the Bukku number
   (a purchase bill uses the supplier's own number, so no running number is needed). */
async function approve(db, companyId, ids, actor) {
  if (!isMgrRole(actor)) throw fail(403, 'Only the Owner or a Manager can approve');
  if (!ids.length) throw fail(400, 'Nothing selected');
  const txs = [];
  for (const id of ids) {
    const tx = await getTx(db, companyId, id, true);
    if (tx.status !== 'in_review') throw fail(409, tx.internal_no + ' is "' + tx.status + '": only transactions in review can be approved');
    const open = (await db.query('SELECT type FROM exceptions WHERE transaction_id = $1 AND NOT resolved', [id])).rows;
    if (open.length) throw fail(409, tx.internal_no + ' still has ' + open.length + ' open exception(s) (' + open.map((o) => o.type).join(', ') + '): close each one with a note first');
    txs.push(tx);
  }
  const months = txs.map((t) => (t.tx_date ? String(t.tx_date.toISOString ? t.tx_date.toISOString() : t.tx_date).slice(0, 7) : null)).filter(Boolean).sort();
  const appr = (await db.query("INSERT INTO approvals (company_id, month, module, tx_ids, approved_by, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [companyId, months[0] || null, 'purchase', txs.map((t) => t.id), actor.name || 'unknown', actor.userId || null])).rows[0].id;
  for (const tx of txs) {
    const bukkuNo = tx.type === 'purchase' ? String((tx.data && tx.data.no) || '') : tx.bukku_no;
    await db.query("UPDATE transactions SET status = 'approved', approved_by = $2, approved_at = now(), bukku_no = $3, updated_at = now() WHERE id = $1", [tx.id, actor.name || null, bukkuNo || null]);
    await audit(db, actor, companyId, tx, 'approved', { field: 'status', before: 'in_review', after: 'approved', reason: 'approval #' + appr + (bukkuNo ? ', Bukku number ' + bukkuNo : '') });
  }
  return { approvalId: appr, count: txs.length };
}

// only the Owner, with a reason: it goes back to review, is checked again, and is approved again. An exported document is voided in Bukku, not opened here.
async function reopen(db, companyId, id, actor, reason) {
  if (!actor || actor.role !== 'admin') throw fail(403, 'Only the Owner can open an approved transaction again');
  if (String(reason || '').trim().length < 3) throw fail(400, 'A reason is required');
  const tx = await getTx(db, companyId, id, true);
  if (tx.status === 'exported') throw fail(409, 'It was exported: void it in Bukku (the number stays) and add a new transaction');
  await move(db, tx, 'in_review', actor, reason);
  await db.query('UPDATE transactions SET approved_by = NULL, approved_at = NULL WHERE id = $1', [id]);
  await db.query('UPDATE approvals SET reopened = true, reopened_by = $2, reopened_at = now(), reopen_reason = $3 WHERE company_id = $4 AND $1 = ANY(tx_ids) AND NOT reopened', [id, actor.name || null, reason, companyId]);
  return (await db.query('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];
}

async function resolveException(db, companyId, exceptionId, note, actor) {
  if (String(note || '').trim().length < 3) throw fail(400, 'A note is required to close an exception');
  const e = (await db.query('SELECT * FROM exceptions WHERE id = $1 AND company_id = $2 FOR UPDATE', [exceptionId, companyId])).rows[0];
  if (!e) throw fail(404, 'Exception not found');
  if (e.resolved) throw fail(409, 'It is closed already');
  await db.query('UPDATE exceptions SET resolved = true, resolved_by = $2, resolved_at = now(), resolve_note = $3 WHERE id = $1', [exceptionId, (actor && actor.name) || null, String(note).trim()]);
  const tx = (await db.query('SELECT internal_no FROM transactions WHERE id = $1', [e.transaction_id])).rows[0];
  await audit(db, actor, companyId, tx, 'exception closed', { field: e.type, reason: String(note).trim() });
}

/* The Bukku file of approved purchase bills. The batch is claimed in one statement (two people exporting at the same time can not both get it),
   checked once more, and made with the same file maker as the Purchases Bill page. Returns { workbook, txs }. */
async function exportPurchaseBills(db, companyId, ids, actor) {
  if (!isMgrRole(actor)) throw fail(403, 'Only the Owner or a Manager can export');
  if (!ids.length) throw fail(400, 'Nothing selected');
  const txs = (await db.query("SELECT * FROM transactions WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY tx_date, id", [companyId, ids])).rows;
  if (txs.length !== new Set(ids).size) throw fail(404, 'Some transactions were not found');
  const wrong = txs.filter((t) => t.status !== 'approved' || t.type !== 'purchase');
  if (wrong.length) throw fail(409, 'Only approved purchase bills can be exported: ' + wrong.slice(0, 5).map((t) => t.internal_no + ' (' + t.status + ')').join(', '));
  const ctx = await purchaseContext(db, companyId);
  for (const tx of txs) {   // the last check before the file: anything open stops it
    const issues = (await findIssues(db, tx, ctx)).filter(([type]) => type !== 'duplicate_no' || !(tx.data && tx.data.dupAck));
    const open = (await db.query('SELECT type FROM exceptions WHERE transaction_id = $1 AND NOT resolved', [tx.id])).rows;
    const resolved = new Set((await db.query('SELECT type, detail FROM exceptions WHERE transaction_id = $1 AND resolved', [tx.id])).rows.map((r) => r.type + '|' + (r.detail || '')));
    const fresh = issues.filter(([type, detail]) => !resolved.has(type + '|' + detail));
    if (open.length || fresh.length) throw fail(409, tx.internal_no + ' failed the last check before the export: ' + [...open.map((o) => o.type), ...fresh.map(([t]) => t)].join(', '));
  }
  const claimed = await db.query("UPDATE transactions SET status = 'exported', exported_at = now(), updated_at = now() WHERE company_id = $1 AND id = ANY($2::int[]) AND status = 'approved' RETURNING id", [companyId, txs.map((t) => t.id)]);
  if (claimed.rows.length !== txs.length) throw fail(409, 'Some were just exported by someone else: refresh and try again');
  for (const tx of txs) await audit(db, actor, companyId, tx, 'exported', { field: 'status', before: 'approved', after: 'exported' });
  const bills = txs.map((t) => ({
    supplier: (t.data && t.data.supplier) || t.counterparty, code: (t.data && t.data.code) || t.contact_code || '', no: (t.data && t.data.no) || '', ref: (t.data && t.data.ref) || '',
    bill_date: t.tx_date ? (t.tx_date.toISOString ? t.tx_date.toISOString().slice(0, 10) : String(t.tx_date).slice(0, 10)) : '', tags: (t.data && t.data.tags) || '', description: (t.data && t.data.description) || '', revised: !!(t.data && t.data.revised), lines: t.lines
  }));
  const workbook = buildPurchaseBillWorkbook({ bills, suppliers: ctx.suppliers, defaultAccount: ctx.defaultAccount });
  return { workbook, txs: txs.map((t) => t.id), bills };
}
async function recordExportFile(db, companyId, ids, fileName) {
  await db.query('UPDATE approvals SET export_file = $3, exported_at = now() WHERE company_id = $1 AND tx_ids && $2::int[] AND export_file IS NULL', [companyId, ids, fileName]);
}
async function releaseExport(db, companyId, ids) {   // the file could not be made: they go back to approved
  await db.query("UPDATE transactions SET status = 'approved', exported_at = NULL WHERE company_id = $1 AND id = ANY($2::int[]) AND status = 'exported'", [companyId, ids]);
}

module.exports = {
  STATUSES, NEXT, can, nextInternalNo, purchaseContext, findIssues, runChecks, move,
  syncPurchaseBills, importPurchaseTable, importBankTable, importBankLines, importHqBill, mapColumns, toIsoDate,
  classify, submit, sendBack, approve, reopen, resolveException, exportPurchaseBills, recordExportFile, releaseExport, getTx
};
