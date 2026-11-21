// The one Bukku import-file maker for Purchase Bills ("Bills (Credit Purchase) - Extended Mode - MY"). core/: used by every module; the template is not changed per company.
// It was written in the Purchases Bill page (routes/purchaseBukku.js) and moved here without changing a cell, so the page and the standard
// transaction flow make the same file.
const ExcelJS = require('exceljs');

const normName = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

const HEADER = ['Contact Code (1)', 'Legal Name (2)', 'No. (3)', 'Reference No.', 'Date (D) *', 'Payment Term (4)', 'Due Date (D) (5)', 'Currency (6)', 'Rate (7)', 'Tags (8)', 'Description', 'Product (9)', 'Account (10) *', 'Item Description *', 'Quantity (11)', 'UOM (12)', 'Location (13)', 'Unit Price *', 'Discount (14)', 'Tax (15)'];
const NOTES = ['TEMPLATE FOR BILLS (CREDIT PURCHASE) - EXTENDED MODE - MY', '', 'INSTRUCTIONS FOR IMPORT (PLEASE READ FIRST)',
  "Lines that start with '#' are comments and will be ignored by the system during import.",
  "DO NOT remove the line started with '$', the system requires it to identify the columns.",
  "DO NOT remove the first column with '#' and '$', system will read data from 2nd column.",
  "Fields marked with '*' are required.",
  '- To create a transaction with more than one line item, you can either:',
  '    > Add additional lines with the same data in the columns before column M.',
  '    > Add additional lines with all columns left blank before column M.', '', 'NOTES:',
  '(D) Accepted format for dates is "DD/MM/YYYY".',
  "(1) The transaction's supplier, enter the Contact's Contact Code (eg. C-A0001). If left blank, the supplier will be matched by Legal Name instead (Column 2).",
  "(2) The supplier's Legal Name (eg. Acme Sdn Bhd). Used to match the supplier only if Contact Code is blank or doesn't match an existing code.",
  "(3) The transaction's unique number, enter the actual number or a number format with number placeholder (eg. IV-[5DIGIT]) for automated running number, default number format is used if left blank.",
  "(4) The transaction's payment term, enter the Payment Term's name (eg. NET30), you may leave blank to set a Due Date.",
  "(5) The transaction's due date, only use this if Payment Term is not provided, default to the transaction's Date if left blank.",
  "(6) The transaction's currency, enter the 3 character ISO currency code (eg. MYR), default to home currency if left blank.",
  "(7) The transaction's exchange rate used to convert the amount into home currency, default to 1 if left blank.",
  "(8) Assign the transaction to multiple tags, enter the Tag's name and you may specific multiple tags with with commas.",
  "(9) The line item's product, enter the Product's name.",
  "(10) The line item's account, enter the Account's code.",
  "(11) The line item's quantity, default to 1 if left blank.",
  "(12) The line item's product UOM (Unit of Measurements), only used when product is selected, it will set to the default / base UOM if left blank.",
  "(13) The line item's product location, enter the Location's code, only used when inventory product is selected, it will set to default location if left blank.",
  '(14) The line item’s discount, enter amount value (eg. 5.00) or percentage value (eg. 5%).',
  "(15) The purchase tax applicable for the line item, enter the Tax's code.", ''];
const numOrText = (v) => { const s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? Number(s) : s; };
const COL_WIDTHS = [3, 12, 34, 14, 12, 12, 10, 10, 8, 6, 12, 14, 10, 10, 40, 8, 6, 8, 12, 8, 8];


/* bills: [{ supplier, code, no, ref, bill_date 'YYYY-MM-DD', tags, description, revised, lines: [{account, desc, note, qty, price, disc, tax}] }]
   suppliers: [{ name, code, account, tags }] (the company's supplier list); defaultAccount: the account of a line when neither the line nor the supplier has one.
   Returns the ExcelJS workbook (sheets Worksheet and Contacts). */
function buildPurchaseBillWorkbook({ bills, suppliers, defaultAccount, today }) {
  const rows = bills, sups = suppliers, s = { account: defaultAccount };
  const supByName = new Map(sups.map((x) => [normName(x.name), x]));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Worksheet');
  NOTES.forEach((t) => ws.addRow(['#', t]));
  ws.addRow(['$', ...HEADER]);
  for (const b of rows) {
    const sup = supByName.get(normName(b.supplier));
    const code = (sup && sup.code) || b.code || '';
    b.lines.forEach((l, i) => {
      const r = ws.addRow(['',
        ...(i === 0 ? [code, b.supplier, b.no, b.ref || '', dmy(b.bill_date), '', '', '', '', b.tags || '', ((b.description || '') + (b.revised ? (b.description ? ' ' : '') + '[REVISED ' + dmy(today || new Date().toISOString().slice(0, 10)) + ']' : '')), ''] : Array(12).fill('')),
        numOrText(l.account || (sup && sup.account) || s.account), l.desc + (l.note ? ' - ' + l.note : ''), l.qty == null ? 1 : l.qty, '', '', Number(l.price), l.disc || '', l.tax || '']);
      // No. / Contact Code / Reference / Date stay text so Excel does not reformat things like "0626/0321"
      [2, 4, 5, 6].forEach((c) => { const cell = r.getCell(c); if (cell.value !== '') cell.numFmt = '@'; });
      r.getCell(19).numFmt = '#,##0.00';
    });
  }
  ws.columns.forEach((c, i) => { c.width = COL_WIDTHS[i] || 10; });
  const cs = wb.addWorksheet('Contacts');
  cs.addRow(['Legal Name', 'Contact Code', 'ACCOUNT', 'TAGS']);
  sups.forEach((x) => cs.addRow([x.name, x.code || '', numOrText(x.account || ''), x.tags || '']));
  cs.columns.forEach((c, i) => { c.width = [40, 14, 10, 14][i]; });

  return wb;
}

module.exports = { buildPurchaseBillWorkbook, HEADER, NOTES, COL_WIDTHS, normName, dmy, numOrText };
