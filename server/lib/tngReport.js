// The TNG / DuitNow QR Daily Settlement Report of one outlet as a formal PDF (A4 portrait) and as an Excel workbook, and the merged workbook of all outlets.
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const T = require('./tng');

const SYSTEM_NAME = 'CC CREST';
const TITLE = 'TNG / DuitNow QR Daily Settlement Report';
const NAVY = 'FF1F3A5F', ZEBRA = 'FFF2F4F7', WEEKEND = 'FFFFF4DC', GREYTXT = 'FF9AA3AD', LINE = 'FFB8C0CC';
const FONT_SC = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf');

const m2 = (c) => Math.round(c) / 100;                       // cents -> number with 2 decimals
const fmt = (c) => (c / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nowMy = () => { const d = new Date(Date.now() + 8 * 3600 * 1000); const p = (n) => String(n).padStart(2, '0'); return { date: p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(), time: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) }; };
const monthLabel = (period) => T.MONTH_NAMES[Number(period.slice(5, 7)) - 1] + ' ' + period.slice(0, 4);
const periodRange = (period) => T.dmy(period + '-01') + ' – ' + T.dmy(period + '-' + String(T.daysIn(period)).padStart(2, '0'));
const hasCjk = (s) => /[^\u0000-ɏ‐-‿]/.test(String(s || ''));

// everything one report needs
// ctx = { profile:{displayName, short, companyName, regNo}, meta, outletName, summary, sign:{preparedBy,preparedDate,checkedBy,checkedDate,approvedBy,approvedDate}, statementTotal (cents|null), allOutlets (bool: more than one outlet in the file) }
function columnsOf(summary) {
  const cols = [
    { k: 'no', h: 'No.', w: 20, al: 'center' }, { k: 'date', h: 'Date', w: 46, al: 'center' }, { k: 'dow', h: 'Day', w: 24, al: 'center' }, { k: 'settle', h: 'Settlement Date', w: 48, al: 'center' },
    { k: 'tng', h: 'TNG eWallet (RM)', num: true }, { k: 'duitnow', h: 'DuitNow QR (RM)', num: true }, { k: 'cb', h: 'Cross-Border QR (RM)', num: true }
  ];
  if (summary.hasOthers) cols.push({ k: 'others', h: 'Others (RM)', num: true });
  cols.push({ k: 'count', h: 'No. of Txn', w: 30, al: 'right', int: true }, { k: 'gross', h: 'Gross Amount (RM)', num: true });
  if (summary.hideCommission) cols.push({ k: 'commgst', h: 'Commission & GST (RM)', num: true });
  else cols.push({ k: 'comm', h: 'Commission (RM)', num: true }, { k: 'gst', h: 'Commission GST/SST (RM)', num: true });
  cols.push({ k: 'net', h: 'Net Settlement (RM)', num: true, bold: true });
  return cols;
}

function cellOf(col, d) {   // a day (or the total / outside row) -> the value of one column in cents / text
  switch (col.k) {
    case 'no': return d.no != null ? d.no : '';
    case 'date': return d.date || '';
    case 'dow': return d.dow || '';
    case 'settle': return d.settle ? T.dmy(d.settle) + (d.settleMany ? '*' : '') : '';
    case 'tng': case 'duitnow': case 'cb': case 'others': return d.type[col.k];
    case 'count': return d.count;
    case 'commgst': return d.comm + d.gst;
    default: return d[col.k];
  }
}

function recon(ctx) {
  const net = ctx.summary.totals.net;
  if (ctx.statementTotal == null) return { ok: false, neutral: true, text: 'No statement total row in the file to reconcile with' };
  if (!ctx.allOutlets) return Math.abs(net - ctx.statementTotal) < 1 ? { ok: true, text: 'Reconciled to MMSDO statement total: RM ' + fmt(ctx.statementTotal) } : { ok: false, text: 'Does NOT agree with the MMSDO statement total: RM ' + fmt(ctx.statementTotal) + ' (difference RM ' + fmt(net - ctx.statementTotal) + ')' };
  return { ok: true, neutral: true, text: 'Net settlement of this outlet RM ' + fmt(net) + ' · MMSDO statement total (all outlets) RM ' + fmt(ctx.statementTotal) };
}

// ============================================================ PDF ============================================================

function pdfBuffer(ctx) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 42.5, bottom: 50, left: 42.5, right: 42.5 }, bufferPages: true, info: { Title: ctx.profile.displayName + ' - ' + TITLE + ' - ' + ctx.meta.period, Author: SYSTEM_NAME } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    try { doc.registerFont('SC', FONT_SC); } catch (e) { /* the Chinese font is only for names with Chinese characters */ }
    const F = (text, bold) => (hasCjk(text) ? 'SC' : bold ? 'Helvetica-Bold' : 'Helvetica');
    const L = 42.5, R = doc.page.width - 42.5, W = R - L, BOTTOM = doc.page.height - 50;
    const sm = ctx.summary, cols = columnsOf(sm);
    const fixed = cols.filter((c) => c.w).reduce((a, c) => a + c.w, 0), nNum = cols.filter((c) => !c.w).length;
    cols.forEach((c) => { if (!c.w) c.w = (W - fixed) / nNum; });
    const fs = cols.length > 11 ? 7 : 8;
    let x0 = L; cols.forEach((c) => { c.x = x0; x0 += c.w; });
    let y = doc.page.margins.top;
    const text = (s, x, yy, w, o) => { doc.font(F(s, o && o.bold)).fontSize((o && o.size) || fs).fillColor((o && o.color) || '#111111').text(String(s), x, yy, { width: w, align: (o && o.align) || 'left', lineBreak: false, ellipsis: true }); };

    // header
    text(ctx.profile.companyName || ctx.profile.displayName, L, y, W, { size: 16, bold: true, align: 'center' }); y += 22;
    if (ctx.profile.regNo) { text('Company Reg. No.: ' + ctx.profile.regNo, L, y, W, { size: 9, align: 'center', color: '#444444' }); y += 13; }
    text(TITLE, L, y + 2, W, { size: 14, bold: true, align: 'center', color: '#1F3A5F' }); y += 24;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1.2).strokeColor('#1F3A5F').stroke(); y += 7;
    const info = [
      ['Outlet', ctx.profile.displayName + (ctx.profile.short ? ' (' + ctx.profile.short + ')' : ''), 'Report Month', monthLabel(ctx.meta.period)],
      ['Merchant ID / External MID', ctx.meta.externalMid || ctx.meta.merchantId || '-', 'Report Reference', ctx.meta.reference || '-'],
      ['Settlement Mode', ctx.mode || '-', 'Period', periodRange(ctx.meta.period)]
    ];
    const half = W / 2;
    for (const r of info) {
      text(r[0] + ':', L, y, 118, { size: 8.5, color: '#555555' }); text(r[1], L + 118, y, half - 122, { size: 9, bold: true });
      text(r[2] + ':', L + half, y, 78, { size: 8.5, color: '#555555' }); text(r[3], L + half + 78, y, half - 78, { size: 9, bold: true });
      y += 13;
    }
    y += 5;

    // the table
    const RH = 13, HH = 27;
    const drawHead = () => {
      doc.rect(L, y, W, HH).fill('#1F3A5F');
      cols.forEach((c) => { doc.font('Helvetica-Bold').fontSize(fs - 0.5).fillColor('#FFFFFF').text(c.h, c.x + 1.5, y + (c.h.length > 12 || c.h.includes(' ') ? 4 : 10), { width: c.w - 3, align: 'center', lineGap: 0.5 }); });
      y += HH;
    };
    const drawRow = (d, i, kind) => {
      if (y + RH > BOTTOM - (kind === 'total' ? 0 : 150)) { doc.addPage(); y = doc.page.margins.top; drawHead(); }
      const zero = kind === 'day' && !d.count;
      if (kind === 'day' && i % 2 === 1) doc.rect(L, y, W, RH).fill('#F2F4F7');
      if (kind === 'day' && (d.dow === 'Sat' || d.dow === 'Sun')) { const dc = cols.filter((c) => ['no', 'date', 'dow'].includes(c.k)); doc.rect(dc[0].x, y, dc.reduce((a, c) => a + c.w, 0), RH).fill('#FFF4DC'); }
      cols.forEach((c) => {
        let v = kind === 'total' && ['date', 'dow', 'settle'].includes(c.k) ? '' : cellOf(c, d);
        if (kind === 'total' && c.k === 'no') v = 'TOTAL';
        if (c.num) v = zero ? '0.00' : fmt(v); else if (c.int) v = String(v);
        text(v, c.k === 'no' && kind === 'total' ? L + 2 : c.x + 2, y + 3, c.k === 'no' && kind === 'total' ? 70 : c.w - 4, { align: kind === 'total' && c.k === 'no' ? 'left' : (c.num || c.int ? 'right' : c.al || 'left'), bold: kind === 'total' || c.bold, color: zero ? '#9AA3AD' : '#111111' });
      });
      doc.moveTo(L, y + RH).lineTo(R, y + RH).lineWidth(0.25).strokeColor('#D5DAE1').stroke();
      y += RH;
    };
    drawHead();
    sm.days.forEach((d, i) => drawRow(d, i, 'day'));
    if (sm.outside) { drawRow(Object.assign({ no: '', date: 'Other dates', dow: '', settle: '' }, sm.outside), 0, 'day'); }
    doc.moveTo(L, y + 1).lineTo(R, y + 1).lineWidth(0.8).strokeColor('#111111').stroke();
    doc.moveTo(L, y + 3).lineTo(R, y + 3).lineWidth(0.8).strokeColor('#111111').stroke(); y += 4;
    drawRow(Object.assign({ no: 'TOTAL', date: '', dow: '', settle: '' }, sm.totals), 0, 'total');
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.8).strokeColor('#111111').stroke();
    if (sm.days.some((d) => d.settleMany)) { y += 3; text('* more than one settlement date on that day: the latest is shown.', L, y, W, { size: 7, color: '#666666' }); y += 9; }
    y += 8;

    // Summary by payment type
    if (y + 100 > BOTTOM) { doc.addPage(); y = doc.page.margins.top; }
    text('Summary by Payment Type', L, y, 250, { size: 9.5, bold: true, color: '#1F3A5F' }); y += 13;
    const sw = [200, 60, 100, 60]; const sx = [L, L + 200, L + 260, L + 360];
    doc.rect(L, y, 420, 14).fill('#1F3A5F');
    ['Transaction Type', 'No. of Txn', 'Amount (RM)', 'Share %'].forEach((h, i) => { doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(h, sx[i] + 3, y + 3.5, { width: sw[i] - 6, align: i ? 'right' : 'left', lineBreak: false }); });
    y += 14;
    sm.types.forEach((t, i) => {
      if (i % 2) doc.rect(L, y, 420, 13).fill('#F2F4F7');
      const lab = T.TYPE_LABEL[t.key] + (t.key === 'others' || t.type !== (T.KNOWN_TYPES.find((k) => k.key === t.key) || {}).type ? ' (' + t.type + ')' : ' (' + t.type + ')');
      text(lab, sx[0] + 3, y + 3, sw[0] - 6, { size: 8 }); text(String(t.count), sx[1] + 3, y + 3, sw[1] - 6, { size: 8, align: 'right' }); text(fmt(t.amount), sx[2] + 3, y + 3, sw[2] - 6, { size: 8, align: 'right' }); text(t.pct.toFixed(2) + '%', sx[3] + 3, y + 3, sw[3] - 6, { size: 8, align: 'right' });
      y += 13;
    });
    doc.moveTo(L, y).lineTo(L + 420, y).lineWidth(0.8).strokeColor('#111111').stroke();
    text('TOTAL', sx[0] + 3, y + 3, sw[0] - 6, { size: 8, bold: true }); text(String(sm.totals.count), sx[1] + 3, y + 3, sw[1] - 6, { size: 8, bold: true, align: 'right' }); text(fmt(sm.totals.net), sx[2] + 3, y + 3, sw[2] - 6, { size: 8, bold: true, align: 'right' }); text('100.00%', sx[3] + 3, y + 3, sw[3] - 6, { size: 8, bold: true, align: 'right' });
    y += 17;

    // the reconciliation line
    const rc = recon(ctx);
    if (rc.ok && !rc.neutral) {   // a drawn tick (the fonts have no tick character)
      doc.save().lineWidth(1.6).strokeColor('#1F7A3D').moveTo(L + 1, y + 6).lineTo(L + 4.5, y + 9.5).lineTo(L + 10.5, y + 2).stroke().restore();
      text(rc.text, L + 15, y + 1, W - 15, { size: 8.5, bold: true, color: '#1F7A3D' });
    } else text(rc.text, L, y + 1, W, { size: 8.5, bold: !rc.neutral, color: rc.neutral ? '#444444' : '#B42318' });
    y += 16;
    if (sm.refunds.length) { text('Refund / negative transactions included above: ' + sm.refunds.length + ' (RM ' + fmt(sm.refunds.reduce((a, r) => a + r.net, 0)) + ')', L, y, W, { size: 8, color: '#9A6200' }); y += 12; }

    // signatures
    if (y + 62 > BOTTOM) { doc.addPage(); y = doc.page.margins.top; }
    y = Math.max(y + 6, Math.min(BOTTOM - 56, y + 6));
    const bw = (W - 20) / 3, sg = ctx.sign || {};
    [['Prepared By', sg.preparedBy, sg.preparedDate], ['Checked By', sg.checkedBy, sg.checkedDate], ['Approved By', sg.approvedBy, sg.approvedDate]].forEach((b, i) => {
      const bx = L + i * (bw + 10);
      text(b[0] + ':', bx, y, bw, { size: 8.5, bold: true });
      text(b[1] || '', bx + 2, y + 22, bw - 4, { size: 9 });
      doc.moveTo(bx, y + 34).lineTo(bx + bw, y + 34).lineWidth(0.6).strokeColor('#111111').stroke();
      text('Name', bx, y + 36, 40, { size: 6.5, color: '#666666' });
      text('Date:', bx, y + 46, 28, { size: 8.5, bold: true }); text(b[2] ? T.dmy(b[2]) : '', bx + 30, y + 46, bw - 30, { size: 9 });
      doc.moveTo(bx + 30, y + 55).lineTo(bx + bw, y + 55).lineWidth(0.4).strokeColor('#888888').stroke();
    });

    // footers: Generated by ... / Page x of y
    const gen = nowMy(), range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0;
      doc.moveTo(L, doc.page.height - 38).lineTo(R, doc.page.height - 38).lineWidth(0.4).strokeColor('#B8C0CC').stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor('#666666').text('Generated by ' + SYSTEM_NAME + ' on ' + gen.date + ' ' + gen.time, L, doc.page.height - 32, { width: W / 2, align: 'left', lineBreak: false });
      doc.text('Page ' + (p + 1) + ' of ' + range.count, L + W / 2, doc.page.height - 32, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ============================================================ Excel ============================================================

const THIN = { style: 'thin', color: { argb: LINE } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const MONEY = '#,##0.00';
const colL = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

// writes the Daily Summary page into worksheet `ws`; txSheet = the name of the Transactions sheet (formulas for the payment type summary) or null (values)
function writeDailySheet(ws, ctx, txSheet, txLastRow) {
  const sm = ctx.summary, cols = columnsOf(sm), n = cols.length, last = colL(n);
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.w ? Math.round(c.w / 3.6) + (c.k === 'settle' ? 6 : 1) : 15; });
  ws.getColumn(2).width = 12; ws.getColumn(4).width = 15;
  const merge = (r, v, o) => { ws.mergeCells(r, 1, r, n); const c = ws.getCell(r, 1); c.value = v; c.alignment = { horizontal: 'center', vertical: 'middle' }; c.font = Object.assign({ name: 'Arial' }, o); return c; };
  merge(1, ctx.profile.companyName || ctx.profile.displayName, { size: 16, bold: true }); ws.getRow(1).height = 26;
  let r = 2;
  if (ctx.profile.regNo) { merge(r, 'Company Reg. No.: ' + ctx.profile.regNo, { size: 9, color: { argb: 'FF444444' } }); r++; }
  const t = merge(r, TITLE, { size: 14, bold: true, color: { argb: NAVY } }); ws.getRow(r).height = 22; r++;
  for (let c = 1; c <= n; c++) ws.getCell(r - 1, c).border = { bottom: { style: 'medium', color: { argb: NAVY } } };
  r++;
  const mid = Math.ceil(n / 2) + 1;
  const info = [
    ['Outlet:', ctx.profile.displayName + (ctx.profile.short ? ' (' + ctx.profile.short + ')' : ''), 'Report Month:', monthLabel(ctx.meta.period)],
    ['Merchant ID / External MID:', ctx.meta.externalMid || ctx.meta.merchantId || '-', 'Report Reference:', ctx.meta.reference || '-'],
    ['Settlement Mode:', ctx.mode || '-', 'Period:', periodRange(ctx.meta.period)]
  ];
  for (const row of info) {
    ws.mergeCells(r, 1, r, 3); ws.mergeCells(r, 4, r, mid - 1); ws.mergeCells(r, mid, r, mid + 1); ws.mergeCells(r, mid + 2, r, n);
    const put = (c, v, bold) => { const x = ws.getCell(r, c); x.value = v; x.font = { name: 'Arial', size: 9, bold, color: { argb: bold ? 'FF111111' : 'FF555555' } }; x.alignment = { horizontal: 'left', vertical: 'middle' }; };
    put(1, row[0], false); put(4, row[1], true); put(mid, row[2], false); put(mid + 2, row[3], true);
    r++;
  }
  r++;
  const headRow = r;
  cols.forEach((c, i) => { const x = ws.getCell(r, i + 1); x.value = c.h; x.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; x.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; x.border = BORDER; });
  ws.getRow(r).height = 32; r++;
  const first = r;
  const dayRows = sm.days.concat(sm.outside ? [Object.assign({ no: '', date: 'Other dates', dow: '', settle: '' }, sm.outside)] : []);
  dayRows.forEach((d, i) => {
    const zero = !d.count, wk = d.dow === 'Sat' || d.dow === 'Sun';
    cols.forEach((c, j) => {
      const x = ws.getCell(r, j + 1); let v = cellOf(c, d);
      if (c.num) v = m2(v);
      x.value = v === '' ? null : v;
      x.font = { name: 'Arial', size: 9, bold: !!c.bold, color: { argb: zero ? GREYTXT : 'FF111111' } };
      x.alignment = { horizontal: c.num || c.int ? 'right' : (c.al || 'left'), vertical: 'middle' };
      if (c.num) x.numFmt = MONEY; if (c.int) x.numFmt = '0';
      x.border = BORDER;
      if (i % 2 === 1) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
      if (wk && ['no', 'date', 'dow'].includes(c.k)) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WEEKEND } };
    });
    r++;
  });
  const lastDay = r - 1;
  // TOTAL: formulas
  cols.forEach((c, j) => {
    const x = ws.getCell(r, j + 1);
    if (j === 0) x.value = 'TOTAL';
    else if (c.num || c.int) { x.value = { formula: 'SUM(' + colL(j + 1) + first + ':' + colL(j + 1) + lastDay + ')', result: c.int ? sm.totals.count : m2(c.k === 'commgst' ? sm.totals.comm + sm.totals.gst : c.k === 'tng' || c.k === 'duitnow' || c.k === 'cb' || c.k === 'others' ? sm.totals.type[c.k] : sm.totals[c.k]) }; x.numFmt = c.int ? '0' : MONEY; x.alignment = { horizontal: 'right' }; }
    x.font = { name: 'Arial', size: 9.5, bold: true };
    x.border = { top: { style: 'double', color: { argb: 'FF111111' } }, bottom: { style: 'thin', color: { argb: 'FF111111' } }, left: THIN, right: THIN };
  });
  const totalRow = r; r++;
  if (sm.days.some((d) => d.settleMany)) { ws.getCell(r, 1).value = '* more than one settlement date on that day: the latest is shown.'; ws.getCell(r, 1).font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF666666' } }; r++; }
  r++;
  // Summary by Payment Type
  ws.getCell(r, 1).value = 'Summary by Payment Type'; ws.getCell(r, 1).font = { name: 'Arial', size: 10, bold: true, color: { argb: NAVY } }; r++;
  const sh = ['Transaction Type', '', '', 'No. of Txn', 'Amount (RM)', 'Share %'];
  const sc = [1, 4, 5, 6];   // label spans A:C, count D, amount E, share F
  ws.mergeCells(r, 1, r, 3);
  [[1, 'Transaction Type'], [4, 'No. of Txn'], [5, 'Amount (RM)'], [6, 'Share %']].forEach(([c, h]) => { const x = ws.getCell(r, c); x.value = h; x.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; x.alignment = { horizontal: c === 1 ? 'left' : 'right' }; });
  r++;
  const sFirst = r;
  const totAmtCell = 'E' + (sFirst + sm.types.length);
  sm.types.forEach((t2, i) => {
    ws.mergeCells(r, 1, r, 3);
    const lab = T.TYPE_LABEL[t2.key] + ' (' + t2.type + ')';
    ws.getCell(r, 1).value = lab;
    if (txSheet) {
      ws.getCell(r, 4).value = { formula: 'COUNTIF(\'' + txSheet + '\'!$H$2:$H$' + txLastRow + ',"' + t2.type + '")', result: t2.count };
      ws.getCell(r, 5).value = { formula: 'SUMIF(\'' + txSheet + '\'!$H$2:$H$' + txLastRow + ',"' + t2.type + '",\'' + txSheet + '\'!$L$2:$L$' + txLastRow + ')', result: m2(t2.amount) };
    } else { ws.getCell(r, 4).value = t2.count; ws.getCell(r, 5).value = m2(t2.amount); }
    ws.getCell(r, 6).value = { formula: 'IF(' + totAmtCell + '=0,0,E' + r + '/' + totAmtCell + ')', result: t2.pct / 100 };
    ws.getCell(r, 5).numFmt = MONEY; ws.getCell(r, 6).numFmt = '0.00%'; ws.getCell(r, 4).numFmt = '0';
    for (let c = 1; c <= 6; c++) { const x = ws.getCell(r, c); x.font = { name: 'Arial', size: 9 }; x.border = BORDER; if (c > 3) x.alignment = { horizontal: 'right' }; if (i % 2) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }; }
    r++;
  });
  ws.mergeCells(r, 1, r, 3); ws.getCell(r, 1).value = 'TOTAL';
  ws.getCell(r, 4).value = { formula: 'SUM(D' + sFirst + ':D' + (r - 1) + ')', result: sm.totals.count };
  ws.getCell(r, 5).value = { formula: 'SUM(E' + sFirst + ':E' + (r - 1) + ')', result: m2(sm.totals.net) };
  ws.getCell(r, 6).value = { formula: 'SUM(F' + sFirst + ':F' + (r - 1) + ')', result: 1 };
  ws.getCell(r, 5).numFmt = MONEY; ws.getCell(r, 6).numFmt = '0.00%'; ws.getCell(r, 4).numFmt = '0';
  for (let c = 1; c <= 6; c++) { const x = ws.getCell(r, c); x.font = { name: 'Arial', size: 9, bold: true }; x.border = { top: { style: 'double', color: { argb: 'FF111111' } }, bottom: THIN, left: THIN, right: THIN }; if (c > 3) x.alignment = { horizontal: 'right' }; }
  r += 2;
  const rc = recon(ctx);
  ws.mergeCells(r, 1, r, n); ws.getCell(r, 1).value = (rc.ok && !rc.neutral ? '✓ ' : '') + rc.text;
  ws.getCell(r, 1).font = { name: 'Arial', size: 9.5, bold: !rc.neutral, color: { argb: rc.neutral ? 'FF444444' : rc.ok ? 'FF1F7A3D' : 'FFB42318' } };
  r++;
  if (sm.refunds.length) { ws.mergeCells(r, 1, r, n); ws.getCell(r, 1).value = 'Refund / negative transactions included above: ' + sm.refunds.length + ' (RM ' + fmt(sm.refunds.reduce((a, x) => a + x.net, 0)) + ')'; ws.getCell(r, 1).font = { name: 'Arial', size: 8.5, color: { argb: 'FF9A6200' } }; r++; }
  r += 2;
  // signatures
  const sg = ctx.sign || {}, per = Math.floor(n / 3);
  [['Prepared By', sg.preparedBy, sg.preparedDate], ['Checked By', sg.checkedBy, sg.checkedDate], ['Approved By', sg.approvedBy, sg.approvedDate]].forEach((b, i) => {
    const c1 = i * per + 1, c2 = i === 2 ? n : (i + 1) * per - 1;
    ws.mergeCells(r, c1, r, c2); ws.mergeCells(r + 1, c1, r + 1, c2); ws.mergeCells(r + 2, c1, r + 2, c2);
    ws.getCell(r, c1).value = b[0] + ':'; ws.getCell(r, c1).font = { name: 'Arial', size: 9, bold: true };
    ws.getCell(r + 1, c1).value = b[1] || ''; ws.getCell(r + 1, c1).font = { name: 'Arial', size: 9.5 };
    for (let c = c1; c <= c2; c++) ws.getCell(r + 1, c).border = { bottom: { style: 'thin', color: { argb: 'FF111111' } } };
    ws.getCell(r + 2, c1).value = 'Date: ' + (b[2] ? T.dmy(b[2]) : '____________'); ws.getCell(r + 2, c1).font = { name: 'Arial', size: 9 };
    ws.getRow(r + 1).height = 24;
  });
  const endRow = r + 2;
  ws.views = [{ state: 'frozen', ySplit: headRow, xSplit: 0, showGridLines: false }];
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.55, right: 0.55, top: 0.6, bottom: 0.7, header: 0.3, footer: 0.3 }, horizontalCentered: true, printArea: 'A1:' + last + endRow, printTitlesRow: headRow + ':' + headRow };
  ws.headerFooter = { oddFooter: '&L&8Generated by ' + SYSTEM_NAME + '&R&8Page &P of &N' };
  return { headRow, first, lastDay, totalRow };
}

function writeTransactions(ws, ctx) {
  const heads = ['No', 'Settlement Date', 'Transaction Datetime', 'Shop/Outlet Name', 'Shop/Outlet Location', 'Transaction Reference', 'Merchant Reference', 'Transaction Type', 'Transaction Amount (RM)', 'Commission Amount (RM)', 'Commission GST (RM)', 'Settlement Amount (RM)', 'Payment Details', 'Settlement Mode'];
  const widths = [7, 14, 20, 18, 18, 24, 34, 22, 14, 14, 14, 14, 20, 24];
  heads.forEach((h, i) => { ws.getColumn(i + 1).width = widths[i]; const x = ws.getCell(1, i + 1); x.value = h; x.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; x.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; x.border = BORDER; });
  ws.getRow(1).height = 30;
  const toDate = (ymd, hms) => { if (!ymd) return null; const [y, m, d] = ymd.split('-').map(Number); const [hh, mm, ss] = (hms || '00:00:00').split(':').map(Number); return new Date(Date.UTC(y, m - 1, d, hh, mm, ss)); };
  let r = 2;
  for (const t of ctx.summary.rows) {
    const vals = [t.no, toDate(t.settleDate), toDate(t.txnDate, t.txnTime), t.outlet, t.location, t.txnRef, t.merRef, t.type, m2(t.gross), m2(t.comm), m2(t.gst), m2(t.net), t.details, t.mode];
    vals.forEach((v, i) => { const x = ws.getCell(r, i + 1); x.value = v === '' ? null : v; x.font = { name: 'Arial', size: 9 }; if (i === 1) x.numFmt = 'dd/mm/yyyy'; if (i === 2) x.numFmt = 'dd/mm/yyyy hh:mm:ss'; if (i >= 8 && i <= 11) { x.numFmt = MONEY; x.alignment = { horizontal: 'right' }; } if (i === 5 || i === 6) x.numFmt = '@'; });
    r++;
  }
  const lastTx = r - 1;
  ws.getCell(r, 8).value = 'Total:';
  const keyOf = { 9: 'gross', 10: 'comm', 11: 'gst', 12: 'net' };
  [9, 10, 11, 12].forEach((c) => { const x = ws.getCell(r, c); x.value = { formula: 'SUM(' + colL(c) + '2:' + colL(c) + lastTx + ')', result: m2(ctx.summary.rows.reduce((a, t) => a + t[keyOf[c]], 0)) }; x.numFmt = MONEY; x.alignment = { horizontal: 'right' }; });
  for (let c = 1; c <= 14; c++) { const x = ws.getCell(r, c); x.font = { name: 'Arial', size: 9, bold: true }; x.border = { top: { style: 'double', color: { argb: 'FF111111' } } }; }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, lastTx), column: 14 } };
  ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: true }];
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  ws.headerFooter = { oddFooter: '&L&8Generated by ' + SYSTEM_NAME + '&R&8Page &P of &N' };
  return lastTx;
}

async function excelBuffer(ctx) {
  const wb = new ExcelJS.Workbook(); wb.creator = SYSTEM_NAME; wb.created = new Date();
  const ds = wb.addWorksheet('Daily Summary'), tx = wb.addWorksheet('Transactions');
  const lastTx = writeTransactions(tx, ctx);
  writeDailySheet(ds, ctx, 'Transactions', Math.max(2, lastTx));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// one workbook with every outlet (a sheet each) and an All Outlets sheet: the net settlement of each outlet side by side per day
async function mergedBuffer(items, meta, companyLabel) {
  const wb = new ExcelJS.Workbook(); wb.creator = SYSTEM_NAME; wb.created = new Date();
  const all = wb.addWorksheet('All Outlets');
  const used = new Set(['All Outlets']);
  const names = items.map((c) => { let nm = String(c.profile.short || c.profile.displayName || 'Outlet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Outlet'; let k = nm, i = 2; while (used.has(k)) k = nm.slice(0, 25) + ' ' + i++; used.add(k); return k; });
  items.forEach((c, i) => writeDailySheet(wb.addWorksheet(names[i]), c, null, 0));
  const n = items.length + 3;
  all.mergeCells(1, 1, 1, n); all.getCell(1, 1).value = companyLabel || ''; all.getCell(1, 1).font = { name: 'Arial', size: 15, bold: true }; all.getCell(1, 1).alignment = { horizontal: 'center' };
  all.mergeCells(2, 1, 2, n); all.getCell(2, 1).value = TITLE + ' — All Outlets — ' + monthLabel(meta.period); all.getCell(2, 1).font = { name: 'Arial', size: 12, bold: true, color: { argb: NAVY } }; all.getCell(2, 1).alignment = { horizontal: 'center' };
  const hr = 4, heads = ['No.', 'Date', 'Day'].concat(items.map((c) => (c.profile.short || c.profile.displayName) + ' (RM)'), ['Total (RM)']);
  heads.forEach((h, i) => { const x = all.getCell(hr, i + 1); x.value = h; x.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; x.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; x.border = BORDER; all.getColumn(i + 1).width = i < 3 ? (i === 1 ? 12 : 8) : 17; });
  all.getRow(hr).height = 30;
  const days = items[0].summary.days;
  days.forEach((d, i) => {
    const r = hr + 1 + i;
    const vals = [d.no, d.date, d.dow].concat(items.map((c) => m2(c.summary.days[i].net)));
    vals.forEach((v, j) => { const x = all.getCell(r, j + 1); x.value = v; x.font = { name: 'Arial', size: 9 }; x.border = BORDER; if (j >= 3) { x.numFmt = MONEY; x.alignment = { horizontal: 'right' }; } else x.alignment = { horizontal: 'center' }; if (i % 2) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }; });
    const tc = all.getCell(r, n); tc.value = { formula: 'SUM(' + colL(4) + r + ':' + colL(n - 1) + r + ')', result: m2(items.reduce((a, c) => a + c.summary.days[i].net, 0)) }; tc.numFmt = MONEY; tc.font = { name: 'Arial', size: 9, bold: true }; tc.border = BORDER; tc.alignment = { horizontal: 'right' };
  });
  const tr = hr + 1 + days.length;
  all.getCell(tr, 1).value = 'TOTAL';
  for (let c = 4; c <= n; c++) { const x = all.getCell(tr, c); x.value = { formula: 'SUM(' + colL(c) + (hr + 1) + ':' + colL(c) + (tr - 1) + ')', result: m2(c === n ? items.reduce((a, it) => a + it.summary.totals.net, 0) : items[c - 4].summary.totals.net) }; x.numFmt = MONEY; x.alignment = { horizontal: 'right' }; }
  for (let c = 1; c <= n; c++) { const x = all.getCell(tr, c); x.font = { name: 'Arial', size: 9.5, bold: true }; x.border = { top: { style: 'double', color: { argb: 'FF111111' } }, bottom: THIN, left: THIN, right: THIN }; }
  all.views = [{ state: 'frozen', ySplit: hr, showGridLines: false }];
  all.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: 'A1:' + colL(n) + tr, printTitlesRow: hr + ':' + hr };
  all.headerFooter = { oddFooter: '&L&8Generated by ' + SYSTEM_NAME + '&R&8Page &P of &N' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { pdfBuffer, excelBuffer, mergedBuffer, monthLabel, periodRange, SYSTEM_NAME };
