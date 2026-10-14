const path = require('path');
const PDFDocument = require('pdfkit');
const rules = require('./dailySalesRules');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;

const MARGIN = 40;
const FOOTER_RESERVE = 50;

function fontFor(text, bold) {
  if (CJK_RE.test(String(text))) return 'CJK';
  return bold ? 'Helvetica-Bold' : 'Helvetica';
}

function setFont(doc, text, bold, size) {
  doc.font(fontFor(text, bold)).fontSize(size);
}

function usableWidth(doc) {
  return doc.page.width - MARGIN * 2;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - MARGIN - FOOTER_RESERVE) doc.addPage();
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.8);
  setFont(doc, text, true, 11);
  doc.fillColor('#1a1a1a').text(text, MARGIN, doc.y);
  doc.moveDown(0.3);
}

// columns: [{ label, width (weight), align }]; rows: arrays of strings.
// opts.boldLast draws the final row as a bold total row.
function drawTable(doc, columns, rows, opts) {
  opts = opts || {};
  const totalWeight = columns.reduce((s, c) => s + (c.width || 1), 0);
  const widths = columns.map((c) => (usableWidth(doc) * (c.width || 1)) / totalWeight);

  function rowHeight(values, bold) {
    let h = 0;
    values.forEach((v, i) => {
      setFont(doc, v, bold, 8.5);
      h = Math.max(h, doc.heightOfString(String(v == null ? '' : v), { width: widths[i] - 6 }));
    });
    return h + 6;
  }

  function drawRow(values, bold, shade) {
    const h = rowHeight(values, bold);
    ensureSpace(doc, h + 4);
    const y = doc.y;
    if (shade) doc.rect(MARGIN, y, usableWidth(doc), h).fill('#f1f3f5');
    doc.fillColor('#1a1a1a');
    let x = MARGIN;
    values.forEach((v, i) => {
      setFont(doc, v, bold, 8.5);
      doc.text(String(v == null ? '' : v), x + 3, y + 3, { width: widths[i] - 6, align: columns[i].align || 'left' });
      x += widths[i];
    });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + usableWidth(doc), y + h).lineWidth(0.4).strokeColor('#d0d5da').stroke();
    doc.y = y + h;
  }

  drawRow(columns.map((c) => c.label), true, true);
  rows.forEach((r, i) => drawRow(r, !!opts.boldLast && i === rows.length - 1, !!opts.boldLast && i === rows.length - 1));
}

function nowKL() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });
}

function buildReportPdf(branch, menu, built, preparedBy) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  doc.registerFont('CJK', CJK_FONT_PATH);

  const monthLabel = `${rules.MONTH_NAMES[built.month - 1]} ${built.year}`;

  // ---- Header ----
  setFont(doc, branch.company_name, true, 14);
  doc.fillColor('#1a1a1a').text(branch.company_name, MARGIN, MARGIN);
  setFont(doc, branch.reg_no, false, 9);
  doc.fillColor('#444444').text(`Reg No.: ${branch.reg_no}`);
  doc.text(branch.address);
  doc.moveDown(0.8);
  const title = `${branch.code} 每日销售报告 — Bukku Sales Invoice`;
  setFont(doc, title, true, 13);
  doc.fillColor('#1a1a1a').text(title);
  setFont(doc, monthLabel, false, 10);
  doc.fillColor('#444444').text(monthLabel);
  doc.fontSize(8.5).text(`Generated: ${nowKL()}`);
  doc.moveDown(0.3);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + usableWidth(doc), doc.y).lineWidth(0.6).strokeColor('#bbbbbb').stroke();
  doc.moveDown(0.5);

  // ---- Part 1: daily invoice summary ----
  sectionTitle(doc, '1. 每日开单总表');
  const dailyRows = built.invoices.map((inv) => [inv.date, inv.weekday, inv.no, String(inv.lines.filter((l) => l.qty > 0).length), rules.formatCents(inv.totalCents)]);
  dailyRows.push(['合计', '', `${built.invoices.length} 天开单`, '', rules.formatCents(built.monthTotalCents)]);
  drawTable(doc, [
    { label: '日期', width: 2 }, { label: '星期', width: 1 }, { label: '单号', width: 3 },
    { label: '项目数', width: 1, align: 'right' }, { label: '金额 RM', width: 2, align: 'right' }
  ], dailyRows, { boldLast: true });

  // ---- Part 2: monthly item summary ----
  sectionTitle(doc, '2. 项目月总表');
  const itemRows = built.itemTotals.map((t, i) => [String(i + 1), t.product, String(t.qty), rules.formatCents(t.amountCents)]);
  const totalQty = built.itemTotals.reduce((s, t) => s + t.qty, 0);
  itemRows.push(['', '合计', String(totalQty), rules.formatCents(built.monthTotalCents)]);
  drawTable(doc, [
    { label: 'No.', width: 1 }, { label: 'Product', width: 6 },
    { label: '月数量', width: 1.5, align: 'right' }, { label: '金额 RM', width: 2, align: 'right' }
  ], itemRows, { boldLast: true });

  // ---- Part 3: special prices (only if any) ----
  if (built.specialRecords.length > 0) {
    sectionTitle(doc, '3. 特价记录');
    const spRows = built.specialRecords.map((s) => [
      s.date, s.product, rules.formatCents(s.menuCents), rules.formatCents(s.specialCents), String(s.qty), rules.formatCents(s.diffCents)
    ]);
    drawTable(doc, [
      { label: '日期', width: 2 }, { label: 'Product', width: 5 }, { label: '菜单价', width: 1.5, align: 'right' },
      { label: '特价', width: 1.5, align: 'right' }, { label: '数量', width: 1, align: 'right' }, { label: '差额 RM', width: 1.5, align: 'right' }
    ], spRows);
  }

  // ---- Part 4: invoice detail appendix ----
  doc.addPage();
  setFont(doc, '4. 单据明细', true, 11);
  doc.fillColor('#1a1a1a').text('4. 单据明细', MARGIN, MARGIN);
  doc.moveDown(0.4);
  built.invoices.forEach((inv) => {
    ensureSpace(doc, 70);
    doc.moveDown(0.5);
    setFont(doc, inv.no, true, 9.5);
    doc.fillColor('#1a1a1a').text(`${inv.no}    ${inv.date}`, MARGIN, doc.y);
    doc.moveDown(0.2);
    const lineRows = inv.lines.map((l) => [l.product, String(l.qty), rules.formatCents(l.unitCents), rules.formatCents(l.amountCents)]);
    lineRows.push(['合计', '', '', rules.formatCents(inv.totalCents)]);
    drawTable(doc, [
      { label: 'Product', width: 6 }, { label: 'Qty', width: 1, align: 'right' },
      { label: 'Unit Price', width: 1.6, align: 'right' }, { label: 'Amount RM', width: 2, align: 'right' }
    ], lineRows, { boldLast: true });
  });

  // ---- Footer on every page (needs bufferPages) ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow drawing inside the bottom margin without triggering a new page
    const y = doc.page.height - 38;
    doc.fillColor('#555555');
    setFont(doc, `Prepared by: ${preparedBy || ''}`, false, 8);
    doc.text(`Prepared by: ${preparedBy || ''}`, MARGIN, y, { width: 200, lineBreak: false });
    doc.font('Helvetica').fontSize(8).text('Checked & Approved by: ____________________', MARGIN + 210, y, { width: 200, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} / ${range.count}`, MARGIN + usableWidth(doc) - 70, y, { width: 70, align: 'right', lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }

  return doc;
}

module.exports = { buildReportPdf };
