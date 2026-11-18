// 账目检查: the rules that can be worked out by a program (no AI). Input = what was read from Bukku (lib/acheck.js collect), the client settings and
// the masters; output = the same JSON as the AI answer (issues, resolved_issues, missing_data, summary). Every issue names its documents and amounts.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rm = (n) => 'RM' + num(n);
const live = (arr) => (arr || []).filter((x) => x.status !== 'void');
const ym = (d) => String(d || '').slice(0, 7);
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const sevOrder = { red: 0, yellow: 1, info: 2 };
const SRC = { invoices: 'Sales Invoice', salesCN: 'Sales Credit Note', receipts: 'Receipt', bills: 'Purchase Bill', purchaseCN: 'Purchase Credit Note', payments: 'Payment', moneyIn: 'Money In', moneyOut: 'Money Out', transfers: 'Transfer', journals: 'Journal' };
const STATUTORY = /KWSP|EPF|PERKESO|SOCSO|\bEIS\b|LHDN|HASIL|\bPCB\b|\bMTD\b|LEMBAGA HASIL/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthsIn(text) {   // the months a text talks about: names (Oct, October, Okt, Mac...) or 2026-10 / 10/2026
  const t = String(text || '').toLowerCase(), out = new Set();
  MONTHS.forEach((m, i) => { if (new RegExp('\\b' + m + '[a-z]*\\b').test(t) || (m === 'mar' && /\bmac\b/.test(t)) || (m === 'may' && /\bmei\b/.test(t)) || (m === 'oct' && /\bokt/.test(t)) || (m === 'dec' && /\bdis\b/.test(t))) out.add(i + 1); });
  let m; const re1 = /\b(20\d{2})[-\/](\d{1,2})\b/g, re2 = /\b(\d{1,2})[-\/](20\d{2})\b/g;
  while ((m = re1.exec(t))) { const n = Number(m[2]); if (n >= 1 && n <= 12) out.add(n); }
  while ((m = re2.exec(t))) { const n = Number(m[1]); if (n >= 1 && n <= 12) out.add(n); }
  return out;
}

function runRules({ data, client, extra, today }) {
  const P = data.period, H = data.history, e = extra || {};
  const issues = [], covered = new Set(), tol = client.tolerance > 0 ? client.tolerance : 0.05;
  const ev = (key, x, amt) => ({ source: SRC[key] || key, doc_no: x.no, date: x.date, party: x.contact, amount: amt != null ? amt : x.amount });
  const add = (rule, severity, category, title, detail, evidence, o) => issues.push(Object.assign({ rule_id: rule, severity, category, title, detail, evidence: evidence || [], amount_difference: null, calculation: '', suggested_check: '', fix_scope: 'simple', affects: [], recheck_status: 'new', previous_issue_id: null, recheck_note: '', needs_confirmation: true, by: 'program' }, o || {}));
  const ran = (...rules) => rules.forEach((r) => covered.add(r));
  const expDocs = () => live(P.bills).map((x) => ['bills', x]).concat(live(P.moneyOut).map((x) => ['moneyOut', x]));
  const histExp = (H.bills || []).concat(H.moneyOut || []).filter((x) => x.status !== 'void' && x.contact);
  const byContactHist = new Map(); histExp.forEach((x) => { const a = byContactHist.get(x.contact) || []; a.push(x); byContactHist.set(x.contact, a); });
  const hasHistory = histExp.length > 0;

  // ---------- A. unusual expenses ----------
  ran('A2', 'A4', 'A5', 'A6');
  if (hasHistory) {
    ran('A1');
    for (const [k, x] of expDocs()) {
      const h = byContactHist.get(x.contact); if (!x.contact || !h || h.length < 2) continue;
      const avg = h.reduce((a, y) => a + y.amount, 0) / h.length;
      if (x.amount > 3 * avg) add('A1', 'yellow', 'Unusual Expense', x.contact + ' ' + x.no + ' 比平时大很多', x.no + '（' + x.date + '）' + rm(x.amount) + '，这个对方过去 6 个月 ' + h.length + ' 张平均 ' + rm(avg) + '。', [ev(k, x)], { amount_difference: r2(x.amount - avg), calculation: rm(x.amount) + ' > 3 × ' + rm(avg) + ' = ' + rm(3 * avg), suggested_check: '看原始单据，确认金额和用途', affects: ['TB - Expenses'] });
    }
    const seenNew = new Set();
    for (const [k, x] of expDocs()) {
      if (!x.contact || byContactHist.has(x.contact) || seenNew.has(x.contact)) continue; seenNew.add(x.contact);
      const docs = expDocs().filter(([, y]) => y.contact === x.contact);
      add('A2', 'info', 'New Supplier', '新对方：' + x.contact, '过去 6 个月的 Purchase Bill / Money Out 里没有出现过 ' + x.contact + '，本期 ' + docs.length + ' 张，合计 ' + rm(docs.reduce((a, [, y]) => a + y.amount, 0)) + '。', docs.slice(0, 8).map(([kk, y]) => ev(kk, y)), { suggested_check: '确认这是真实的供应商，资料齐全' });
    }
  }
  for (const [k, x] of expDocs()) {
    if (x.amount >= 1000 && Number.isInteger(x.amount) && !x.no2) add('A4', 'yellow', 'Unusual Expense', x.no + ' 整数大额，没有对方的单号', x.no + '（' + x.date + '）' + x.contact + ' ' + rm(x.amount) + ' 是整数，也没有对方的 bill 单号（ref）。', [ev(k, x)], { suggested_check: '找原始单据，确认金额' });
    const flat = [x.remark].concat(x.lines.map((l) => l.desc + ' ' + l.acc)).join(' ');
    const m = flat.match(/\b(personal|director|cash|loan|private)\b/i);
    if (m) add('A6', 'yellow', 'Unusual Expense', x.no + ' 描述里有「' + m[1] + '」', x.no + '（' + x.date + '）' + x.contact + ' ' + rm(x.amount) + '，描述：' + flat.replace(/\s+/g, ' ').trim().slice(0, 150), [ev(k, x)], { suggested_check: '确认是不是公司的开销' });
    for (const l of x.lines) if (/donat|entertain|penalt|fine\b|compound|gift|sponsor|saman/i.test(l.acc) && l.amt > 0) add('A5', 'yellow', 'Unusual Expense', x.no + ' 记到 ' + l.acc, x.no + '（' + x.date + '）' + x.contact + ' ' + rm(l.amt) + ' 记到「' + l.acc + '」。（程序只能看科目名字，没有这个科目的历史，不能确定平时是不是 0）', [ev(k, x, l.amt)], { suggested_check: '确认这笔是不是该有' });
  }

  // ---------- B. double expenses ----------
  ran('B1', 'B2');
  const pairs = new Set();
  const bills = live(P.bills);
  for (let i = 0; i < bills.length; i++) for (let j = i + 1; j < bills.length; j++) {
    const a = bills[i], b = bills[j];
    if (a.contact && a.contact === b.contact && a.no2 && a.no2 === b.no2) { pairs.add(a.id + '|' + b.id); add('B1', 'red', 'Double Expense', a.contact + ' 单号 ' + a.no2 + ' 重复入账', a.no + '（' + a.date + '）和 ' + b.no + '（' + b.date + '）都是 ' + a.contact + ' 的单号 ' + a.no2 + '，金额 ' + rm(a.amount) + ' / ' + rm(b.amount) + '。', [ev('bills', a), ev('bills', b)], { amount_difference: Math.min(a.amount, b.amount), suggested_check: '看两张单的原始单据，确认是不是同一张 bill 进了两次', affects: ['Creditor Ledger', 'TB - Purchases', 'TB - Trade Creditors'] }); }
  }
  const ed = expDocs();
  for (let i = 0; i < ed.length; i++) for (let j = i + 1; j < ed.length; j++) {
    const [ka, a] = ed[i], [kb, b] = ed[j];
    if (!a.contact || a.contact !== b.contact || Math.abs(a.amount - b.amount) >= 0.005 || a.amount <= 0 || Math.abs(dayDiff(a.date, b.date)) > 7 || pairs.has(a.id + '|' + b.id)) continue;
    add('B2', 'yellow', 'Double Expense', a.contact + ' 同金额 7 天内出现两次（' + a.no + ' / ' + b.no + '）', a.no + '（' + a.date + '）和 ' + b.no + '（' + b.date + '）都是 ' + a.contact + ' ' + rm(a.amount) + '。', [ev(ka, a), ev(kb, b)], { amount_difference: a.amount, suggested_check: '确认是两次真实的交易，还是重复入账' });
  }

  // ---------- C. missing documents ----------
  if (hasHistory) {
    ran('C1');
    const months = [...new Set(histExp.map((x) => ym(x.date)))].sort(); const last3 = months.slice(-3);
    const periodContacts = new Set(expDocs().map(([, x]) => x.contact));
    for (const [c, arr] of byContactHist) {
      const ms = new Set(arr.map((x) => ym(x.date)));
      if (ms.size >= 4 && last3.filter((m) => ms.has(m)).length >= 2 && !periodContacts.has(c)) add('C1', 'red', 'Missing Document', c + ' 平时每个月都有，本期没有', c + ' 过去 6 个月里有 ' + ms.size + ' 个月出现过（最近三个月有 ' + last3.filter((m) => ms.has(m)).length + ' 个月），' + data.from + ' 至 ' + data.to + ' 没有任何 Purchase Bill / Money Out。', [{ source: '过去 6 个月', doc_no: '', date: [...ms].sort().join(', '), party: c, amount: r2(arr.reduce((a, y) => a + y.amount, 0) / arr.length) }], { suggested_check: '确认这个月的 bill 是不是还没进账（房租、电费、电话、软件等）', affects: ['TB - Expenses'] });
    }
  }
  const histInv = live(H.invoices);
  if (histInv.length) {
    ran('C2');
    const hDays = new Set(histInv.map((x) => x.date)); const first = histInv.map((x) => x.date).sort()[0], total = Math.max(1, dayDiff(data.from, first));
    if (hDays.size / total >= 0.6) {
      const days = new Set(live(P.invoices).map((x) => x.date)), miss = [];
      for (let d = new Date(data.from + 'T00:00:00Z'); d <= new Date(data.to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const s = d.toISOString().slice(0, 10); if (!days.has(s)) miss.push(s); }
      if (miss.length) add('C2', 'red', 'Missing Sales', miss.length + ' 天没有销售记录', '过去 6 个月 ' + Math.round(100 * hDays.size / total) + '% 的日子都有 Sales Invoice，本期这些日子没有：' + miss.slice(0, 40).join(', ') + (miss.length > 40 ? ' …' : ''), miss.slice(0, 30).map((d) => ({ source: 'Sales Invoice', doc_no: '', date: d, party: '', amount: 0 })), { suggested_check: '确认这些日子是休息，还是销售没有入账' });
    }
  }

  // ---------- D. document numbers ----------
  ran('D1', 'D2', 'D3');
  for (const key of ['invoices', 'salesCN', 'receipts', 'bills', 'purchaseCN', 'payments', 'moneyIn', 'moneyOut', 'journals']) {
    const groups = new Map();
    (P[key] || []).forEach((x) => { const m = /^(.*?)(\d+)$/.exec(x.no || ''); if (!m) return; const g = groups.get(m[1]) || []; g.push({ x, n: Number(m[2]), w: m[2].length, pre: m[1] }); groups.set(m[1], g); });
    for (const [pre, arr] of groups) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.n - b.n || (a.x.date < b.x.date ? -1 : 1));
      const seen = new Map(), dup = [];
      arr.forEach((a) => { if (seen.has(a.n)) dup.push([seen.get(a.n), a.x]); else seen.set(a.n, a.x); });
      dup.forEach(([a, b]) => add('D2', 'red', 'Document Number', SRC[key] + ' 号码 ' + a.no + ' 重复', a.no + ' 出现了两次：' + a.date + ' ' + a.contact + ' ' + rm(a.amount) + ' 和 ' + b.date + ' ' + b.contact + ' ' + rm(b.amount) + '。', [ev(key, a), ev(key, b)], { suggested_check: '确认是不是同一张单导入了两次，或号码用错' }));
      const uniq = [...seen.keys()].sort((a, b) => a - b), miss = [];
      for (let i = 1; i < uniq.length; i++) for (let n = uniq[i - 1] + 1; n < uniq[i] && miss.length < 60; n++) miss.push(pre + String(n).padStart(arr[0].w, '0'));
      if (miss.length) add('D1', 'red', 'Document Number', SRC[key] + ' ' + (pre || '(没有前缀)') + ' 跳号', '从 ' + pre + String(uniq[0]).padStart(arr[0].w, '0') + ' 到 ' + pre + String(uniq[uniq.length - 1]).padStart(arr[0].w, '0') + ' 之间没有这几个号码（也没有标明 void）：' + miss.slice(0, 40).join(', ') + (miss.length > 40 ? ' …' : ''), miss.slice(0, 20).map((n) => ({ source: SRC[key], doc_no: n, date: '', party: '', amount: 0 })), { suggested_check: '确认这些号码是作废了、在别的月份，还是漏了没有入账', amount_difference: null });
      const odd = []; let maxDate = ''; arr.forEach((a) => { if (maxDate && a.x.date < maxDate) odd.push(a.x); if (a.x.date > maxDate) maxDate = a.x.date; });
      if (odd.length) add('D3', 'yellow', 'Document Number', SRC[key] + ' ' + (pre || '') + ' 号码较后的单，日期反而较早', odd.length + ' 张：' + odd.slice(0, 12).map((x) => x.no + '（' + x.date + '）').join(', '), odd.slice(0, 12).map((x) => ev(key, x)), { suggested_check: '确认日期有没有打错，或者单是补做的' });
    }
  }

  // ---------- E / F. prepayment, accrual ----------
  const journalText = (P.journals || []).map((j) => [j.no, j.remark, j.contact, j.journal, j.lines.map((l) => l.acc + ' ' + l.desc).join(' ')].join(' ').toLowerCase());
  const mentioned = (item) => journalText.some((t) => t.includes(String(item).toLowerCase()));
  for (const x of live(P.bills).map((b) => ['bills', b]).concat(live(P.moneyOut).map((b) => ['moneyOut', b]))) {
    for (const l of x[1].lines) if (/insur|road ?tax|licen[cs]e|annual fee|premium|subscription|warranty|renewal/i.test(l.acc + ' ' + l.desc) && l.amt > 1000) add('E1', 'yellow', 'Prepayment', x[1].no + ' 可能是预付费用，却整笔记在费用', x[1].no + '（' + x[1].date + '）' + x[1].contact + ' ' + rm(l.amt) + '，科目「' + l.acc + '」' + (l.desc ? '，说明「' + l.desc + '」' : '') + '。', [ev(x[0], x[1], l.amt)], { suggested_check: '确认是不是应该摊销到几个月', affects: ['TB - Prepayment', 'TB - Expenses'] });
  }
  ran('E1');
  const items = (txt) => String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('|').map((s) => s.trim()));
  const pre = items(client.prepayments);
  if (pre.length) {
    ran('E2');
    const pm = data.to.slice(0, 7);
    for (const f of pre) {
      const [item, total, months, start] = f; if (!item) continue;
      if (start && /^\d{4}-\d{2}$/.test(start) && months) { const end = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + Number(months), 1)).toISOString().slice(0, 7); if (pm < start || pm >= end) continue; }
      if (!mentioned(item)) add('E2', 'red', 'Prepayment', 'Prepayment「' + item + '」本期没有摊销', 'Prepayment 主档里的「' + item + '」（总额 ' + (total || '?') + '，' + (months || '?') + ' 个月），' + data.from + ' 至 ' + data.to + ' 的 Journal 里找不到这个项目。（程序是看 Journal 里有没有提到这个名字）', [], { suggested_check: '确认这个月有没有做摊销的 Journal', affects: ['TB - Prepayment', 'TB - Expenses'] });
    }
  }
  const acc = items(client.accruals);
  if (acc.length) {
    ran('F5');
    for (const f of acc) { const [item, , every] = f; if (!item || /^(no|否|不)/i.test(every || '')) continue; if (!mentioned(item)) add('F5', 'red', 'Accrual', 'Accrual「' + item + '」本期没有 accrue', 'Accrual 主档里的「' + item + '」，' + data.from + ' 至 ' + data.to + ' 的 Journal 里找不到这个项目。（程序是看 Journal 里有没有提到这个名字）', [], { suggested_check: '确认月底有没有 accrue', affects: ['TB - Accruals', 'TB - Expenses'] }); }
  }
  ran('F3');
  for (const b of data.outstanding.bills) if (STATUTORY.test(b.contact) && b.date && b.date < data.from) add('F3', 'red', 'Accrual', b.contact + ' ' + b.no + ' 还没清', b.no + '（' + b.date + '）' + b.contact + ' 余额 ' + (b.balance == null ? '读不到' : rm(b.balance)) + '，是上个月或更早的，本期还没付清。', [{ source: 'Creditor Aging', doc_no: b.no, date: b.date, party: b.contact, amount: b.balance }], { suggested_check: '确认 EPF / SOCSO / EIS / PCB 有没有付，付了有没有 knock' });

  // ---------- G. TNG / platform settlement ----------
  if (e.settlementRows && e.settlementRows.length) {
    ran('G1');
    const sales = new Map(); live(P.invoices).forEach((x) => sales.set(x.date, r2((sales.get(x.date) || 0) + x.amount)));
    const set = new Map(); e.settlementRows.forEach((s) => set.set(s.ymd, r2((set.get(s.ymd) || 0) + s.net)));
    const diffs = []; for (const [d, n] of set) { const g = sales.get(d) || 0; if (Math.abs(n - g) > tol) diffs.push([d, n, g]); }
    diffs.sort();
    if (diffs.length) add('G1', 'red', 'Settlement', diffs.length + ' 天的 TNG settlement 和 Bukku 销售额不一样', '按整家公司每天合计比较（没有分店对照）。差额超过 ' + rm(tol) + ' 的日子：' + diffs.slice(0, 15).map(([d, n, g]) => d + ' settlement ' + rm(n) + ' / Bukku ' + rm(g)).join('；'), diffs.slice(0, 30).map(([d, n, g]) => ({ source: 'TNG settlement vs Sales Invoice', doc_no: '', date: d, party: '', amount: r2(n - g) })), { amount_difference: r2(diffs.reduce((a, [, n, g]) => a + Math.abs(n - g), 0)), suggested_check: '逐天对 settlement 报告和 Bukku 当天的销售（现金销售等不在 settlement 里的会造成差额）', fix_scope: 'complex', affects: ['TB - Sales'] });
  }

  // ---------- H. which month a payment is for ----------
  ran('H1', 'H2');
  for (const key of ['payments', 'receipts']) for (const x of live(P[key])) {
    if (!x.links.length) continue;
    const said = monthsIn(x.remark + ' ' + x.no2), got = new Set(x.links.map((l) => Number(String(l.date).slice(5, 7))).filter(Boolean));
    if (said.size && got.size && ![...said].some((m) => got.has(m))) add('H1', 'red', 'Payment Month', x.no + ' 描述的月份和 knock 的单不一样', x.no + '（' + x.date + '）' + x.contact + ' ' + rm(x.amount) + '，描述「' + x.remark + '」说的是 ' + [...said].join('/') + ' 月，knock 的单是：' + x.links.map((l) => l.no + '（' + l.date + '）' + rm(l.amt)).join('，') + '。', [ev(key, x)].concat(x.links.map((l) => ({ source: '被 knock 的单', doc_no: l.no, date: l.date, party: x.contact, amount: l.amt }))), { suggested_check: '确认付的是哪个月，knock 对了没有' });
    const aging = key === 'receipts' ? data.outstanding.invoices : data.outstanding.bills;
    const older = aging.filter((a) => a.contact === x.contact && x.links.some((l) => l.date && a.date && a.date < l.date) && !x.links.some((l) => l.no === a.no));
    if (older.length) add('H2', 'yellow', 'Payment Month', x.no + ' 有更旧的单还没清，却 knock 了较新的单', x.no + '（' + x.date + '）' + x.contact + ' knock 了 ' + x.links.map((l) => l.no + '（' + l.date + '）').join('，') + '，但这个对方还有更旧的未付：' + older.slice(0, 5).map((a) => a.no + '（' + a.date + '）' + (a.balance == null ? '' : rm(a.balance))).join('，') + '。', [ev(key, x)].concat(older.slice(0, 5).map((a) => ({ source: '还没清的旧单', doc_no: a.no, date: a.date, party: a.contact, amount: a.balance }))), { suggested_check: '确认是客户 / 供应商指定的，还是 knock 错了' });
  }

  // ---------- I. special transactions ----------
  const all = Object.keys(SRC).filter((k) => k !== 'transfers').flatMap((k) => live(P[k]).map((x) => [k, x]));
  ran('I3', 'I4', 'I5', 'I6');
  if (client.materiality > 0) { ran('I1'); for (const [k, x] of all) if (x.amount > client.materiality) add('I1', 'yellow', 'Special Transaction', x.no + ' 金额超过重要性金额', x.no + '（' + x.date + '）' + x.contact + ' ' + rm(x.amount) + ' 超过重要性金额 ' + rm(client.materiality) + '。', [ev(k, x)], { suggested_check: '确认这笔大额交易的原始单据和用途' }); }
  ran('I2');
  for (const [k, x] of all) {
    const dl = x.lines.find((l) => /director|shareholder|related|holding co|amount due (to|from)|inter-?company|dividend|\bdrawing/i.test(l.acc));
    if (dl) add('I2', 'yellow', 'Special Transaction', x.no + ' 动到董事 / 关联公司科目', x.no + '（' + x.date + '）' + x.contact + ' ' + rm(dl.amt) + ' 记到「' + dl.acc + '」。', [ev(k, x, dl.amt)], { suggested_check: '确认这笔往来有董事或关联公司的批准文件' });
    const eq = x.lines.find((l) => /capital|retained|reserve/i.test(l.acc));
    if (eq) add('I5', 'red', 'Special Transaction', x.no + ' 动到 Capital / Retained Earnings', x.no + '（' + x.date + '）' + rm(eq.amt) + ' 记到「' + eq.acc + '」。', [ev(k, x, eq.amt)], { suggested_check: '确认有没有股东决议或审计调整', affects: ['TB - Equity'] });
    if (/cash withdraw|withdrawal|\batm\b|tunai/i.test([x.remark].concat(x.lines.map((l) => l.desc)).join(' '))) add('I4', 'yellow', 'Special Transaction', x.no + ' 现金提款', x.no + '（' + x.date + '）' + rm(x.amount) + '，说明：' + x.remark, [ev(k, x)], { suggested_check: '确认提款的用途，有没有对应的开销单' });
  }
  const bankNames = data.accounts.filter((a) => a.sys === 'bank_cash').map((a) => a.name.toLowerCase());
  for (const x of live(P.journals)) {
    const t = journalText[(P.journals || []).indexOf(x)] || '';
    if (bankNames.some((n) => n && t.includes(n))) add('I6', 'yellow', 'Special Transaction', x.no + ' 用 Journal 动到银行或现金科目', x.no + '（' + x.date + '）' + rm(x.amount) + ' 的 Journal 里有银行 / 现金科目。', [ev('journals', x)], { suggested_check: '确认为什么不用 Money In / Money Out 或 Payment' });
    if (/cash withdraw|withdrawal|\batm\b|tunai/i.test(x.remark + ' ' + x.journal) && !issues.some((i) => i.rule_id === 'I4' && i.evidence[0] && i.evidence[0].doc_no === x.no)) add('I4', 'yellow', 'Special Transaction', x.no + ' 现金提款', x.no + '（' + x.date + '）' + rm(x.amount), [ev('journals', x)], {});
  }
  for (const a of data.accounts) if (/suspense/i.test(a.name) && a.balance) add('I3', 'red', 'Special Transaction', 'Suspense 科目有余额：' + a.name, a.name + '（' + a.code + '）现在的余额 ' + rm(a.balance) + '。', [{ source: 'Accounts', doc_no: a.code, date: today, party: a.name, amount: a.balance }], { amount_difference: a.balance, suggested_check: '找出这笔钱是什么，记到正确的科目' });

  // ---------- J. overpaid / not knocked ----------
  ran('J1', 'J2', 'J4', 'J5');
  for (const [side, list] of [['Debtor', data.outstanding.invoices], ['Creditor', data.outstanding.bills]]) list.filter((x) => x.balance != null && x.balance < -0.004).forEach((x) => add('J1', 'red', 'Overpaid', side + ' ' + x.contact + ' ' + x.no + ' 余额变成负数', x.no + '（' + x.date + '）' + x.contact + ' 余额 ' + rm(x.balance) + '。', [{ source: side + ' Aging', doc_no: x.no, date: x.date, party: x.contact, amount: x.balance }], { amount_difference: Math.abs(x.balance), suggested_check: '确认是不是多收 / 多付，或者 knock 重了' }));
  for (const key of ['payments', 'receipts']) for (const x of live(P[key])) {
    if (!x.detailed) continue;
    const used = r2(x.links.reduce((a, l) => a + l.amt, 0)), left = r2(x.amount - used);
    if (left > 0.01) add('J2', 'red', 'Unapplied', x.no + ' ' + (used ? '只 knock 了一部分' : '没有 knock 到任何单'), x.no + '（' + x.date + '）' + x.contact + ' ' + rm(x.amount) + '，knock 了 ' + rm(used) + '，还有 ' + rm(left) + ' 没有 knock。', [ev(key, x)], { amount_difference: left, calculation: rm(x.amount) + ' − ' + rm(used) + ' = ' + rm(left), suggested_check: '确认这笔钱是预收 / 预付，还是该 knock 到某张单', affects: [key === 'receipts' ? 'Debtor Ledger' : 'Creditor Ledger'] });
  }
  for (const inv of data.outstanding.invoices) {
    if (inv.balance == null || inv.balance <= 0) continue;
    const hit = live(P.moneyIn).concat(live(P.receipts)).find((m) => Math.abs(m.amount - inv.balance) < 0.005 && (!m.links || !m.links.some((l) => l.no === inv.no)));
    if (hit) add('J4', 'red', 'Not Knocked', inv.no + ' 还 outstanding，却有同金额的进账', inv.no + '（' + inv.date + '）' + inv.contact + ' 余额 ' + rm(inv.balance) + '，本期有同金额的 ' + hit.no + '（' + hit.date + '）' + hit.contact + ' ' + rm(hit.amount) + '。', [{ source: 'Debtor Aging', doc_no: inv.no, date: inv.date, party: inv.contact, amount: inv.balance }, ev(Object.keys(SRC).find((k) => (P[k] || []).includes(hit)), hit)], { amount_difference: inv.balance, suggested_check: '确认这笔进账是不是这张 invoice 的付款，有没有漏 knock' });
  }
  for (const [side, list] of [['Debtor', data.outstanding.invoices], ['Creditor', data.outstanding.bills]]) {
    const old = list.filter((x) => x.date && x.balance && dayDiff(today, x.date) > 90);
    if (old.length) add('J5', 'yellow', 'Aging', side + '：' + old.length + ' 张超过 90 天还没清', old.slice(0, 12).map((x) => x.no + ' ' + x.contact + ' ' + rm(x.balance) + '（' + x.date + '）').join('；') + (old.length > 12 ? ' …' : ''), old.slice(0, 30).map((x) => ({ source: side + ' Aging', doc_no: x.no, date: x.date, party: x.contact, amount: x.balance })), { amount_difference: r2(old.reduce((a, x) => a + x.balance, 0)), suggested_check: '确认是不是坏账，或者其实已经收 / 付了没 knock', fix_scope: 'complex' });
  }
  ran('J6');
  for (const [side, list, sys] of [['Debtor', data.outstanding.invoices, 'accounts_receivable'], ['Creditor', data.outstanding.bills, 'accounts_payable']]) {
    const ac = data.accounts.filter((a) => a.sys === sys && a.balance != null);
    if (!ac.length || list.some((x) => x.balance == null)) continue;
    const ledger = r2(list.reduce((a, x) => a + x.balance, 0)), tb = r2(ac.reduce((a, x) => a + Math.abs(x.balance), 0));
    if (Math.abs(ledger - tb) > tol) add('J6', 'red', 'Control Account', side + ' Ledger 合计和科目余额不一样', side + ' 未付单据合计 ' + rm(ledger) + '，Bukku 科目「' + ac.map((a) => a.name).join(' / ') + '」现在的余额 ' + rm(tb) + '，差 ' + rm(ledger - tb) + '。（两个都是「现在」的数字）', [{ source: side + ' Aging', doc_no: '', date: today, party: '', amount: ledger }, { source: 'Accounts', doc_no: ac[0].code, date: today, party: ac[0].name, amount: tb }], { amount_difference: r2(ledger - tb), calculation: rm(ledger) + ' − ' + rm(tb) + ' = ' + rm(ledger - tb), suggested_check: '常见原因：没 knock 的 credit note、预收 / 预付、journal 直接动了应收 / 应付科目', fix_scope: 'complex' });
  }

  // ---------- K. SST ----------
  ran('K2', 'K3');
  for (const key of ['invoices', 'salesCN']) for (const x of live(P[key])) {
    const taxLines = x.lines.filter((l) => l.tax > 0);
    if (!client.sstRegistered) { if (taxLines.length) add('K3', 'red', 'SST', x.no + ' 客户没有注册 SST，却有 SST', x.no + '（' + x.date + '）' + x.contact + ' 有税 ' + rm(taxLines.reduce((a, l) => a + l.tax, 0)) + '。客户设定是「没有注册 SST」。', [ev(key, x)], { amount_difference: r2(taxLines.reduce((a, l) => a + l.tax, 0)), suggested_check: '确认客户有没有注册 SST，或这个税是不是不该有' }); continue; }
    if (!(client.sstRate > 0)) continue;
    for (const l of taxLines) { const should = r2(l.amt * client.sstRate / 100), d = r2(l.tax - should); if (Math.abs(d) > 0.05) add('K2', 'red', 'SST', x.no + ' SST 算得不对', x.no + '（' + x.date + '）' + x.contact + ' 科目「' + l.acc + '」金额 ' + rm(l.amt) + '，税 ' + rm(l.tax) + '，应该是 ' + client.sstRate + '% = ' + rm(should) + '。', [ev(key, x, l.amt)], { amount_difference: d, calculation: rm(l.amt) + ' × ' + client.sstRate + '% = ' + rm(should) + '，实际 ' + rm(l.tax) + '，差 ' + rm(d), suggested_check: '确认税率和应税金额', affects: ['SST payable'] }); }
  }

  // ---------- what the program could not check ----------
  const missing = [];
  if (!e.bankStatement) missing.push('没有 Bank Statement（Bukku 没有这项资料）：C3、C4、G2 没办法检查，J4 只对 Money In / Receipt 比较');
  missing.push('没有上月已核准的 Trial Balance，也读不到某个日期的 Trial Balance：I7 没办法检查');
  if (!e.salary) missing.push('没有 Salary Summary：K1 没办法检查');
  missing.push('Bukku 读不到总账的科目历史：A3（供应商换科目）、A5（平时是 0 的科目）、F1、F2、F4 没办法检查（A5 只能按科目名字提醒）');
  missing.push('程序没有做：B3、B4、D4、E3、E4、H3、G3、L（这些要对照科目历史或看懂说明，可以交给 AI 检查）');
  if (!pre.length) missing.push('Prepayment 主档是空的：E2、E3、E4 没有检查（E1 照样检查）');
  if (!acc.length) missing.push('Accrual 主档是空的：F5 没有检查');
  if (!(e.settlementRows && e.settlementRows.length)) missing.push('这家公司这段时间没有 TNG / 平台 settlement 报告：G1 没有检查');
  if (client.materiality <= 0) missing.push('客户设定没有填重要性金额：I1 没有检查');
  const hist = hasHistory; if (!hist) missing.push('过去 6 个月没有 Purchase Bill / Money Out：A1、A2、C1 没有检查');
  return { issues, missing, covered: [...covered].sort() };
}

// ---------- the answer: whitelist, the last list (recheck), ids, summary ----------
const key = (x) => x.rule_id + '|' + x.title;

function finish({ run, found, whitelist, prev, prevDecisions }) {
  let issues = found.issues.slice();
  const wl = new Set((whitelist || []).map((w) => w.rule_id + '|' + w.title));
  issues = issues.filter((x) => !wl.has(key(x)));
  const resolved = [];
  if (run.mode === 'recheck' && prev && prev.result) {
    const prevMap = new Map((prev.result.issues || []).map((x) => [key(x), x]));
    const now = new Set(issues.map(key));
    const out = [];
    for (const x of issues) {
      const p = prevMap.get(key(x));
      if (!p) { x.recheck_status = 'new'; x.recheck_note = '上次没有这一项' + '（可能是上次的修正引起的，请对照）'; out.push(x); continue; }
      const same = Math.abs((Number(p.amount_difference) || 0) - (Number(x.amount_difference) || 0)) < 0.005;
      const d = ((prevDecisions || {})[p.id] || {}).decision;
      if (same && (d === 'ok' || d === 'exempt')) continue;     // confirmed as fine last time and nothing changed
      x.previous_issue_id = p.id; x.recheck_status = same ? 'still_open' : 'changed';
      x.recheck_note = same ? '问题还在，数字没有变' : '问题还在，金额从 ' + num(p.amount_difference || 0) + ' 变成 ' + num(x.amount_difference || 0);
      out.push(x);
    }
    for (const p of prev.result.issues || []) if (!now.has(key(p)) && !wl.has(key(p))) resolved.push({ previous_issue_id: p.id, rule_id: p.rule_id, title: p.title, recheck_note: '这次已经没有这个问题' });
    issues = out;
  }
  issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
  issues.forEach((x, i) => { x.id = i + 1; });
  const st = (s) => issues.filter((x) => x.recheck_status === s).length;
  return {
    client: run.company, period: String(run.period_from).slice(0, 7), staff: run.staff, check_mode: run.mode, engine: 'program', checked_rules: found.covered,
    summary: { red: issues.filter((x) => x.severity === 'red').length, yellow: issues.filter((x) => x.severity === 'yellow').length, info: issues.filter((x) => x.severity === 'info').length, resolved: resolved.length, still_open: st('still_open'), changed: st('changed'), new: st('new') },
    missing_data: found.missing, issues, resolved_issues: resolved
  };
}

module.exports = { runRules, finish, monthsIn };
