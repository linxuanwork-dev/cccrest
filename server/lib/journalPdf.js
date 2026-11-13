// Journal Entry vouchers (the payroll journals of a month) as a PDF, one voucher per page — the layout of the vouchers MINIFISH files with its Bukku journals:
// company, JOURNAL ENTRY, NO. / DATE / REFERENCE NO., then NO. | A/C NAME | DESCRIPTION | DEBIT | CREDIT and the two totals.
const path = require('path');
const PDFDocument = require('pdfkit');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
const MARGIN = 40;
const INK = '#1a1a1a', MUTED = '#5b6470', HEAD = '#1a4376', SHADE = '#eef2f7', LINE = '#c9d0d8';

const money = (n) => (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const font = (doc, t, bold, size) => doc.font(CJK_RE.test(String(t)) ? 'CJK' : bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
const dmy = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const put = (doc, t, x, y, o, bold, size, color) => { font(doc, t, bold, size || 9); doc.fillColor(color || INK).text(String(t == null ? '' : t), x, y, o || {}); };

function drawVoucher(doc, co, v) {
  const W = doc.page.width - MARGIN * 2;
  let y = MARGIN;
  put(doc, (co.name || '') + (co.registration_no ? ' (' + co.registration_no + ')' : ''), MARGIN, y, { width: W }, true, 13);
  y += 24;
  put(doc, 'JOURNAL ENTRY', MARGIN, y, { width: W }, true, 15, HEAD);
  y += 28;
  [['NO.', v.no], ['DATE', dmy(v.date)], ['REFERENCE NO.', v.reference || '']].forEach((r, i) => {
    put(doc, r[0], MARGIN, y + i * 16, { width: 100 }, false, 8.5, MUTED);
    put(doc, r[1], MARGIN + 100, y + i * 16, { width: W - 100 }, true, 10);
  });
  y += 3 * 16 + 12;
  const cols = [28, 175, 175, 70, 67], x = [MARGIN];
  cols.forEach((w, i) => x.push(x[i] + w));
  doc.rect(MARGIN, y, W, 18).fill(HEAD);
  ['NO.', 'A/C NAME', 'DESCRIPTION', 'DEBIT', 'CREDIT'].forEach((h, i) => put(doc, h, x[i] + 4, y + 5, { width: cols[i] - 8, align: i > 2 ? 'right' : 'left' }, true, 8.5, '#ffffff'));
  y += 18;
  let dr = 0, cr = 0;
  v.lines.forEach((l, i) => {
    const name = (l.code ? l.code + '  ' : '') + l.account;
    font(doc, name, false, 8.5); const h1 = doc.heightOfString(name, { width: cols[1] - 8 });
    font(doc, l.desc || '', false, 8.5); const h2 = doc.heightOfString(l.desc || '', { width: cols[2] - 8 });
    const h = Math.max(h1, h2, 11) + 8;
    if (y + h > doc.page.height - MARGIN - 80) { doc.addPage(); y = MARGIN; }
    if (i % 2) doc.rect(MARGIN, y, W, h).fill(SHADE);
    put(doc, String(i + 1), x[0] + 4, y + 4, { width: cols[0] - 8 }, false, 8.5);
    put(doc, name, x[1] + 4, y + 4, { width: cols[1] - 8 }, false, 8.5);
    put(doc, l.desc || '', x[2] + 4, y + 4, { width: cols[2] - 8 }, false, 8.5);
    put(doc, l.debit ? money(l.debit) : '0.00', x[3] + 4, y + 4, { width: cols[3] - 8, align: 'right' }, false, 8.5);
    put(doc, l.credit ? money(l.credit) : '0.00', x[4] + 4, y + 4, { width: cols[4] - 8, align: 'right' }, false, 8.5);
    dr += Number(l.debit) || 0; cr += Number(l.credit) || 0;
    y += h;
  });
  doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(0.6).strokeColor(LINE).stroke();
  y += 8;
  put(doc, 'DEBIT TOTAL', x[2] + 4, y, { width: cols[2] - 8, align: 'right' }, true, 9);
  put(doc, 'RM ' + money(dr), x[3], y, { width: cols[3] + cols[4] - 4, align: 'right' }, true, 9);
  put(doc, 'CREDIT TOTAL', x[2] + 4, y + 15, { width: cols[2] - 8, align: 'right' }, true, 9);
  put(doc, 'RM ' + money(cr), x[3], y + 15, { width: cols[3] + cols[4] - 4, align: 'right' }, true, 9);
  y += 70;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 160, y).moveTo(MARGIN + W - 160, y).lineTo(MARGIN + W, y).lineWidth(0.6).strokeColor(MUTED).stroke();
  put(doc, 'Prepared by', MARGIN, y + 4, { width: 160 }, false, 8.5, MUTED);
  put(doc, 'Approved by', MARGIN + W - 160, y + 4, { width: 160 }, false, 8.5, MUTED);
}

function buildJournalPdf(company, vouchers) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  doc.registerFont('CJK', CJK_FONT_PATH);
  vouchers.forEach((v, i) => { if (i) doc.addPage(); drawVoucher(doc, company, v); });
  return doc;
}

module.exports = { buildJournalPdf };
