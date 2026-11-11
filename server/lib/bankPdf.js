// Bank statement PDF -> credit rows, for the Tuition & Allowance bank page.
// Only Public Bank (PBB) statements are read: they are real text. (Affin PDFs are a picture, they cannot be read: use the Excel.)
// Rows: {date:'YYYY-MM-DD', time:<ref no>, payer, ref, amount}; the statement's own balance column is used to check every row.

const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const money = (s) => { const m = /^-?[\d,]+\.\d{2}$/.test(String(s).trim()) ? Number(String(s).replace(/,/g, '')) : NaN; return m; };
const r2 = (n) => Math.round(n * 100) / 100;

// every text piece of every page with its position (pdf-parse gives the page; we keep x, y and the right edge)
async function readItems(buf) {
  const pages = [];
  await pdfParse(buf, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: true });
      pages.push(tc.items.filter((i) => String(i.str).trim()).map((i) => ({ s: String(i.str).trim(), x: i.transform[4], y: i.transform[5], r: i.transform[4] + (i.width || 0) })));
      return '';
    },
  });
  return pages;
}

function rowsOf(items) { // group the pieces of one page into lines (same y), left to right
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const out = []; let cur = null;
  for (const it of sorted) { if (!cur || Math.abs(it.y - cur.y) > 2.5) { cur = { y: it.y, items: [] }; out.push(cur); } cur.items.push(it); }
  return out;
}

async function parsePbb(buf) {
  const pages = await readItems(buf);
  const flat = pages.map((p) => p.map((i) => i.s).join(' ')).join(' ');
  if (!/Public\s+(Islamic\s+)?Bank|PIDM/i.test(flat) || !/TARIKH|URUS NIAGA/i.test(flat)) return null; // not a PBB statement
  const stmt = /Statement Date\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i.exec(flat) || /Tarikh Penyata[^0-9]*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i.exec(flat);
  const stYear = stmt ? Number(stmt[3]) : new Date().getFullYear(); const stMonth = stmt ? MONTHS[stmt[2].toLowerCase()] : 12;
  const account = ((/Account Number\s*(\d{6,})/i.exec(flat)) || [])[1] || '';
  const sum = {};
  { let m;
    if ((m = /Closing Balance[\s\S]{0,200}?(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s+(\d+)\s+(\d[\d,]*\.\d{2})\s+(\d+)/.exec(flat))) { sum.closing = money(m[1]); sum.debits = money(m[2]); sum.debitCount = +m[3]; sum.credits = money(m[4]); sum.creditCount = +m[5]; } }

  const tx = []; let cur = null, date = '', prevBal = null, done = false; let balanceBreaks = 0;
  const yearFor = (dd, mm) => (mm > stMonth ? stYear - 1 : stYear);
  for (const pg of pages) {
    if (done) break;
    const rows = rowsOf(pg);
    // the table is under the "DATE / TRANSACTION" header
    const hi = rows.findIndex((r) => r.items.some((i) => /^TRANSACTION$/i.test(i.s)));
    if (hi < 0) continue;
    for (const row of rows.slice(hi + 1)) {
      const its = row.items; const text = its.map((i) => i.s).join(' ');
      if (/^(Penyata ini|Baki Harian|Terima Kasih)/i.test(text)) break; // page footer
      const dI = its.find((i) => i.x < 85 && /^\d{2}\/\d{2}$/.test(i.s));
      if (dI) { const [dd, mm] = dI.s.split('/').map(Number); date = yearFor(dd, mm) + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0'); }
      const desc = its.filter((i) => i.x >= 85 && i.x < 300).map((i) => i.s).join(' ').trim();
      const nums = its.filter((i) => i.x >= 300 && !isNaN(money(i.s)));
      const bal = nums.filter((i) => i.r > 470).map((i) => money(i.s))[0];
      const cred = nums.filter((i) => i.r > 395 && i.r <= 470).map((i) => money(i.s))[0];
      const deb = nums.filter((i) => i.r <= 395).map((i) => money(i.s))[0];
      if (/^Closing Balance/i.test(desc)) { done = true; break; }
      if (/^Balance (B\/F|C\/F|From Last Statement)/i.test(desc)) { if (bal != null) prevBal = bal; continue; } // carries no money, does not end the transaction above
      if (cred != null || deb != null) { // a new transaction line
        if (bal != null && prevBal != null) { const want = r2(prevBal + (cred || 0) - (deb || 0)); if (Math.abs(want - bal) > 0.005) balanceBreaks++; }
        if (bal != null) prevBal = bal;
        cur = { date, amount: cred != null ? cred : null, debit: deb != null ? deb : null, head: desc, lines: [] };
        tx.push(cur);
      } else if (cur && desc) cur.lines.push(desc); // the lines under it: payer, remark, bank id
    }
  }

  const rows = [];
  for (const t of tx) {
    if (!(t.amount > 0)) continue; // debits are not income
    const m = /^(.*?)\s(\d{4,})(?:\s+(.*))?$/.exec(t.head); // "DUITNOW TRSF CR 168729 [extra]"
    const kind = m ? m[1] : t.head; const refNo = m ? m[2] : ''; const extra = m && m[3] ? m[3] : '';
    const lines = t.lines.filter((l) => !/^20\d{6}[A-Z0-9]{6,}/.test(l)); // drop the bank's own id line (20261001CIBBMYKL010ORM…)
    const all = (extra ? [extra, ...lines] : lines).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && !/^IMEPS\d{10,}/.test(x)).map((x) => x.replace(/^-\s*/, '')); // name first (a name on the head line wins), then the remarks
    const first = all[0] || '';
    const payer = first.slice(0, 25).trim(); // same cut as the Excel (Reference 1: payer name = first 25 characters), so one person is one payer in both
    const note = all.join(' / '); // the whole text goes in the remark, so names and months are read from it
    rows.push({ date: t.date, time: refNo, payer, ref: [kind && !/^DUITNOW TRSF CR$/i.test(kind) ? kind : '', note].filter(Boolean).join(' / '), amount: r2(t.amount), kind });
  }
  const total = r2(rows.reduce((a, r) => a + r.amount, 0));
  const check = { creditCount: rows.length, creditTotal: total, balanceBreaks };
  if (sum.credits != null) { check.statementCredits = sum.credits; check.statementCreditCount = sum.creditCount; check.matches = Math.abs(total - sum.credits) < 0.005 && rows.length === sum.creditCount && balanceBreaks === 0; } else check.matches = balanceBreaks === 0;
  return { bank: 'PBB', account, statementDate: stmt ? `${stYear}-${String(stMonth).padStart(2, '0')}` : '', rows, check };
}

// 'PBB' result, or {unreadable:true} when the PDF has no text at all (a scanned picture)
async function parseStatement(buf) {
  const pages = await readItems(buf);
  const chars = pages.reduce((a, p) => a + p.reduce((b, i) => b + i.s.length, 0), 0);
  if (chars < 40) return { unreadable: true, pages: pages.length };
  const p = await parsePbb(buf);
  return p || { unknown: true };
}

module.exports = { parseStatement };
