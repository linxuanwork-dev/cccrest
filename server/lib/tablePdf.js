// A plain landscape table report (the Payroll monthly / yearly summaries). sections: [{ heading, columns: [header...], rows: [[cell...]], total: [cell...] }]
// Cells are strings; every column after the first is right-aligned.
const path = require('path');
const PDFDocument = require('pdfkit');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
const MARGIN = 28;
const INK = '#1a1a1a', MUTED = '#5b6470', HEAD = '#1a4376', SHADE = '#eef2f7', LINE = '#c9d0d8';

const font = (doc, text, bold, size) => doc.font(CJK_RE.test(String(text)) ? 'CJK' : bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
const put = (doc, t, x, y, w, align, bold, size, color) => { font(doc, t, bold, size); doc.fillColor(color || INK).text(String(t == null ? '' : t), x, y, { width: w, align: align || 'left', lineBreak: false, ellipsis: true }); };

function buildTablePdf({ company, title, subtitle, sections, notes }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true });
  doc.registerFont('CJK', CJK_FONT_PATH);
  const W = doc.page.width - MARGIN * 2, bottom = doc.page.height - MARGIN - 18;
  let y = MARGIN;
  put(doc, company || '', MARGIN, y, W, 'left', true, 13); y += 18;
  put(doc, title || '', MARGIN, y, W * 0.6, 'left', true, 12, HEAD);
  if (subtitle) put(doc, subtitle, MARGIN + W * 0.5, y + 1, W * 0.5, 'right', false, 9, MUTED);
  y += 20;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(1).strokeColor(HEAD).stroke(); y += 10;
  (sections || []).forEach((sec) => {
    const cols = sec.columns || [], n = cols.length || 1, first = Math.min(150, W * 0.2), other = (W - first) / Math.max(n - 1, 1);
    const xs = cols.map((_, i) => MARGIN + (i === 0 ? 0 : first + (i - 1) * other)), ws = cols.map((_, i) => (i === 0 ? first : other) - 4);
    const size = n > 14 ? 6.5 : n > 10 ? 7.5 : 8.5, rh = size + 8;
    const head = () => {
      doc.rect(MARGIN, y, W, rh + 4).fill(HEAD);
      cols.forEach((h, i) => put(doc, h, xs[i] + 3, y + 5, ws[i], i ? 'right' : 'left', true, size, '#ffffff'));
      y += rh + 4;
    };
    if (y + 60 > bottom) { doc.addPage(); y = MARGIN; }
    if (sec.heading) { put(doc, sec.heading, MARGIN, y, W, 'left', true, 10, HEAD); y += 16; }
    head();
    (sec.rows || []).forEach((r, k) => {
      if (y + rh > bottom) { doc.addPage(); y = MARGIN; head(); }
      if (k % 2) doc.rect(MARGIN, y, W, rh).fill(SHADE);
      r.forEach((v, i) => put(doc, v, xs[i] + 3, y + 4, ws[i], i ? 'right' : 'left', false, size));
      y += rh;
    });
    if (sec.total) {
      if (y + rh > bottom) { doc.addPage(); y = MARGIN; head(); }
      doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.rect(MARGIN, y, W, rh + 2).fill('#d9e2ee');
      sec.total.forEach((v, i) => put(doc, v, xs[i] + 3, y + 4, ws[i], i ? 'right' : 'left', true, size));
      y += rh + 2;
    }
    y += 16;
  });
  (notes || []).forEach((t) => { if (y + 14 > bottom) { doc.addPage(); y = MARGIN; } put(doc, t, MARGIN, y, W, 'left', false, 8, MUTED); y += 12; });
  return doc;
}

module.exports = { buildTablePdf };
