const ExcelJS = require('exceljs');
const rules = require('./ukTngReportRules');

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

const COLUMN_ALIASES = {
  settlementDate: ['settlement date'],
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
    if (values.some((v) => v.includes('settlement date')) && values.some((v) => v.includes('settlement amount')) && values.some((v) => v.includes('shop/outlet name'))) {
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

function findMmsdoSheet(wb) {
  const byName = wb.worksheets.find((ws) => /^mmsdo_p_/i.test(ws.name));
  if (byName) return byName;
  return wb.worksheets.find((ws) => findHeaderRow(ws)) || wb.worksheets[0];
}

function parseMmsdoWorkbook(wb) {
  const ws = findMmsdoSheet(wb);
  if (!ws) throw new Error('The file has no sheets.');

  const header = findHeaderRow(ws);
  if (!header) throw new Error('Could not find the transaction table header row (expected columns like "Settlement Date", "Shop/Outlet Name", and "Settlement Amount (RM)").');

  const dateIdx = colIndex(header.values, 'settlementDate');
  const outletIdx = colIndex(header.values, 'outletName');
  const typeIdx = colIndex(header.values, 'transactionType');
  const amtIdx = colIndex(header.values, 'settlementAmount');
  const commAmtIdx = colIndex(header.values, 'commissionAmount');
  const commGstIdx = colIndex(header.values, 'commissionGst');

  if (dateIdx === -1 || outletIdx === -1 || amtIdx === -1 || typeIdx === -1) {
    throw new Error('Could not locate the required columns (Settlement Date, Shop/Outlet Name, Transaction Type, Settlement Amount (RM)) in the header row.');
  }

  const byOutlet = {};
  rules.OUTLETS.filter((o) => o.fromReport).forEach((o) => { byOutlet[o.key] = []; });

  const monthsSeen = {};
  const unrecognizedOutlets = new Set();

  for (let r = header.rowNum + 1; r <= ws.rowCount; r++) {
    const cells = rowCells(ws.getRow(r));
    const outletRaw = cellText(cells[outletIdx]);
    const type = cellText(cells[typeIdx]);
    if (!outletRaw || type === 'Total:' || !type) continue;

    const outlet = rules.findOutletByName(outletRaw);
    if (!outlet) {
      unrecognizedOutlets.add(outletRaw);
      continue;
    }

    if (!rules.VALID_TYPES.includes(type)) {
      throw new Error(`Unrecognized transaction type "${type}" on row ${r} (${outlet.label}) — please check with the payment gateway before generating this report.`);
    }
    if (commAmtIdx !== -1) {
      const commAmt = Number(cellText(cells[commAmtIdx])) || 0;
      if (commAmt !== 0) throw new Error(`Non-zero Commission Amount found on row ${r} (${outlet.label}) — this report format does not currently handle fees. Please check manually.`);
    }
    if (commGstIdx !== -1) {
      const commGst = Number(cellText(cells[commGstIdx])) || 0;
      if (commGst !== 0) throw new Error(`Non-zero Commission GST found on row ${r} (${outlet.label}) — this report format does not currently handle fees. Please check manually.`);
    }

    const dt = parseDateValue(cells[dateIdx]);
    if (!dt) throw new Error(`Could not parse Settlement Date on row ${r} ("${cellText(cells[dateIdx])}").`);

    const amount = Number(cellText(cells[amtIdx])) || 0;
    const year = dt.getFullYear();
    const month = dt.getMonth() + 1;
    const day = dt.getDate();
    monthsSeen[`${year}-${month}`] = true;
    byOutlet[outlet.key].push({ day, amount });
  }

  if (unrecognizedOutlets.size > 0) {
    throw new Error(`Found rows for an unrecognized outlet: "${[...unrecognizedOutlets].join('", "')}" — this doesn't match any known UK outlet (UKD Noodle, UKTN, UKTU, UKHP). Please check the file.`);
  }

  const totalTxns = Object.values(byOutlet).reduce((s, arr) => s + arr.length, 0);
  if (totalTxns === 0) throw new Error('No transaction rows were found for any known outlet in this file.');

  const monthKeys = Object.keys(monthsSeen);
  if (monthKeys.length > 1) {
    throw new Error(`Transactions span more than one calendar month (${monthKeys.join(', ')}) — this report expects a single month. Please check the file.`);
  }

  const [year, month] = monthKeys[0].split('-').map(Number);
  return { year, month, byOutlet };
}

// Parses lines like "5,120.50" or "5 120.50" (day, amount) pasted by staff for Uncle Koh.
function parseUncleKohInput(text) {
  const transactions = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/[,\t]|\s+/).filter(Boolean);
    if (parts.length < 2) throw new Error(`Could not parse Uncle Koh line "${trimmed}" — expected "day,amount" per line.`);
    const day = Number(parts[0]);
    const amount = Number(parts[1]);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(`Invalid day "${parts[0]}" in Uncle Koh input.`);
    if (isNaN(amount)) throw new Error(`Invalid amount "${parts[1]}" in Uncle Koh input.`);
    transactions.push({ day, amount });
  });
  return transactions;
}

function buildCoverSheet(wb, data) {
  const ws = wb.addWorksheet('Cover');
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 40;
  ws.getCell('A1').value = `UK-TNG REPORT — ${rules.pad2(data.month)}/${data.year}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A3').value = 'Contents';
  ws.getCell('A3').font = { bold: true };
  let r = 4;
  rules.OUTLETS.forEach((o) => {
    ws.getCell(r, 1).value = `Summary - ${o.label}`;
    r++;
    ws.getCell(r, 1).value = `BUKKU - ${o.label}`;
    if (data.excludedOutlets && data.excludedOutlets.includes(o.key)) {
      ws.getCell(r, 2).value = 'Excluded from this month\'s Bukku payment import';
    }
    r++;
  });
}

function buildSummarySheet(wb, outlet, transactions, year, month) {
  const ws = wb.addWorksheet(`Summary - ${outlet.label}`.slice(0, 31));
  const headers = ['Day', 'Transaction Date', 'Settlement Amount (RM)', 'Transaction Count'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true };
  });
  ws.getColumn(1).width = 6;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 22;
  ws.getColumn(4).width = 18;

  const byDay = rules.aggregateByDay(transactions);
  const lastDay = rules.daysInMonth(year, month);
  let totalAmount = 0;
  let totalCount = 0;

  for (let day = 1; day <= lastDay; day++) {
    const agg = byDay[day] || { amount: 0, count: 0 };
    const r = day + 1;
    ws.getCell(r, 1).value = day;
    const dateCell = ws.getCell(r, 2);
    dateCell.value = new Date(year, month - 1, day);
    dateCell.numFmt = 'dd/mm/yyyy';
    const amtCell = ws.getCell(r, 3);
    amtCell.value = agg.amount;
    amtCell.numFmt = '#,##0.00';
    ws.getCell(r, 4).value = agg.count;
    totalAmount += agg.amount;
    totalCount += agg.count;
  }

  const totalRow = lastDay + 2;
  ws.getCell(totalRow, 1).value = 'Total';
  ws.getCell(totalRow, 1).font = { bold: true };
  const totalAmtCell = ws.getCell(totalRow, 3);
  totalAmtCell.value = totalAmount;
  totalAmtCell.numFmt = '#,##0.00';
  totalAmtCell.font = { bold: true };
  const totalCntCell = ws.getCell(totalRow, 4);
  totalCntCell.value = totalCount;
  totalCntCell.font = { bold: true };

  return { totalAmount, totalCount };
}

function buildWorkbook(data) {
  // data: { year, month, byOutlet: { UKD_NOODLE: [{day,amount}], ..., UNCLE_KOH: [...] }, excludedOutlets: ['UKD_NOODLE'] }
  const wb = new ExcelJS.Workbook();
  buildCoverSheet(wb, data);

  const summaryTotals = {};
  rules.OUTLETS.forEach((outlet) => {
    const transactions = data.byOutlet[outlet.key] || [];
    summaryTotals[outlet.key] = buildSummarySheet(wb, outlet, transactions, data.year, data.month);
  });

  return { workbook: wb, summaryTotals };
}

module.exports = { parseMmsdoWorkbook, parseUncleKohInput, buildWorkbook, buildCoverSheet, buildSummarySheet };
