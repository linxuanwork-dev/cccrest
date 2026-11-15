// Monthly salary summary as one form: a column per person (grouped Director salary / Salaries / Wages, each group with a sub total) and a TOTAL column,
// the rows going down: income, employee contribution, net salary, employer contribution, total contribution (EPF / SOCSO / EIS to pay) and the PCB figures.
const path = require('path');
const PDFDocument = require('pdfkit');

const CJK_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
const INK = '#000000', CREAM = '#fff2cc', GREY = '#808080';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Math.abs(Number(n) || 0) < 0.005 ? '-' : (Number(n)).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const font = (doc, text, bold, size) => doc.font(CJK_RE.test(String(text)) ? 'CJK' : bold ? 'Times-Bold' : 'Times-Roman').fontSize(size);

const KEYS = ['basic', 'ot', 'allowance', 'incentive', 'commission', 'other', 'gross', 'epfEmp', 'socsoEmp', 'skbbk', 'eisEmp', 'pcb', 'deduction', 'advance', 'net',
  'epfEr', 'socsoEr', 'eisEr', 'erTotal', 'epfWage'];
const sum = (list) => { const o = {}; KEYS.forEach((k) => { o[k] = r2(list.reduce((a, p) => a + (Number(p.v[k]) || 0), 0)); }); return o; };

// rows: [label, kind, fn(v) | null]; kind: 'head' (section title), 'row', 'tot' (boxed total), 'gap', 'tot2' (boxed total with cream label), 'text'
const ROWS = [
  ['INCOME:-', 'head'],
  ['Basic Pay', 'row', (v) => v.basic], ['Overtime', 'row', (v) => v.ot], ['Allowance', 'row', (v) => v.allowance], ['Incentive', 'row', (v) => v.incentive], ['Commission', 'row', (v) => v.commission], ['Other', 'row', (v) => v.other],
  ['Total Earnings', 'tot', (v) => v.gross],
  [null, 'gap'],
  ['EMPLOYEE CONTRIBUTION', 'head'],
  ['EPF', 'row', (v) => v.epfEmp], ['Socso', 'row', (v) => v.socsoEmp], ['Socso (Non-Employment Injury)', 'row', (v) => v.skbbk], ['EIS', 'row', (v) => v.eisEmp], ['PCB', 'row', (v) => v.pcb],
  ['Total Deduction', 'tot2', (v) => v.deduction],
  [null, 'gap'],
  ['Advance', 'tot', (v) => v.advance],
  [null, 'gap'],
  ['Net Salary', 'tot', (v) => v.net],
  [null, 'gap'],
  ['EMPLOYER CONTRIBUTION', 'head'],
  ['EPF', 'row', (v) => v.epfEr], ['Socso', 'row', (v) => v.socsoEr], ['EIS', 'row', (v) => v.eisEr],
  ['Total Employer Contribution', 'tot2', (v) => v.erTotal],
  [null, 'gap'],
  ['Date', 'text', 'date'], ['Journal', 'text', 'journal'],
  [null, 'gap'],
  ['TOTAL CONTRIBUTION', 'head'],
  ['EPF', 'row', (v) => r2(v.epfEmp + v.epfEr)], ['Socso', 'row', (v) => r2(v.socsoEmp + v.socsoEr)], ['Socso (Non-Employment Injury)', 'row', (v) => v.skbbk], ['EIS', 'row', (v) => r2(v.eisEmp + v.eisEr)],
  [null, 'gap'],
  ['TOTAL SOCSO', 'row', (v) => r2(v.socsoEmp + v.socsoEr + v.skbbk)], ['SOCSO + EIS', 'row', (v) => r2(v.socsoEmp + v.socsoEr + v.skbbk + v.eisEmp + v.eisEr)],
  [null, 'gap'],
  ['EPF-EXCLUDE OT', 'row', (v) => v.epfWage], ['LHDN-EMPLOYEE SOCSO + EIS', 'row', (v) => r2(v.socsoEmp + v.skbbk + v.eisEmp)]
];

// people: [{ name, group: 'DIRECTOR SALARY' | 'SALARIES' | 'WAGES', v: {...KEYS} }]
function buildSalarySummaryPdf({ company, month, people, journal, date }) {
  const order = ['DIRECTOR SALARY', 'SALARIES', 'WAGES'];
  const groups = order.map((g) => ({ g, list: people.filter((p) => p.group === g) })).filter((x) => x.list.length);
  const cols = [];
  groups.forEach((x) => { x.list.forEach((p) => cols.push({ kind: 'p', g: x.g, name: p.name, v: p.v })); cols.push({ kind: 'sub', g: x.g, name: 'SUB TOTAL-' + x.g, v: sum(x.list) }); });
  cols.push({ kind: 'tot', g: '', name: 'TOTAL', v: sum(people) });
  const perPage = cols.length > 6 ? 10 : 6;
  const landscape = cols.length > 6;
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margins: { top: 34, left: 34, right: 34, bottom: 4 }, bufferPages: true });
  doc.registerFont('CJK', CJK_FONT_PATH);
  const W = doc.page.width - 68, labelW = 168, colW = Math.min(80, (W - labelW) / Math.min(perPage, cols.length));
  const [yy, mm] = String(month).split('-');
  // chunks of columns; sub totals / total stay with their group but a page may end in the middle of a group
  const pages = [];
  for (let i = 0; i < cols.length; i += perPage) pages.push(cols.slice(i, i + perPage));
  // everything on one page: the row height follows the number of rows
  const units = ROWS.reduce((a, r) => a + (r[1] === 'gap' ? 0.6 : r[1] === 'head' ? 1.1 : 1), 0);
  const rowH = Math.max(8.6, Math.min(13.4, (doc.page.height - 34 - 20 - 118) / units)), size = Math.max(6.6, Math.min(9, rowH - 4.4));
  pages.forEach((chunk, pi) => {
    if (pi) doc.addPage();
    let y = 34;
    font(doc, company, true, 15); doc.fillColor(INK).text(company || '', 34, y, { lineBreak: false }); y += 24;
    font(doc, 'x', true, 11); doc.text('SALARIES SUMMARY FOR', 34, y, { lineBreak: false }); doc.text(yy, 34 + 160, y, { lineBreak: false }); y += 20;
    font(doc, 'x', true, 14); doc.text('MONTH:', 34, y, { lineBreak: false }); doc.text(MONTHS[Number(mm) - 1] || mm, 34 + 85, y, { lineBreak: false }); y += 24;
    const x0 = 34 + labelW, tw = chunk.length * colW;
    // group header: runs of the same group
    let x = x0; let k = 0;
    while (k < chunk.length) {
      let j = k; while (j + 1 < chunk.length && chunk[j + 1].g === chunk[k].g) j++;
      const w = (j - k + 1) * colW; const title = chunk[k].kind === 'tot' ? '' : chunk[k].g;
      if (title) { doc.rect(x, y, w, 18).fillAndStroke(CREAM, INK); font(doc, title, false, size); doc.fillColor(INK).text(title, x, y + 5, { width: w, align: 'center', lineBreak: false }); }
      x += w; k = j + 1;
    }
    y += 18;
    // names
    const nameH = 26;
    font(doc, 'Name', true, size); doc.fillColor(INK).text('Name', 34, y + nameH - 12, { lineBreak: false });
    chunk.forEach((c, i) => {
      const cx = x0 + i * colW, grey = c.kind === 'sub';
      doc.lineWidth(0.6).rect(cx, y, colW, nameH).fillAndStroke(grey ? GREY : '#ffffff', INK);
      font(doc, c.name, grey || c.kind === 'tot', grey ? 6.5 : size - 0.5); doc.fillColor(grey ? '#ffffff' : INK).text(c.name, cx + 2, y + (grey ? 4 : 5), { width: colW - 4, align: 'center', height: nameH - 4 });
    });
    y += nameH;
    ROWS.forEach(([label, kind, fn]) => {
      if (kind === 'gap') { y += rowH * 0.6; return; }
      if (kind === 'head') { font(doc, label, true, size); doc.fillColor(INK).text(label, 34, y + 2, { lineBreak: false }); y += rowH + 1; return; }
      const big = kind === 'tot' || kind === 'tot2';
      doc.lineWidth(big ? 1.6 : 0.5);
      // label cell
      if (kind === 'tot2') { doc.rect(34, y, labelW - 4, rowH).fillAndStroke(CREAM, INK); } else if (big || kind === 'text') { doc.rect(34, y, labelW - 4, rowH).stroke(INK); } else { doc.rect(34, y, labelW - 4, rowH).lineWidth(0.4).stroke(INK); }
      font(doc, label, big, size); doc.fillColor(INK).text(label, 37, y + 2, { width: labelW - 10, lineBreak: false });
      chunk.forEach((c, i) => {
        const cx = x0 + i * colW;
        doc.lineWidth(big ? 1.6 : 0.4).rect(cx, y, colW, rowH).stroke(INK);
        let t = '';
        if (kind === 'text') t = c.kind === 'p' && cols.indexOf(c) === 0 ? (fn === 'date' ? date : journal) : '';
        else t = fmt(fn(c.v));
        if (t) { font(doc, t, big, size); doc.fillColor(INK).text(t, cx, y + 2, { width: colW - 4, align: kind === 'text' ? 'left' : 'right', lineBreak: false }); }
      });
      y += rowH;
    });
    if (pages.length > 1) { font(doc, 'x', false, 7); doc.fillColor(GREY).text('Page ' + (pi + 1) + ' of ' + pages.length, doc.page.width - 110, 34, { width: 76, align: 'right', lineBreak: false }); }
  });
  return doc;
}

module.exports = { buildSalarySummaryPdf };
