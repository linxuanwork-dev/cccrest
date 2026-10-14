const path = require('path');
const ExcelJS = require('exceljs');
const rules = require('./dailySalesRules');

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'sale-invoice-template-extended-my.xlsx');
const HEADER_ROW = 31;
const FIRST_DATA_ROW = 32;
const MAX_COL = 24;

// Each Bukku field -> test against the (lower-cased) row-31 header text.
// Columns are located by header text, not hardcoded letters, because Bukku has
// shipped slightly different "extended" layouts (with/without a Legal Name column).
const FIELD_MATCHERS = {
  contactCode: (h) => /^(customer|contact)( code)?\b/.test(h) && !h.startsWith('customer name'),
  legalName: (h) => h.startsWith('legal name'),
  no: (h) => /^no\.?(\s|\(|$)/.test(h),
  date: (h) => /^date\b/.test(h),
  paymentTerm: (h) => h.startsWith('payment term'),
  tags: (h) => h.startsWith('tags'),
  product: (h) => h.startsWith('product'),
  account: (h) => h.startsWith('account'),
  description: (h) => h.startsWith('item description'),
  qty: (h) => h.startsWith('quantity'),
  unitPrice: (h) => h.startsWith('unit price')
};
const REQUIRED_FIELDS = ['contactCode', 'no', 'date', 'paymentTerm', 'tags', 'product', 'account', 'description', 'qty', 'unitPrice'];

function headerText(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((p) => p.text).join('').trim().toLowerCase();
    if (v.text != null) return String(v.text).trim().toLowerCase();
    if (v.result != null) return String(v.result).trim().toLowerCase();
  }
  return String(v).trim().toLowerCase();
}

function mapColumns(ws) {
  const cols = {};
  for (let c = 2; c <= MAX_COL; c++) {
    const h = headerText(ws.getRow(HEADER_ROW).getCell(c));
    if (!h) continue;
    for (const [field, test] of Object.entries(FIELD_MATCHERS)) {
      if (!cols[field] && test(h)) { cols[field] = c; break; }
    }
  }
  const missing = REQUIRED_FIELDS.filter((f) => !cols[f]);
  if (missing.length) {
    throw new Error(`Bukku 模板第 ${HEADER_ROW} 行找不到这些栏位：${missing.join(', ')}`);
  }
  return cols;
}

async function buildInvoiceWorkbook(branch, built) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);

  // Keep only the "Worksheet" tab.
  wb.worksheets.slice().forEach((s) => { if (s.name !== 'Worksheet') wb.removeWorksheet(s.id); });
  const ws = wb.getWorksheet('Worksheet');
  if (!ws) throw new Error('Bukku 模板缺少 "Worksheet" 工作表。');

  const cols = mapColumns(ws);

  // Rows 1-31 stay exactly as in the template; wipe anything from row 32 down.
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= MAX_COL; c++) row.getCell(c).value = null;
  }

  const rows = rules.buildExcelRows(branch, built);
  rows.forEach((row, i) => {
    const r = FIRST_DATA_ROW + i;
    if (row.first) {
      ws.getCell(r, cols.contactCode).value = row.contactCode || null;
      if (cols.legalName) ws.getCell(r, cols.legalName).value = row.legalName || null;
      ws.getCell(r, cols.no).value = row.no;
      const dateCell = ws.getCell(r, cols.date);
      dateCell.numFmt = '@';
      dateCell.value = row.date;
      ws.getCell(r, cols.paymentTerm).value = row.paymentTerm || null;
      ws.getCell(r, cols.tags).value = row.tags || null;
    }
    ws.getCell(r, cols.product).value = row.product;
    // Plain integer codes (e.g. 5000) are stored as numbers; anything else (5000-01, 0500) stays text.
    ws.getCell(r, cols.account).value = /^[1-9]\d*$/.test(String(row.account)) ? Number(row.account) : row.account;
    ws.getCell(r, cols.description).value = row.description;
    ws.getCell(r, cols.qty).value = row.qty;
    ws.getCell(r, cols.unitPrice).value = row.unitPrice;
  });

  return wb;
}

module.exports = { buildInvoiceWorkbook, mapColumns, TEMPLATE_PATH };
