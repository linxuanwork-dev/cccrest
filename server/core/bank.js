// Bank matching (phase 2; SPEC-system section 4 supplement). A bank line is a standard transaction (type 'bank', direction 'in' / 'out').
//  - it is matched to the documents it pays: one payment can pay several documents, one document can be paid in several parts (core: matches);
//  - or it gets another meaning (direct expense, other income, subcon, director, suspense); an internal transfer is paired with the other account's line;
//  - the system only SUGGESTS (amount, name, reference, date); a person confirms. The payer name that was matched once is remembered (payer_aliases).
// Money out is matched to purchase bills. Money in is matched to sales documents (they come with the Sales part: until then money in is given a meaning by hand).
const T = require('./transactions');
const settings = require('../lib/settings');

const { audit, fail, isMgrRole, r2, normName } = T;

const KINDS = {
  out: ['credit_purchase', 'cash_bill', 'direct_expense', 'subcon', 'internal_transfer', 'director', 'suspense'],
  in: ['credit_sales', 'daily_sales', 'other_income', 'internal_transfer', 'director', 'suspense']
};
const TARGET = { out: 'purchase', in: 'sales' };
const LOCKED = ['approved', 'exported'];
const EPS = 0.005;

/* ---------- names ---------- */
const STOP = new Set(['SDN', 'BHD', 'BERHAD', 'PLT', 'ENTERPRISE', 'ENT', 'TRADING', 'THE', 'CO', 'LTD', 'AND', 'DAN', 'IBG', 'GIRO', 'TRSF', 'TRANSFER', 'PAYMENT', 'DUITNOW', 'CR', 'DR', 'ONLINE', 'INSTANT', 'FPX', 'IBFT', 'PBB', 'PAY']);
const tokens = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9一-龥 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));
const nameKey = (s) => tokens(s).join(' ');
// 1 = the same, 0.85 = every word of the contact is in the bank text, 0.6 = most words overlap, 0 = nothing
function nameScore(bankText, contactName) {
  const a = tokens(bankText), b = tokens(contactName);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  const sa = new Set(a);
  if (b.every((w) => sa.has(w))) return 0.85;
  const inter = b.filter((w) => sa.has(w)).length, union = new Set([...a, ...b]).size;
  return inter / union >= 0.6 ? 0.6 : 0;
}
const alnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- what is still to pay ---------- */
async function outstanding(db, companyId, type) {
  const { rows } = await db.query(
    `SELECT t.id, t.internal_no, t.tx_date, t.amount, t.counterparty, t.contact_code, t.status, t.data,
            t.amount - COALESCE((SELECT sum(m.applied) FROM matches m WHERE m.other_tx_id = t.id AND NOT m.voided), 0) AS outstanding
       FROM transactions t WHERE t.company_id = $1 AND t.type = $2
       ORDER BY t.tx_date, t.id`, [companyId, type]);
  return rows.map((r) => ({ id: r.id, internalNo: r.internal_no, date: r.tx_date ? String(r.tx_date).slice(0, 10) : '', amount: Number(r.amount), counterparty: r.counterparty || '', contactCode: r.contact_code || '',
    billNo: (r.data && r.data.no) || '', status: r.status, outstanding: r2(r.outstanding) })).filter((r) => r.outstanding > EPS);
}

async function aliasesOf(db, companyId, side) {
  return (await db.query('SELECT alias, contact_name, contact_code FROM payer_aliases WHERE company_id = $1 AND side = $2', [companyId, side])).rows;
}

// the groups of documents (of one contact) whose outstanding amounts add up to `amount` (at most 8 documents, at most 5000 tries)
function subsetsSumming(docs, amount) {
  const out = []; let tries = 0;
  const go = (i, picked, sum) => {
    if (tries++ > 5000 || out.length >= 3) return;
    if (Math.abs(sum - amount) < EPS && picked.length) { out.push(picked.slice()); return; }
    if (i >= docs.length || sum > amount + EPS || picked.length >= 8) return;
    picked.push(docs[i]); go(i + 1, picked, r2(sum + docs[i].outstanding)); picked.pop(); go(i + 1, picked, sum);
  };
  go(0, [], 0); return out;
}

/* ---------- suggestions for one bank line ---------- */
async function suggest(db, companyId, bankId) {
  const bank = await T.getTx(db, companyId, bankId);
  if (bank.type !== 'bank') throw fail(400, 'Only a bank line can be matched');
  const dir = bank.direction || 'in';
  const docs = await outstanding(db, companyId, TARGET[dir]);
  const aliases = await aliasesOf(db, companyId, dir);
  const text = [bank.counterparty, bank.source_ref].filter(Boolean).join(' ');
  const used = Number((await db.query('SELECT COALESCE(sum(applied + fee), 0) AS s FROM matches WHERE bank_tx_id = $1 AND NOT voided', [bank.id])).rows[0].s);
  const left = r2(Number(bank.amount) - used);
  const bankDate = bank.tx_date ? String(bank.tx_date).slice(0, 10) : '';
  const byContact = new Map();
  docs.forEach((d) => { const k = nameKey(d.counterparty) || d.counterparty; if (!byContact.has(k)) byContact.set(k, []); byContact.get(k).push(d); });
  const aliasHit = aliases.find((a) => nameKey(a.alias) && nameKey(a.alias) === nameKey(bank.counterparty));
  const out = [];
  const refKey = alnum(text);
  const make = (picked, contact, why) => {
    const total = r2(picked.reduce((s, d) => s + d.outstanding, 0));
    let score = 0; const reasons = [...why];
    const ns = aliasHit && nameKey(aliasHit.contact_name) === nameKey(contact) ? 1 : nameScore(text, contact);
    if (aliasHit && ns === 1 && nameKey(aliasHit.contact_name) === nameKey(contact)) { score += 55; reasons.push('the payer name was matched to this ' + (dir === 'out' ? 'supplier' : 'customer') + ' before'); }
    else if (ns === 1) { score += 50; reasons.push('the name is the same'); }
    else if (ns >= 0.85) { score += 42; reasons.push('the name is in the bank text'); }
    else if (ns >= 0.6) { score += 25; reasons.push('the name looks alike'); }
    if (Math.abs(total - left) < EPS) { score += 40; reasons.push(picked.length > 1 ? 'the ' + picked.length + ' documents add up to the amount' : 'the amount is the same'); }
    else if (total > left + EPS && picked.length === 1) { score += 12; reasons.push('part payment of a bigger document'); }
    const refHit = picked.find((d) => d.billNo && alnum(d.billNo).length >= 3 && refKey.includes(alnum(d.billNo)));
    if (refHit) { score += 30; reasons.push('the bill number ' + refHit.billNo + ' is in the reference'); }
    const dates = picked.map((d) => d.date).filter(Boolean).sort();
    if (bankDate && dates.length) { if (bankDate >= dates[dates.length - 1]) score += 5; else { score -= 10; reasons.push('paid before the bill date'); } }
    const allocations = []; let rest = left;
    for (const d of picked) { const a = r2(Math.min(d.outstanding, rest)); if (a > EPS) { allocations.push({ txId: d.id, internalNo: d.internalNo, billNo: d.billNo, counterparty: d.counterparty, outstanding: d.outstanding, amount: a }); rest = r2(rest - a); } }
    return { contact, txIds: picked.map((d) => d.id), allocations, total, diff: r2(left - allocations.reduce((s, a) => s + a.amount, 0)), confidence: Math.max(0, Math.min(100, score)), reasons };
  };
  if (left > EPS) {
    for (const [contact, list] of byContact) {
      const ns = (aliasHit && nameKey(aliasHit.contact_name) === nameKey(contact)) ? 1 : nameScore(text, contact);
      const exact = list.filter((d) => Math.abs(d.outstanding - left) < EPS);
      exact.forEach((d) => out.push(make([d], contact, [])));
      if (!exact.length && list.length > 1 && (ns >= 0.6 || refKey)) subsetsSumming(list, left).forEach((g) => out.push(make(g, contact, [])));
      if (ns >= 0.85) list.filter((d) => d.outstanding > left + EPS).slice(0, 2).forEach((d) => out.push(make([d], contact, [])));   // a part payment of a known supplier
      const hit = list.find((d) => d.billNo && alnum(d.billNo).length >= 3 && refKey.includes(alnum(d.billNo)));
      if (hit && !out.some((o) => o.txIds.includes(hit.id))) out.push(make([hit], contact, []));
    }
  }
  const seen = new Set(); const uniq = out.filter((o) => { const k = o.txIds.slice().sort().join(','); if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((a, b) => b.confidence - a.confidence);
  const best = uniq.filter((o) => o.confidence >= 40).slice(0, 5).map((o) => Object.assign(o, { level: o.confidence >= 85 ? 'high' : o.confidence >= 55 ? 'medium' : 'low' }));
  return { bank: { id: bank.id, internalNo: bank.internal_no, direction: dir, amount: Number(bank.amount), left, payer: bank.counterparty || '', ref: bank.source_ref || '', date: bankDate }, suggestions: best };
}

/* ---------- match ---------- */
async function lockedBank(db, companyId, bankId) {
  const bank = await T.getTx(db, companyId, bankId, true);
  if (bank.type !== 'bank') throw fail(400, 'Only a bank line can be matched');
  if (LOCKED.includes(bank.status)) throw fail(409, bank.internal_no + ' is ' + bank.status + ': open it again first (the Owner)');
  return bank;
}

/* input: { allocations: [{ txId, amount }], fee (the part of the bank amount that is a bank charge), note, learnAlias (default true), suggested } */
async function matchBank(db, companyId, bankId, input, actor) {
  const bank = await lockedBank(db, companyId, bankId);
  const dir = bank.direction || 'in'; const target = TARGET[dir];
  const allocs = (input.allocations || []).map((a) => ({ txId: parseInt(a.txId, 10), amount: r2(a.amount) })).filter((a) => a.txId);
  if (!allocs.length) throw fail(400, 'Choose at least one ' + (dir === 'out' ? 'bill' : 'sales document') + ' to match');
  if (allocs.some((a) => !(a.amount > 0))) throw fail(400, 'Every amount must be above 0');
  const fee = r2(input.fee || 0); if (fee < 0) throw fail(400, 'The bank charge can not be negative');
  const already = Number((await db.query('SELECT COALESCE(sum(applied + fee), 0) AS s FROM matches WHERE bank_tx_id = $1 AND NOT voided', [bank.id])).rows[0].s);
  const total = r2(allocs.reduce((s, a) => s + a.amount, 0));
  if (r2(already + total + fee) > Number(bank.amount) + EPS) throw fail(409, 'The matched amounts (' + r2(already + total + fee).toFixed(2) + ') are more than the bank line (' + Number(bank.amount).toFixed(2) + ')');
  const docs = [];
  for (const a of allocs) {
    const d = (await db.query('SELECT * FROM transactions WHERE id = $1 AND company_id = $2 FOR UPDATE', [a.txId, companyId])).rows[0];
    if (!d || d.type !== target) throw fail(404, 'Document ' + a.txId + ' is not a ' + target + ' document of this company');
    const paid = Number((await db.query('SELECT COALESCE(sum(applied), 0) AS s FROM matches WHERE other_tx_id = $1 AND NOT voided', [d.id])).rows[0].s);
    const out = r2(Number(d.amount) - paid);
    if (a.amount > out + EPS) throw fail(409, d.internal_no + ' has only ' + out.toFixed(2) + ' left to ' + (dir === 'out' ? 'pay' : 'collect') + ', not ' + a.amount.toFixed(2));
    docs.push({ d, a });
  }
  for (const [i, { d, a }] of docs.entries()) {
    await db.query('INSERT INTO matches (company_id, bank_tx_id, other_tx_id, method, diff, applied, fee, note, suggested, created_by) VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9)',
      [companyId, bank.id, d.id, input.suggested ? 'auto' : 'manual', a.amount, i === 0 ? fee : 0, input.note || null, !!input.suggested, (actor && actor.name) || null]);
    await audit(db, actor, companyId, bank, 'matched', { field: 'document', after: d.internal_no + ' ' + a.amount.toFixed(2), reason: input.suggested ? 'the suggestion was confirmed' : input.note });
    await audit(db, actor, companyId, d, 'paid', { field: 'bank line', after: bank.internal_no + ' ' + a.amount.toFixed(2) });
  }
  const first = docs[0].d;
  await db.query('UPDATE transactions SET contact_code = COALESCE(contact_code, $2), updated_at = now() WHERE id = $1', [bank.id, first.contact_code || null]);
  // remember the payer name: the next time the same name is suggested with confidence
  const payerKey = nameKey(bank.counterparty);
  if (input.learnAlias !== false && payerKey && nameKey(first.counterparty) !== payerKey && nameScore(bank.counterparty, first.counterparty) < 1) {
    const r = await db.query('INSERT INTO payer_aliases (company_id, side, alias, contact_name, contact_code, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (company_id, side, alias) DO NOTHING RETURNING id',
      [companyId, dir, bank.counterparty, first.counterparty, first.contact_code || null, (actor && actor.name) || null]);
    if (r.rows[0]) await audit(db, actor, companyId, bank, 'alias remembered', { field: 'payer', before: bank.counterparty, after: first.counterparty });
  }
  const left = r2(Number(bank.amount) - already - total - fee);
  const cur = (await db.query('SELECT * FROM transactions WHERE id = $1', [bank.id])).rows[0];
  if (Math.abs(left) < EPS) {
    if (T.can(cur.status, 'matched')) await T.move(db, cur, 'matched', actor, 'matched to ' + docs.map(({ d }) => d.internal_no).join(', '));
    if (T.can(cur.status, 'classified')) await T.move(db, cur, 'classified', actor, 'the documents are known');
  }
  const feeSum = Number((await db.query('SELECT COALESCE(sum(fee), 0) AS s FROM matches WHERE bank_tx_id = $1 AND NOT voided', [bank.id])).rows[0].s);
  return { bankId: bank.id, matched: r2(already + total + fee - feeSum), fee: r2(feeSum), left, status: cur.status };
}

// the system's best suggestion for each line that is still open: only those that cover the whole amount and are sure (confidence) are applied, and only when a person asks
async function confirmSuggestions(db, companyId, bankIds, actor, minConfidence) {
  const min = Number.isFinite(+minConfidence) ? +minConfidence : 85; const done = [], skipped = [];
  for (const id of bankIds) {
    const r = await suggest(db, companyId, id);
    const top = r.suggestions[0];
    if (!top) { skipped.push({ id, reason: 'no suggestion' }); continue; }
    if (top.confidence < min) { skipped.push({ id, reason: 'not sure enough (' + top.confidence + ')' }); continue; }
    if (Math.abs(top.diff) >= EPS) { skipped.push({ id, reason: 'does not cover the whole amount' }); continue; }
    if (r.suggestions[1] && r.suggestions[1].confidence >= top.confidence - 5) { skipped.push({ id, reason: 'two suggestions are as good: choose by hand' }); continue; }
    await matchBank(db, companyId, id, { allocations: top.allocations.map((a) => ({ txId: a.txId, amount: a.amount })), suggested: true }, actor); done.push(id);
  }
  return { matched: done, skipped };
}

/* ---------- undo (a match is never deleted: it is voided with who, when and why) ---------- */
async function unmatch(db, companyId, matchId, actor, reason) {
  if (String(reason || '').trim().length < 3) throw fail(400, 'A reason is required');
  const m = (await db.query('SELECT * FROM matches WHERE id = $1 AND company_id = $2 FOR UPDATE', [matchId, companyId])).rows[0];
  if (!m) throw fail(404, 'Match not found'); if (m.voided) throw fail(409, 'It is undone already');
  const ids = m.note && /^TRANSFER /.test(m.note) ? [m.bank_tx_id, m.other_tx_id] : [m.bank_tx_id];
  for (const id of ids) { const b = await T.getTx(db, companyId, id, true); if (LOCKED.includes(b.status)) throw fail(409, b.internal_no + ' is ' + b.status + ': open it again first (the Owner)'); }
  await db.query('UPDATE matches SET voided = true, voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1', [matchId, (actor && actor.name) || null, String(reason).trim()]);
  for (const id of ids) {
    const b = await T.getTx(db, companyId, id, true);
    await audit(db, actor, companyId, b, 'unmatched', { field: 'match', before: String(matchId), reason: String(reason).trim() });
    if (['matched', 'classified', 'in_review'].includes(b.status)) {
      if (b.status === 'in_review') await T.move(db, b, 'classified', actor, 'the match was undone');
      if (T.can(b.status, 'pending')) await T.move(db, b, 'pending', actor, 'the match was undone');
    }
    if (ids.length > 1) { const d = Object.assign({}, b.data || {}); delete d.kind; delete d.transferNo; await db.query('UPDATE transactions SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(d)]); }
  }
  return { ok: true };
}

/* ---------- a line that is not a payment of a document ---------- */
async function setKind(db, companyId, bankId, body, actor) {
  const bank = await lockedBank(db, companyId, bankId); const dir = bank.direction || 'in';
  const kind = String(body.kind || '');
  if (!KINDS[dir].includes(kind)) throw fail(400, 'For money ' + dir + ' the kind must be one of: ' + KINDS[dir].join(', '));
  if (['credit_purchase', 'credit_sales', 'daily_sales'].includes(kind)) throw fail(400, 'This kind is a payment of documents: use "match" and choose the documents');
  if (kind === 'internal_transfer') throw fail(400, 'An internal transfer is paired with the line of the other bank account: use "pair transfer"');
  const acc = String(body.account || '').trim() || (kind === 'suspense' ? String(await settings.get(companyId, 'suspense_account', null, db) || '') : kind === 'director' ? String(await settings.get(companyId, 'director_account', null, db) || '') : '');
  const contact = String(body.contact_code || '').trim(), name = String(body.contact_name || '').trim(), ic = String(body.payee_ic || '').trim();
  if (['direct_expense', 'other_income', 'cash_bill', 'suspense', 'director'].includes(kind) && !acc) throw fail(400, 'An account is required' + (kind === 'suspense' ? ' (or set "suspense_account" in the company settings)' : kind === 'director' ? ' (or set "director_account" in the company settings)' : ''));
  if (['cash_bill', 'subcon'].includes(kind) && !contact && !name) throw fail(400, 'The supplier / payee is required');
  if (kind === 'subcon' && !ic) throw fail(400, 'A payee needs an IC / passport number (payee_ic)');
  const applied = Number((await db.query('SELECT COALESCE(sum(applied + fee), 0) AS s FROM matches WHERE bank_tx_id = $1 AND NOT voided', [bank.id])).rows[0].s);
  if (applied > EPS) throw fail(409, 'This line is matched to documents already: undo the match first');
  const data = Object.assign({}, bank.data || {}, { kind }); if (name) data.contactName = name; if (ic) data.payeeIc = ic; if (body.note) data.note = String(body.note);
  await db.query('UPDATE transactions SET account = $2, contact_code = COALESCE(NULLIF($3, \'\'), contact_code), data = $4::jsonb, updated_at = now() WHERE id = $1', [bank.id, acc || null, contact, JSON.stringify(data)]);
  await audit(db, actor, companyId, bank, 'classified', { field: 'kind', before: (bank.data && bank.data.kind) || '', after: kind + (acc ? ' / ' + acc : ''), reason: body.note });
  const cur = (await db.query('SELECT * FROM transactions WHERE id = $1', [bank.id])).rows[0];
  if (T.can(cur.status, 'classified')) await T.move(db, cur, 'classified', actor, 'given a meaning by hand: ' + kind);
  return (await db.query('SELECT * FROM transactions WHERE id = $1', [bank.id])).rows[0];
}

/* ---------- internal transfers: one number, recorded once, the other account's line is paired ---------- */
async function transferCandidates(db, companyId, bankId) {
  const b = await T.getTx(db, companyId, bankId);
  if (b.type !== 'bank') throw fail(400, 'Only a bank line can be paired');
  const dir = b.direction === 'out' ? 'in' : 'out';
  const { rows } = await db.query(
    `SELECT id, internal_no, tx_date, amount, counterparty, source_ref, bank_account, status FROM transactions
      WHERE company_id = $1 AND type = 'bank' AND direction = $2 AND id <> $3 AND status IN ('imported', 'pending')
        AND abs(amount - $4) < 0.005 AND tx_date BETWEEN $5::date - 3 AND $5::date + 3
        AND NOT EXISTS (SELECT 1 FROM matches m WHERE NOT m.voided AND (m.bank_tx_id = transactions.id OR m.other_tx_id = transactions.id))
      ORDER BY abs(tx_date - $5::date), id`, [companyId, dir, bankId, b.amount, b.tx_date]);
  return rows.filter((r) => !(r.bank_account && b.bank_account && r.bank_account === b.bank_account)).map((r) => ({ id: r.id, internalNo: r.internal_no, date: String(r.tx_date).slice(0, 10), amount: Number(r.amount), counterparty: r.counterparty || '', ref: r.source_ref || '', bankAccount: r.bank_account || '' }));
}
async function pairTransfer(db, companyId, aId, bId, actor, note) {
  const a = await lockedBank(db, companyId, aId), b = await lockedBank(db, companyId, bId);
  const out = a.direction === 'out' ? a : b, inn = a.direction === 'out' ? b : a;
  if (out.direction !== 'out' || inn.direction !== 'in') throw fail(400, 'A transfer pairs one money-out line with one money-in line');
  if (Math.abs(Number(out.amount) - Number(inn.amount)) >= EPS) throw fail(409, 'The two amounts are not the same (' + Number(out.amount).toFixed(2) + ' and ' + Number(inn.amount).toFixed(2) + '): a bank charge is a separate line');
  if (out.bank_account && inn.bank_account && out.bank_account === inn.bank_account) throw fail(409, 'Both lines are in the same bank account');
  const days = Math.abs((new Date(out.tx_date) - new Date(inn.tx_date)) / 86400000);
  if (days > 5) throw fail(409, 'The two lines are ' + Math.round(days) + ' days apart (more than 5): check them');
  for (const x of [out, inn]) {
    const used = (await db.query('SELECT 1 FROM matches WHERE NOT voided AND (bank_tx_id = $1 OR other_tx_id = $1) LIMIT 1', [x.id])).rows[0];
    if (used) throw fail(409, x.internal_no + ' is matched already');
  }
  const month = String(out.tx_date).slice(0, 7);
  const n = (await db.query("INSERT INTO tx_counters (company_id, key, n) VALUES ($1, $2, 1) ON CONFLICT (company_id, key) DO UPDATE SET n = tx_counters.n + 1 RETURNING n", [companyId, 'TRF-' + month])).rows[0].n;
  const transferNo = 'TRF-' + month + '-' + String(n).padStart(4, '0');
  await db.query("INSERT INTO matches (company_id, bank_tx_id, other_tx_id, method, applied, note, created_by) VALUES ($1,$2,$3,'manual',$4,$5,$6)", [companyId, out.id, inn.id, out.amount, 'TRANSFER ' + transferNo + (note ? ' - ' + note : ''), (actor && actor.name) || null]);
  for (const x of [out, inn]) {
    const d = Object.assign({}, x.data || {}, { kind: 'internal_transfer', transferNo });
    await db.query('UPDATE transactions SET data = $2::jsonb, updated_at = now() WHERE id = $1', [x.id, JSON.stringify(d)]);
    await audit(db, actor, companyId, x, 'transfer paired', { field: 'transfer', after: transferNo + ' (' + out.internal_no + ' -> ' + inn.internal_no + ')', reason: note });
    const cur = (await db.query('SELECT * FROM transactions WHERE id = $1', [x.id])).rows[0];
    if (T.can(cur.status, 'matched')) await T.move(db, cur, 'matched', actor, 'internal transfer ' + transferNo);
    if (T.can(cur.status, 'classified')) await T.move(db, cur, 'classified', actor, 'internal transfer ' + transferNo);
  }
  return { transferNo, outId: out.id, inId: inn.id };
}

/* ---------- what needs looking at (not stored: worked out when asked) ---------- */
async function prompts(db, companyId, opts) {
  const days = (opts && opts.days) || 7; const out = [];
  const old = (await db.query(
    `SELECT id, internal_no, tx_date, amount, direction, counterparty, status, data, (current_date - tx_date) AS age FROM transactions
      WHERE company_id = $1 AND type = 'bank' AND status IN ('imported', 'pending') AND (current_date - tx_date) > $2 ORDER BY tx_date`, [companyId, days])).rows;
  old.forEach((r) => out.push({ type: 'bank_unmatched', id: r.id, internalNo: r.internal_no, age: r.age, text: 'Money ' + r.direction + ' ' + Number(r.amount).toFixed(2) + (r.counterparty ? ' (' + r.counterparty + ')' : '') + ' has had no meaning for ' + r.age + ' days' }));
  const susp = (await db.query("SELECT id, internal_no, tx_date, amount, direction, (current_date - tx_date) AS age FROM transactions WHERE company_id = $1 AND type = 'bank' AND data->>'kind' = 'suspense' AND status NOT IN ('exported') ORDER BY tx_date", [companyId])).rows;
  susp.forEach((r) => out.push({ type: 'in_suspense', id: r.id, internalNo: r.internal_no, age: r.age, text: 'Money ' + r.direction + ' ' + Number(r.amount).toFixed(2) + ' is in suspense since ' + String(r.tx_date).slice(0, 10) }));
  const unpaid = (await outstanding(db, companyId, 'purchase')).filter((d) => d.date && (Date.now() - new Date(d.date)) / 86400000 > 60);
  unpaid.forEach((d) => out.push({ type: 'bill_unpaid', id: d.id, internalNo: d.internalNo, age: Math.round((Date.now() - new Date(d.date)) / 86400000), text: 'Bill ' + (d.billNo || d.internalNo) + ' of ' + d.counterparty + ' has ' + d.outstanding.toFixed(2) + ' not paid, dated ' + d.date }));
  return out;
}

/* ---------- the bank report (every line, what it is matched to, what is left) ---------- */
async function bankReport(db, companyId, filters) {
  const where = ["t.company_id = $1", "t.type = 'bank'"]; const args = [companyId];
  if (filters && filters.status) { args.push(String(filters.status).split(',')); where.push('t.status = ANY($' + args.length + '::text[])'); }
  if (filters && /^\d{4}-\d{2}$/.test(String(filters.month || ''))) { args.push(filters.month); where.push("to_char(t.tx_date, 'YYYY-MM') = $" + args.length); }
  if (filters && (filters.direction === 'in' || filters.direction === 'out')) { args.push(filters.direction); where.push('t.direction = $' + args.length); }
  const rows = (await db.query(
    `SELECT t.*, COALESCE((SELECT sum(m.applied) FROM matches m WHERE m.bank_tx_id = t.id AND NOT m.voided), 0) AS applied,
            COALESCE((SELECT sum(m.fee) FROM matches m WHERE m.bank_tx_id = t.id AND NOT m.voided), 0) AS fee_sum,
            (SELECT string_agg(o.internal_no || ' ' || m.applied::text, '; ' ORDER BY m.id) FROM matches m JOIN transactions o ON o.id = m.other_tx_id WHERE m.bank_tx_id = t.id AND NOT m.voided) AS matched_to
       FROM transactions t WHERE ${where.join(' AND ')} ORDER BY t.tx_date, t.id`, args)).rows;
  return rows.map((t) => {
    const fee = Number(t.fee_sum), applied = Number(t.applied), isTransfer = t.data && t.data.kind === 'internal_transfer';
    const accounted = isTransfer || (t.data && t.data.kind && !['credit_purchase', 'credit_sales', 'daily_sales'].includes(t.data.kind)) ? Number(t.amount) : r2(applied + fee);
    return { id: t.id, internalNo: t.internal_no, date: String(t.tx_date).slice(0, 10), account: t.bank_account || '', direction: t.direction, payer: t.counterparty || '', ref: t.source_ref || '', amount: Number(t.amount), status: t.status,
      kind: (t.data && t.data.kind) || (applied > EPS ? 'matched' : ''), matchedTo: t.matched_to || (isTransfer ? t.data.transferNo : '') || '', fee, left: r2(Number(t.amount) - accounted), accountCode: t.account || '' };
  });
}

module.exports = { KINDS, TARGET, nameKey, nameScore, outstanding, suggest, matchBank, confirmSuggestions, unmatch, setKind, transferCandidates, pairTransfer, prompts, bankReport };
