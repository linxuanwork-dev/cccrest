// 账目检查 (account check): the Owner picks a company and a period; the books are read from Bukku, written into the review prompt
// ({{...}} places), the prompt is sent to Claude and the JSON answer is kept. Nothing is changed in Bukku (read only).
const MAX_DETAIL = 1500;          // documents whose lines are read one by one
const MAX_PAGES = 60;             // a list is read up to 60 pages of 100
const PART_CAP = 90000;           // characters kept for one part of the prompt (the part says when it was cut)
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => (Number(n) || 0).toFixed(2);

const SOURCES = [
  { key: 'invoices', path: '/sales/invoices', label: 'Sales Invoice', detail: true },
  { key: 'salesCN', path: '/sales/credit_notes', label: 'Sales Credit Note', detail: true },
  { key: 'receipts', path: '/sales/payments', label: 'Receipt', detail: true },
  { key: 'bills', path: '/purchases/bills', label: 'Purchase Bill', detail: true },
  { key: 'purchaseCN', path: '/purchases/credit_notes', label: 'Purchase Credit Note', detail: true },
  { key: 'payments', path: '/purchases/payments', label: 'Payment', detail: true },
  { key: 'moneyIn', path: '/banking/incomes', label: 'Money In', detail: true },
  { key: 'moneyOut', path: '/banking/expenses', label: 'Money Out', detail: true },
  { key: 'transfers', path: '/banking/transfers', label: 'Transfer', detail: false },
  { key: 'journals', path: '/journal_entries', label: 'Journal', detail: true }
];

async function pageAll(get, path, query) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(path, Object.assign({}, query, { page, page_size: 100 }));
    const rows = (body && body.transactions) || [];
    out.push(...rows);
    const total = body && body.paging && body.paging.total != null ? Number(body.paging.total) : null;
    if (!rows.length || rows.length < 100 || (total != null && out.length >= total)) break;
  }
  return out;
}

async function inBatches(list, size, fn) {
  for (let i = 0; i < list.length; i += size) await Promise.all(list.slice(i, i + size).map(fn));
}

const monthsBack = (ymd, n) => { const [y, m] = ymd.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-01'; };
const dayBefore = (ymd) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// one document (the list row + the detail) -> a small plain object
function slim(row, detail, src) {
  const d = detail || {};
  const lines = (d.form_items || []).map((l) => ({ acc: clip(l.account_name || l.account_id, 60), amt: r2(l.amount != null ? l.amount : l.net_amount), tax: r2(l.tax_amount), desc: clip(l.description || l.product_name, 60) })).filter((l) => l.acc || l.amt);
  const deposits = (d.deposit_items || []).map((l) => ({ acc: clip(l.account_name || l.account_id, 60), amt: r2(l.amount) }));
  const links = (d.link_items || []).map((l) => ({ no: clip(l.number, 40), amt: r2(l.amount), bal: l.balance == null ? null : r2(l.balance) }));
  let journal = '';
  if (src.key === 'journals' && d) { const arr = d.journal_items || d.items || d.lines || d.form_items || []; journal = JSON.stringify(arr).slice(0, 600); }
  return {
    id: row.id, no: clip(row.number, 40), no2: clip(row.number2, 40), date: String(row.date || '').slice(0, 10), contact: clip(row.contact_name, 60), amount: r2(row.amount != null ? row.amount : d.amount),
    status: clip(row.status, 12), remark: clip(d.description || d.remarks || row.title || row.internal_note, 100), lines, deposits, links, journal, balance: d.balance == null ? null : r2(d.balance)
  };
}

// get(path, query) -> parsed JSON body. progress(text). Returns everything read from Bukku.
async function collect({ get, from, to, progress }) {
  const say = progress || (() => {});
  const data = { from, to, period: {}, history: {}, accounts: [], outstanding: { invoices: [], bills: [] }, notes: [] };
  let detailBudget = MAX_DETAIL;
  for (const src of SOURCES) {
    say('读取 ' + src.label + '…');
    let rows = [];
    try { rows = await pageAll(get, src.path, { date_from: from, date_to: to }); } catch (e) { data.notes.push(src.label + ' 读取失败：' + e.message); continue; }
    const items = rows.map((r) => ({ row: r }));
    if (src.detail) {
      const todo = items.slice(0, Math.max(0, detailBudget));
      if (items.length > todo.length) data.notes.push(src.label + ' 有 ' + items.length + ' 张，只读了其中 ' + todo.length + ' 张的明细行（Bukku 每分钟限 600 次请求）');
      detailBudget -= todo.length;
      let done = 0;
      await inBatches(todo, 6, async (it) => {
        try { const b = await get(src.path + '/' + encodeURIComponent(it.row.id)); it.detail = b && b.transaction; } catch (e) { it.err = true; }
        done++; if (done % 40 === 0) say('读取 ' + src.label + ' 明细 ' + done + ' / ' + todo.length + '…');
      });
    }
    data.period[src.key] = items.map((it) => slim(it.row, it.detail, src));
  }
  // history: the 6 months before the period, headers only (who was paid / invoiced, how much, how often)
  const hFrom = monthsBack(from, 6), hTo = dayBefore(from);
  for (const key of ['bills', 'invoices', 'moneyOut']) {
    const src = SOURCES.find((s) => s.key === key); say('读取过去 6 个月的 ' + src.label + '（比较用）…');
    try { data.history[key] = (await pageAll(get, src.path, { date_from: hFrom, date_to: hTo })).map((r) => slim(r, null, src)); } catch (e) { data.notes.push('过去 6 个月的 ' + src.label + ' 读取失败：' + e.message); }
  }
  say('读取科目…');
  try { const b = await get('/accounts', {}); data.accounts = ((b && b.accounts) || []).map((a) => ({ code: a.code, name: a.name, type: a.type, balance: a.balance == null ? null : r2(a.balance) })); } catch (e) { data.notes.push('科目读取失败：' + e.message); }
  // everything not yet paid (aging)
  for (const [key, path] of [['invoices', '/sales/invoices'], ['bills', '/purchases/bills']]) {
    say('读取未付的 ' + (key === 'invoices' ? 'Invoice' : 'Bill') + '…');
    try {
      const list = (await pageAll(get, path, { payment_status: 'OUTSTANDING' })).filter((t) => !t.status || t.status === 'ready');
      const need = list.filter((t) => t.balance == null).slice(0, 800);
      await inBatches(need, 6, async (t) => { try { const b = await get(path + '/' + encodeURIComponent(t.id)); if (b && b.transaction && b.transaction.balance != null) t.balance = b.transaction.balance; } catch (e) { /* the balance stays unknown */ } });
      data.outstanding[key] = list.map((t) => ({ no: clip(t.number, 40), date: String(t.date || '').slice(0, 10), contact: clip(t.contact_name, 60), amount: r2(t.amount), balance: t.balance == null ? null : r2(t.balance) }));
    } catch (e) { data.notes.push('未付 ' + key + ' 读取失败：' + e.message); }
  }
  return data;
}

// ---------- the text of each part of the prompt ----------

function cap(text, label) { return text.length > PART_CAP ? text.slice(0, PART_CAP) + '\n…（' + label + ' 太长，只给了前面一部分）' : text; }
function table(head, rows) { return rows.length ? head.join('|') + '\n' + rows.map((r) => r.join('|')).join('\n') : ''; }

function docList(items, kind) {
  const withLinks = kind === 'payments' || kind === 'receipts';
  return table(['no', 'date', 'contact', 'amount', 'status', 'ref'].concat(withLinks ? ['knock-off(单号:金额)'] : []).concat(kind === 'doc' ? ['lines(科目:金额)'] : []),
    items.map((x) => [x.no, x.date, x.contact, num(x.amount), x.status, x.no2 || x.remark].concat(withLinks ? [x.links.map((l) => l.no + ':' + num(l.amt)).join('; ') || '（没有 knock 到任何单）'] : []).concat(kind === 'doc' ? [x.lines.map((l) => l.acc + ':' + num(l.amt) + (l.tax ? '(税' + num(l.tax) + ')' : '')).join('; ')] : [])));
}

function glText(period) {
  const rows = [];
  const add = (label, items) => (items || []).forEach((x) => {
    if (x.lines.length) x.lines.forEach((l) => rows.push([x.date, label, x.no, x.contact, l.acc, num(l.amt), l.tax ? num(l.tax) : '', l.desc || x.remark, x.status]));
    else if (x.deposits.length) x.deposits.forEach((l) => rows.push([x.date, label, x.no, x.contact, l.acc, num(l.amt), '', x.remark, x.status]));
    else if (x.journal) rows.push([x.date, label, x.no, x.contact, x.journal, num(x.amount), '', x.remark, x.status]);
    else rows.push([x.date, label, x.no, x.contact, '', num(x.amount), '', x.remark, x.status]);
  });
  SOURCES.forEach((s) => add(s.label, period[s.key]));
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return table(['date', 'type', 'no', 'contact', 'account', 'amount', 'tax', 'description', 'status'], rows);
}

function historyText(h) {
  const out = [];
  for (const [key, label] of [['bills', 'Purchase Bill'], ['moneyOut', 'Money Out'], ['invoices', 'Sales Invoice']]) {
    const by = new Map();
    (h[key] || []).filter((x) => x.status !== 'void').forEach((x) => { const k = (x.contact || '(none)') + '|' + x.date.slice(0, 7); const e = by.get(k) || { n: 0, sum: 0, max: 0 }; e.n++; e.sum += x.amount; e.max = Math.max(e.max, x.amount); by.set(k, e); });
    if (by.size) out.push('## ' + label + '（每个对方每个月：张数 / 合计 / 最大一张）\n' + table(['contact', 'month', 'count', 'total', 'max'], [...by.entries()].map(([k, e]) => { const [c, m] = k.split('|'); return [c, m, e.n, num(e.sum), num(e.max)]; }).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))));
  }
  return out.join('\n\n');
}

function tbText(accounts, period) {
  if (!accounts.length) return '';
  const move = new Map();
  SOURCES.forEach((s) => (period[s.key] || []).filter((x) => x.status !== 'void').forEach((x) => x.lines.forEach((l) => move.set(l.acc, r2((move.get(l.acc) || 0) + l.amt)))));
  return '## 各科目现在的余额（Bukku 给的是现在的余额，不是月底的）\n' + table(['code', 'name', 'type', 'balance_now'], accounts.map((a) => [a.code, a.name, a.type, a.balance == null ? '' : num(a.balance)])) +
    (move.size ? '\n\n## 本期各科目的单据金额合计（从上面的单据明细行加起来）\n' + table(['account', 'total_of_lines'], [...move.entries()].map(([k, v]) => [k, num(v)])) : '');
}

function agingText(list, today) {
  return table(['no', 'date', 'contact', 'amount', 'balance', 'days_old'], list.map((x) => [x.no, x.date, x.contact, num(x.amount), x.balance == null ? '(读不到)' : num(x.balance), x.date ? Math.round((new Date(today) - new Date(x.date)) / 86400000) : '']));
}

// the {{PLACE}} -> text map. `extra` = what the system keeps itself (settings, masters, settlement reports, whitelist, last issues)
function buildParts({ data, extra, mode, staff, today }) {
  const e = extra || {};
  const P = data.period;
  const parts = {
    CHECK_MODE: mode,
    CLIENT_SETTINGS: e.clientSettings || '',
    PERIOD: data.from + ' 至 ' + data.to,
    STAFF: staff || '',
    GL: glText(P),
    GL_HISTORY: historyText(data.history),
    TB: tbText(data.accounts, P),
    TB_PREV_APPROVED: '',
    SALES_INVOICES: docList(P.invoices.concat(P.salesCN || []), 'doc'),
    PURCHASE_BILLS: docList(P.bills.concat(P.purchaseCN || []), 'doc'),
    PAYMENTS: docList(P.payments || [], 'payments'),
    RECEIPTS: docList(P.receipts || [], 'receipts'),
    JOURNALS: docList(P.journals || [], 'plain'),
    DEBTOR_AGING: agingText(data.outstanding.invoices, today),
    CREDITOR_AGING: agingText(data.outstanding.bills, today),
    BANK_STATEMENT: e.bankStatement || '',
    SALARY_SUMMARY: e.salary || '',
    SETTLEMENT_REPORTS: e.settlement || '',
    PREPAYMENT_SCHEDULE: e.prepayments || '',
    ACCRUAL_SCHEDULE: e.accruals || '',
    WHITELIST: e.whitelist || '',
    PREVIOUS_ISSUES: e.previous || ''
  };
  const notes = [];
  for (const k of Object.keys(parts)) {
    if (typeof parts[k] === 'string' && parts[k].length > PART_CAP) { notes.push(k + ' 太长，只给了前面一部分'); parts[k] = cap(parts[k], k); }
    if (parts[k] === '' || parts[k] == null) parts[k] = '（没有提供）';
  }
  return { parts, notes };
}

function fillPrompt(template, parts) { return String(template).replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (m, k) => (k in parts ? parts[k] : m)); }

// ---------- Claude ----------

// streams the answer (long answers are asked for with streaming). Returns { text, usage }
async function callClaude({ apiKey, model, prompt, maxTokens, onText }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens || 16000, stream: true, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(14 * 60 * 1000)
  });
  if (!res.ok) { let msg = ''; try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* no body */ } throw new Error('AI 服务回应 ' + res.status + (msg ? '：' + msg : '')); }
  let text = '', usage = {}, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') continue;
      let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { text += ev.delta.text; if (onText) onText(text.length); }
      else if (ev.type === 'message_start' && ev.message && ev.message.usage) usage = Object.assign(usage, ev.message.usage);
      else if (ev.type === 'message_delta' && ev.usage) usage = Object.assign(usage, ev.usage);
      else if (ev.type === 'error') throw new Error('AI 服务出错：' + ((ev.error && ev.error.message) || 'unknown'));
    }
  }
  return { text, usage };
}

// the JSON object in the answer (the model may put it in a code fence)
function parseAnswer(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI 没有返回 JSON');
  let j;
  try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error('AI 返回的 JSON 读不了（可能被截断了）：' + e.message); }
  j.issues = Array.isArray(j.issues) ? j.issues : [];
  j.resolved_issues = Array.isArray(j.resolved_issues) ? j.resolved_issues : [];
  j.missing_data = Array.isArray(j.missing_data) ? j.missing_data : [];
  j.issues.forEach((x, i) => { if (x.id == null) x.id = i + 1; if (!['red', 'yellow', 'info'].includes(x.severity)) x.severity = 'yellow'; });
  const c = (s) => j.issues.filter((x) => x.severity === s).length, st = (s) => j.issues.filter((x) => x.recheck_status === s).length;
  j.summary = { red: c('red'), yellow: c('yellow'), info: c('info'), resolved: j.resolved_issues.length, still_open: st('still_open'), changed: st('changed'), new: st('new') };
  return j;
}

module.exports = { collect, buildParts, fillPrompt, callClaude, parseAnswer, SOURCES, monthsBack };
