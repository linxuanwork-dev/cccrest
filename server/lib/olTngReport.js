const ExcelJS = require('exceljs');
const rules = require('./olTngReportRules');

const THIN_BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return String(v.result).trim();
    if (v.richText) return v.richText.map((p) => p.text).join('').trim();
  }
  return String(v).trim();
}

function rowCells(row) {
  const vals = row.values || [];
  const out = [];
  for (let i = 1; i < vals.length; i++) out[i - 1] = vals[i];
  return out;
}

function parseDateValue(raw) {
  if (raw instanceof Date) return raw;
  if (raw && typeof raw === 'object' && raw.result != null) return parseDateValue(raw.result);
  if (typeof raw === 'number') return new Date(Math.round((raw - 25569) * 86400 * 1000));
  const str = String(raw || '').trim();
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  }
  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function parseHeaderMeta(ws) {
  let companyName = null;
  for (let r = 1; r <= 10 && !companyName; r++) {
    const label = cellText(ws.getCell(r, 1).value).toLowerCase();
    if (label.includes('merchant company name')) companyName = cellText(ws.getCell(r, 2).value);
  }
  if (!companyName) {
    for (let r = 1; r <= 10 && !companyName; r++) {
      const label = cellText(ws.getCell(r, 1).value).toLowerCase();
      if (label.includes('merchant name')) companyName = cellText(ws.getCell(r, 2).value);
    }
  }
  return companyName || null;
}

const COLUMN_ALIASES = {
  transactionDatetime: ['transaction datetime'],
  outletName: ['shop/outlet name', 'shop / outlet name'],
  transactionType: ['transaction type'],
  settlementAmount: ['settlement amount (rm)', 'settlement amount(rm)'],
  commissionAmount: ['commission amount (rm)', 'commission amount(rm)'],
  commissionGst: ['commission gst (rm)', 'commission gst(rm)']
};

function findHeaderRow(ws) {
  const limit = Math.min(ws.rowCount, 20);
  for (let r = 1; r <= limit; r++) {
    const values = rowCells(ws.getRow(r)).map((v) => cellText(v).toLowerCase());
    if (values.some((v) => v.includes('transaction datetime')) && values.some((v) => v.includes('settlement amount'))) {
      return { rowNum: r, values };
    }
  }
  return null;
}

function colIndex(values, aliasKey) {
  const aliases = COLUMN_ALIASES[aliasKey];
  for (let i = 0; i < values.length; i++) {
    if (aliases.includes(values[i])) return i;
  }
  return -1;
}

function parseMmsdoWorkbook(wb) {
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The file has no sheets.');

  const companyName = parseHeaderMeta(ws);
  if (!companyName) throw new Error('Could not find "Merchant Company Name" or "Merchant Name" in the file header — check this is a genuine MMSDO settlement report.');

  const header = findHeaderRow(ws);
  if (!header) throw new Error('Could not find the transaction table header row (expected columns like "Transaction Datetime" and "Settlement Amount (RM)").');

  const dtIdx = colIndex(header.values, 'transactionDatetime');
  const outletIdx = colIndex(header.values, 'outletName');
  const typeIdx = colIndex(header.values, 'transactionType');
  const amtIdx = colIndex(header.values, 'settlementAmount');
  const commAmtIdx = colIndex(header.values, 'commissionAmount');
  const commGstIdx = colIndex(header.values, 'commissionGst');

  if (dtIdx === -1 || amtIdx === -1 || typeIdx === -1) {
    throw new Error('Could not locate the required columns (Transaction Datetime, Transaction Type, Settlement Amount (RM)) in the header row.');
  }

  const transactions = [];
  const monthsSeen = {};

  for (let r = header.rowNum + 1; r <= ws.rowCount; r++) {
    const cells = rowCells(ws.getRow(r));
    const outlet = outletIdx !== -1 ? cellText(cells[outletIdx]) : 'x';
    const type = cellText(cells[typeIdx]);
    if (!outlet || type === 'Total:' || !type) continue;

    if (!rules.VALID_TYPES.includes(type)) {
      throw new Error(`Unrecognized transaction type "${type}" on row ${r} — please check with the payment gateway before generating this report.`);
    }

    if (commAmtIdx !== -1) {
      const commAmt = Number(cellText(cells[commAmtIdx])) || 0;
      if (commAmt !== 0) throw new Error(`Non-zero Commission Amount found on row ${r} — this report format does not currently handle fees. Please check manually.`);
    }
    if (commGstIdx !== -1) {
      const commGst = Number(cellText(cells[commGstIdx])) || 0;
      if (commGst !== 0) throw new Error(`Non-zero Commission GST found on row ${r} — this report format does not currently handle fees. Please check manually.`);
    }

    const dt = parseDateValue(cells[dtIdx]);
    if (!dt) throw new Error(`Could not parse Transaction Datetime on row ${r} ("${cellText(cells[dtIdx])}").`);

    const amount = Number(cellText(cells[amtIdx])) || 0;
    const year = dt.getFullYear();
    const month = dt.getMonth() + 1;
    const day = dt.getDate();
    monthsSeen[`${year}-${month}`] = true;
    transactions.push({ year, month, day, amount });
  }

  if (transactions.length === 0) throw new Error('No transaction rows were found in this file.');

  const monthKeys = Object.keys(monthsSeen);
  if (monthKeys.length > 1) {
    throw new Error(`Transactions span more than one calendar month (${monthKeys.join(', ')}) — this report expects a single month. Please check the file.`);
  }

  const [year, month] = monthKeys[0].split('-').map(Number);
  return { companyName, year, month, transactions };
}

function buildDailySettlementWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');

  ws.getColumn(1).width = 7.3;
  ws.getColumn(2).width = 18.1;
  ws.getColumn(3).width = 27.3;
  ws.getColumn(4).width = 23.6;

  ws.getCell('A1').value = 'Company Name:';
  ws.getCell('B1').value = data.companyName;

  ws.mergeCells('A2:D2');
  const titleCell = ws.getCell('A2');
  titleCell.value = `Daily Settlement Report - ${rules.MONTH_NAMES[data.month - 1]} ${data.year}`;
  titleCell.font = { bold: true, size: 14 };

  ws.getCell('A4').value = 'Report Month:';
  const monthCell = ws.getCell('C4');
  monthCell.value = new Date(data.year, data.month - 1, 1);
  monthCell.numFmt = 'mmm-yy';

  const HEADER_ROW = 6;
  ['Day', 'Date', 'Settlement Amount (RM)', 'Transaction Count'].forEach((h, i) => {
    const cell = ws.getCell(HEADER_ROW, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = THIN_BORDER;
  });

  const byDay = rules.aggregateByDay(data.transactions);
  const lastDay = rules.daysInMonth(data.year, data.month);
  let totalAmount = 0;
  let totalCount = 0;

  for (let day = 1; day <= 31; day++) {
    const r = HEADER_ROW + day;
    const dayCell = ws.getCell(r, 1);
    dayCell.value = day;
    dayCell.border = THIN_BORDER;
    if (day > lastDay) {
      dayCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      continue;
    }
    const agg = byDay[day] || { amount: 0, count: 0 };
    const dateCell = ws.getCell(r, 2);
    dateCell.value = new Date(data.year, data.month - 1, day);
    dateCell.numFmt = 'dd/mm/yyyy';
    const amtCell = ws.getCell(r, 3);
    amtCell.value = agg.amount;
    amtCell.numFmt = '#,##0.00';
    const cntCell = ws.getCell(r, 4);
    cntCell.value = agg.count;
    [dateCell, amtCell, cntCell].forEach((c) => { c.border = THIN_BORDER; });
    totalAmount += agg.amount;
    totalCount += agg.count;
  }

  const totalRow = HEADER_ROW + 32;
  const totalLabel = ws.getCell(totalRow, 1);
  totalLabel.value = 'Total';
  const totalAmt = ws.getCell(totalRow, 3);
  totalAmt.value = totalAmount;
  totalAmt.numFmt = '#,##0.00';
  const totalCnt = ws.getCell(totalRow, 4);
  totalCnt.value = totalCount;
  [totalLabel, ws.getCell(totalRow, 2), totalAmt, totalCnt].forEach((c) => {
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
    c.border = THIN_BORDER;
  });

  const createRow = totalRow + 2;
  const approveRow = totalRow + 3;
  ws.getCell(createRow, 1).value = 'CREATE BY:';
  ws.getCell(createRow, 2).value = data.createdBy;
  ws.getCell(createRow, 3).value = 'Date:';
  ws.getCell(createRow, 4).value = data.createdDate;
  ws.getCell(approveRow, 1).value = 'APPROVED BY:';
  ws.getCell(approveRow, 2).value = data.approvedBy;
  ws.getCell(approveRow, 3).value = 'Date:';
  ws.getCell(approveRow, 4).value = data.approvedDate;
  [createRow, approveRow].forEach((rn) => {
    for (let c = 1; c <= 4; c++) ws.getCell(rn, c).font = { size: 9, color: { argb: 'FF666666' } };
  });

  return wb;
}

module.exports = { parseMmsdoWorkbook, buildDailySettlementWorkbook };
