// Salary voucher / payslip PDF (one page per person). The numbers come from lib/statutory.js (the same rules as the Payroll tab of the page).
const path = require('path');
const PDFDocument = require('pdfkit');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
const MARGIN = 40;
const INK = '#1a1a1a', MUTED = '#5b6470', LINE = '#c9d0d8', HEAD = '#1a4376', SHADE = '#eef2f7';
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const money = (n) => (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const font = (doc, text, bold, size) => doc.font(CJK_RE.test(String(text)) ? 'CJK' : bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
const dmy = (iso) => (iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '');
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

function text(doc, t, x, y, opts, bold, size, color) {
  font(doc, t, bold, size || 9);
  doc.fillColor(color || INK).text(String(t == null ? '' : t), x, y, opts || {});
}

// slip: { company: {name, registration_no, address}, emp: {name, ic, epfNo, socsoNo, tin, bank}, month, voucher, days, hours, otHours, c: STAT.calc result, payMethod }
function drawSlip(doc, slip) {
  const W = doc.page.width - MARGIN * 2, c = slip.c, co = slip.company || {};
  let y = MARGIN;
  text(doc, co.name || '', MARGIN, y, { width: W }, true, 14);
  y += 19;
  const sub = [co.registration_no, co.address].filter(Boolean).join('   ·   ');
  if (sub) { text(doc, sub, MARGIN, y, { width: W }, false, 8, MUTED); y += 12; }
  y += 8;
  const [yy, mm] = slip.month.split('-');
  text(doc, 'SALARY VOUCHER', MARGIN, y, { width: W / 2 }, true, 13, HEAD);
  text(doc, MONTHS[Number(mm) - 1] + ' ' + yy, MARGIN + W / 2, y + 2, { width: W / 2, align: 'right' }, true, 11);
  y += 22;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(1).strokeColor(HEAD).stroke();
  y += 10;

  // who
  const e = slip.emp || {};
  const left = [['Name', e.name], ['NRIC / Passport', e.ic], ['Bank', e.bank], ['Working days', slip.days != null ? String(slip.days) : '']];
  const right = [['Voucher No', slip.voucher], ['Date', dmy(slip.date || lastDay(slip.month))], ['EPF No.', e.epfNo], ['Socso No.', e.socsoNo], ['Income Tax No.', e.tin]];
  const col = W / 2;
  left.forEach((r, i) => { text(doc, r[0] + ':', MARGIN, y + i * 15, { width: 95 }, false, 8.5, MUTED); text(doc, r[1] || '', MARGIN + 95, y + i * 15, { width: col - 100 }, i === 0, 9.5); });
  right.forEach((r, i) => { text(doc, r[0] + ':', MARGIN + col, y + i * 15, { width: 85 }, false, 8.5, MUTED); text(doc, r[1] || '', MARGIN + col + 85, y + i * 15, { width: col - 90 }, false, 9.5); });
  y += Math.max(left.length, right.length) * 15 + 4;
  text(doc, 'Working hours: ' + (slip.hours != null ? money(slip.hours) : '') + '     OT hours: ' + money(slip.otHours), MARGIN, y, { width: W }, false, 8.5, MUTED);
  y += 20;

  // earnings | deductions
  const earn = [['Basic Pay', c.basic], ['Overtime', c.otPay], ['Allowance', c.allowance], ['Incentive', c.incentive], ['Commission', c.commission], ['Other', c.other]];
  if (c.unpaidDeduction) earn.splice(1, 0, ['Less: unpaid leave', -c.unpaidDeduction]);
  const ded = [['EPF', c.epfEmployee], ['Socso', c.socsoEmployee], ['Socso (non-employment injury)', c.skbbkEmployee], ['EIS', c.eisEmployee], ['PCB', c.pcb], ['Advance', c.advance]];
  const half = (W - 14) / 2, x2 = MARGIN + half + 14, rows = Math.max(earn.length, ded.length);
  const head = (x, t) => { doc.rect(x, y, half, 18).fill(HEAD); text(doc, t, x + 6, y + 5, { width: half - 12 }, true, 9, '#ffffff'); text(doc, 'RM', x + half - 60, y + 5, { width: 54, align: 'right' }, true, 9, '#ffffff'); };
  head(MARGIN, 'EARNINGS'); head(x2, 'DEDUCTIONS');
  y += 18;
  for (let i = 0; i < rows; i++) {
    const ry = y + i * 19;
    if (i % 2) { doc.rect(MARGIN, ry, half, 19).fill(SHADE); doc.rect(x2, ry, half, 19).fill(SHADE); }
    if (earn[i]) { text(doc, earn[i][0], MARGIN + 6, ry + 5, { width: half - 80 }, false, 9); text(doc, money(earn[i][1]), MARGIN + half - 66, ry + 5, { width: 60, align: 'right' }, false, 9); }
    if (ded[i]) { text(doc, ded[i][0], x2 + 6, ry + 5, { width: half - 80 }, false, 9); text(doc, money(ded[i][1]), x2 + half - 66, ry + 5, { width: 60, align: 'right' }, false, 9); }
  }
  y += rows * 19;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + half, y).moveTo(x2, y).lineTo(x2 + half, y).lineWidth(0.6).strokeColor(LINE).stroke();
  const totDed = (Number(c.totalDeduction) || 0) + (Number(c.advance) || 0);
  text(doc, 'TOTAL EARNINGS', MARGIN + 6, y + 6, { width: half - 80 }, true, 9); text(doc, money(c.gross), MARGIN + half - 66, y + 6, { width: 60, align: 'right' }, true, 9);
  text(doc, 'TOTAL DEDUCTIONS', x2 + 6, y + 6, { width: half - 80 }, true, 9); text(doc, money(totDed), x2 + half - 66, y + 6, { width: 60, align: 'right' }, true, 9);
  y += 26;
  doc.rect(MARGIN, y, W, 24).fill('#d9e2ee');
  text(doc, 'NET SALARY', MARGIN + 8, y + 7, { width: W / 2 }, true, 11);
  text(doc, 'RM ' + money(c.net), MARGIN + W / 2, y + 7, { width: W / 2 - 8, align: 'right' }, true, 11);
  y += 38;

  // employer's share
  text(doc, "Employer's contributions (not deducted from the salary)", MARGIN, y, { width: W }, true, 9, HEAD);
  y += 15;
  [['Employer EPF', c.epfEmployer], ['Employer Socso', c.socsoEmployer], ['Employer EIS', c.eisEmployer]].forEach((r, i) => {
    text(doc, r[0], MARGIN + 6, y + i * 15, { width: 200 }, false, 9); text(doc, money(r[1]), MARGIN + 210, y + i * 15, { width: 70, align: 'right' }, false, 9);
  });
  y += 3 * 15 + 12;
  text(doc, 'Payment Method: ' + (slip.payMethod || 'ONLINE BANKING'), MARGIN, y, { width: W }, false, 9);
  y += 50;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 160, y).moveTo(MARGIN + W - 160, y).lineTo(MARGIN + W, y).lineWidth(0.6).strokeColor(MUTED).stroke();
  text(doc, 'Approved by', MARGIN, y + 4, { width: 160 }, false, 8.5, MUTED);
  text(doc, 'Received by', MARGIN + W - 160, y + 4, { width: 160 }, false, 8.5, MUTED);
}

function buildPayslipPdf(slips) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  doc.registerFont('CJK', CJK_FONT_PATH);
  slips.forEach((s, i) => { if (i) doc.addPage(); drawSlip(doc, s); });
  return doc;
}

module.exports = { buildPayslipPdf };
