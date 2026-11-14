// Form EA (C.P.8A - Pin. 2023): Statement of Remuneration from Employment, one page per employee, laid out like the LHDN form (Parts A to F, the same numbering).
// The amounts come from the finalized payroll months of the year (and what was entered for the months before the system).
const path = require('path');
const PDFDocument = require('pdfkit');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
const M = 36;
const INK = '#111111', MUTED = '#555555';

const money = (n) => (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const font = (doc, t, bold, size) => doc.font(CJK_RE.test(String(t)) ? 'CJK' : bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
const dmy = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');

function t(doc, s, x, y, o, bold, size, color) { font(doc, s, bold, size || 8.5); doc.fillColor(color || INK).text(String(s == null ? '' : s), x, y, o || {}); }
// a labelled value on a dotted line
function field(doc, label, value, x, y, w, labelW, labelSize) {
  t(doc, label, x, y + (labelSize ? 1 : 0), { width: labelW, lineBreak: false }, false, labelSize || 8);
  const vx = x + labelW;
  doc.moveTo(vx, y + 9.5).lineTo(x + w, y + 9.5).dash(1, { space: 1.5 }).lineWidth(0.5).strokeColor('#888888').stroke().undash();
  if (value) t(doc, value, vx + 2, y, { width: x + w - vx - 2, lineBreak: false }, true, 8.5);
}
function amount(doc, v, y, x2) {
  const right = x2 || 548;
  doc.moveTo(right - 92, y + 9.5).lineTo(right, y + 9.5).dash(1, { space: 1.5 }).lineWidth(0.5).strokeColor('#888888').stroke().undash();
  if (v !== undefined && v !== null && v !== '') t(doc, money(v), right - 90, y, { width: 88, align: 'right', lineBreak: false }, true, 8.5);
}
function part(doc, letter, title, y) {
  doc.rect(M, y, 14, 12).fill('#000000');
  t(doc, letter, M, y + 2, { width: 14, align: 'center' }, true, 9, '#ffffff');
  t(doc, title, M + 20, y + 2, { width: 480 }, true, 9);
}

function drawEa(doc, co, set, e, year, no) {
  const W = doc.page.width - M * 2;
  let y = M;
  t(doc, '(C.P.8A - Pin. 2023)', M, y + 2, { width: 150 }, false, 7.5);
  t(doc, 'MALAYSIA', M + 200, y, { width: 150, align: 'center' }, true, 8);
  doc.rect(M + 340, y - 2, 142, 24).fill('#000000');
  t(doc, 'PRIVATE SECTOR Employee’s Statement of Remuneration', M + 344, y, { width: 134 }, true, 7, '#ffffff');
  t(doc, 'EA', M + 486, y - 4, { width: 40 }, true, 20);
  y += 20;
  t(doc, 'INCOME TAX', M + 150, y, { width: 250, align: 'center' }, true, 13);
  y += 20;
  field(doc, 'Serial No.', no, M, y, 250, 48);
  t(doc, 'STATEMENT OF REMUNERATION FROM EMPLOYMENT', M + 130, y + 2, { width: 280, align: 'center' }, true, 8);
  field(doc, 'Employee’s Tax Identification No. (TIN)', e.tin, M + 330, y - 16, 196, 124, 6.6);
  y += 16;
  field(doc, 'Employer’s No. E', set.employerE, M, y, 200, 62);
  t(doc, 'FOR THE YEAR ENDED 31 DECEMBER ' + year, M + 120, y + 2, { width: 215, align: 'center' }, true, 7.6);
  field(doc, 'LHDNM State', set.lhdnState, M + 345, y, 181, 52);
  y += 20;
  doc.rect(M, y, W, 13).fill('#000000');
  t(doc, 'THIS FORM EA MUST BE PREPARED AND PROVIDED TO THE EMPLOYEE FOR INCOME TAX PURPOSE', M, y + 3, { width: W, align: 'center' }, true, 7.8, '#ffffff');
  y += 18;

  // A
  part(doc, 'A', 'PARTICULARS OF EMPLOYEE', y); y += 18;
  field(doc, '1.   Full Name of Employee / Pensioner (Mr./Miss/Madam)', e.name, M + 4, y, W - 4, 232); y += 16;
  field(doc, '2.   Job Designation', e.position, M + 4, y, 250, 90); field(doc, '3.   Staff No. / Payroll No.', e.staffNo, M + 270, y, W - 270, 108); y += 16;
  field(doc, '4.   New I.C. No', e.ic, M + 4, y, 250, 90); field(doc, '5.   Passport No.', e.passport, M + 270, y, W - 270, 108); y += 16;
  field(doc, '6.   EPF No.', e.epfNo, M + 4, y, 250, 90); field(doc, '7.   SOCSO No.', e.socsoNo, M + 270, y, W - 270, 108); y += 16;
  field(doc, '8.   Number of children qualified for tax relief', e.children != null ? String(e.children) : '', M + 4, y, 250, 170);
  t(doc, '9.   If the period of employment is less than a year, please state:', M + 270, y, { width: 270 }, false, 8); y += 16;
  field(doc, '(a)  Date of commencement', dmy(e.start), M + 280, y, W - 280, 100); y += 14;
  field(doc, '(b)  Date of cessation', dmy(e.end), M + 280, y, W - 280, 100); y += 18;

  // B
  part(doc, 'B', 'EMPLOYMENT INCOME, BENEFITS AND LIVING ACCOMMODATION', y); y += 15;
  t(doc, '(Excluding Tax Exempt Allowances / Perquisites / Gifts / Benefits)', M + 20, y, { width: 360 }, true, 7.5);
  t(doc, 'RM', 500, y, { width: 48, align: 'right' }, true, 8); y += 14;
  const row = (label, v, indent) => { t(doc, label, M + (indent || 0), y, { width: 420, lineBreak: false }, false, 8); amount(doc, v, y); y += 12.6; };
  row('1.  (a)  Gross salary, wages or leave pay (including overtime pay)', e.a, 0);
  row('     (b)  Fees (including director fees), commission or bonus', e.b);
  row('     (c)  Gross tips, perquisites, awards / rewards or other allowances (Details of payment: ........................)', e.c);
  row('     (d)  Income tax borne by the employer in respect of his employee', e.d);
  row('     (e)  Employee Share Option Scheme (ESOS) benefit', e.esos);
  row('     (f)  Gratuity for the period from ................................ to ................................', e.gratuity);
  row('2.  Details of arrears and others for preceding years paid in the current year', e.arrears);
  row('3.  Benefits in kind (Specify: ..........................................................................)', e.bik);
  row('4.  Value of living accommodation provided (Address: .....................................................)', e.accommodation);
  row('5.  Refund from unapproved Provident / Pension Fund', e.refund);
  row('6.  Compensation for loss of employment', e.compensation);
  y += 3;

  // C
  part(doc, 'C', 'PENSION AND OTHERS', y); y += 17;
  row('1.  Pension', e.pension);
  row('2.  Annuities or other periodical payments', e.annuity);
  const total = (Number(e.a) || 0) + (Number(e.b) || 0) + (Number(e.c) || 0) + (Number(e.d) || 0) + (Number(e.esos) || 0) + (Number(e.gratuity) || 0) + (Number(e.arrears) || 0) + (Number(e.bik) || 0) +
    (Number(e.accommodation) || 0) + (Number(e.refund) || 0) + (Number(e.compensation) || 0) + (Number(e.pension) || 0) + (Number(e.annuity) || 0);
  t(doc, 'TOTAL', M + 20, y, { width: 100 }, true, 8.5);
  doc.moveTo(456, y - 2).lineTo(548, y - 2).lineWidth(0.8).strokeColor(INK).stroke();
  t(doc, money(total), 458, y, { width: 88, align: 'right', lineBreak: false }, true, 9);
  doc.moveTo(456, y + 11).lineTo(548, y + 11).lineWidth(0.8).strokeColor(INK).stroke();
  y += 18;

  // D
  part(doc, 'D', 'TOTAL DEDUCTION', y); y += 17;
  row('1.  Monthly tax deductions (MTD) remitted to LHDNM', e.pcb);
  row('2.  CP38 deductions remitted to LHDNM', e.cp38);
  row('3.  Zakat paid via salary deduction', e.zakat);
  row('4.  Approved donations / gifts / contributions via salary deduction', e.donation);
  t(doc, '5.  Total claim for deduction by employee via Form TP1 in respect of:', M, y, { width: 420 }, false, 8); y += 14;
  t(doc, '     (a)  Relief', M, y, { width: 200, lineBreak: false }, false, 8); amount(doc, e.tp1Relief, y, 360); y += 12.6;
  t(doc, '     (b)  Zakat other than that paid via monthly salary deduction', M, y, { width: 300, lineBreak: false }, false, 8); amount(doc, e.tp1Zakat, y, 360); y += 12.6;
  row('6.  Total qualifying child relief', e.childRelief);
  y += 3;

  // E
  part(doc, 'E', 'CONTRIBUTIONS PAID BY EMPLOYEE TO APPROVED PROVIDENT / PENSION FUND AND SOCSO', y); y += 17;
  field(doc, '1.  Name of Provident Fund', e.fundName, M, y, W, 100); y += 13;
  t(doc, 'Amount of compulsory contribution paid (state the employee’s share of contribution only)', M + 16, y, { width: 400, lineBreak: false }, false, 8);
  t(doc, 'RM', 440, y, { width: 20 }, false, 8); amount(doc, e.epf, y); y += 14;
  t(doc, '2.  SOCSO :  Amount of compulsory contribution paid (state the employee’s share of contribution only)', M, y, { width: 420, lineBreak: false }, false, 8);
  t(doc, 'RM', 440, y, { width: 20 }, false, 8); amount(doc, e.socso, y); y += 17;
  doc.rect(M, y - 1, 14, 12).fill('#000000'); t(doc, 'F', M, y + 1, { width: 14, align: 'center' }, true, 9, '#ffffff');
  t(doc, 'TOTAL TAX EXEMPT ALLOWANCES / PERQUISITES / GIFTS / BENEFITS', M + 20, y + 1, { width: 400, lineBreak: false }, true, 8.5);
  t(doc, 'RM', 440, y + 1, { width: 20 }, false, 8); amount(doc, e.exempt, y); y += 22;

  field(doc, 'Name of Officer', set.officerName, M + 150, y, W - 150, 76); y += 13;
  field(doc, 'Designation', set.officerDesignation, M + 150, y, W - 150, 76); y += 13;
  t(doc, 'Name and Address of Employer', M + 150, y, { width: 130, lineBreak: false }, false, 8);
  t(doc, [co.name, co.address].filter(Boolean).join(', '), M + 280, y, { width: W - 280, height: 22 }, true, 7.5);
  y += 26;
  field(doc, 'Date', dmy(set.date), M, y, 140, 30); field(doc, 'Employer’s Telephone No.', set.phone, M + 150, y, W - 150, 98);
}

function buildEaPdf(company, settings, year, items) {
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
  doc.registerFont('CJK', CJK_FONT_PATH);
  items.forEach((e, i) => { if (i) doc.addPage(); drawEa(doc, company, settings, e, year, String(year).slice(2) + '-' + String(i + 1).padStart(3, '0')); });
  return doc;
}

module.exports = { buildEaPdf };
