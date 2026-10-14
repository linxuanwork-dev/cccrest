// Business rules for the Daily Sales -> Bukku Sales Invoice feature.
// Pure functions only (no I/O). All money is handled in integer cents.

const YEAR_MIN = 2025;
const YEAR_MAX = 2035;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function toCents(n) {
  return Math.round(Number(n) * 100);
}

function centsToNumber(c) {
  return c / 100;
}

function formatCents(c) {
  return (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function weekdayName(year, month, day) {
  return WEEKDAYS[new Date(year, month - 1, day).getDay()];
}

function ddmmyyyy(year, month, day) {
  return `${pad2(day)}/${pad2(month)}/${year}`;
}

function invoiceNo(branch, year, month, day) {
  const yy = String(year).slice(-2);
  return `${branch.invoice_prefix}${yy}${pad2(month)}${pad2(day)}${branch.invoice_suffix}`;
}

function reportFileBase(branch, year, month) {
  return `${branch.report_prefix}-BUKKU SALES INV-${year}_${pad2(month)}`;
}

function validYearMonth(year, month) {
  return Number.isInteger(year) && Number.isInteger(month) && year >= YEAR_MIN && year <= YEAR_MAX && month >= 1 && month <= 12;
}

// menu: [{ id, product, unit_price }] in display order
// qtyMap / specialMap: { "<day>:<itemId>": number }
function buildMonth(branch, menu, qtyMap, specialMap, year, month) {
  const lastDay = daysInMonth(year, month);
  const invoices = [];
  const itemTotals = menu.map((m) => ({ itemId: m.id, product: m.product, qty: 0, amountCents: 0 }));
  const specialRecords = [];
  let monthTotalCents = 0;

  for (let day = 1; day <= lastDay; day++) {
    const lines = [];
    let dayTotalCents = 0;

    menu.forEach((item, idx) => {
      const key = `${day}:${item.id}`;
      const qty = Number(qtyMap[key] || 0);
      const menuCents = toCents(item.unit_price);
      const hasSpecial = specialMap[key] != null;
      const unitCents = hasSpecial ? toCents(specialMap[key]) : menuCents;
      const amountCents = qty * unitCents;
      if (qty > 0) {
        dayTotalCents += amountCents;
        itemTotals[idx].qty += qty;
        itemTotals[idx].amountCents += amountCents;
        if (hasSpecial) {
          specialRecords.push({
            day,
            date: ddmmyyyy(year, month, day),
            product: item.product,
            menuCents,
            specialCents: unitCents,
            qty,
            diffCents: (unitCents - menuCents) * qty
          });
        }
      }
      lines.push({ itemId: item.id, product: item.product, qty, unitCents, amountCents, isSpecial: hasSpecial });
    });

    if (dayTotalCents > 0) {
      const kept = branch.include_zero ? lines : lines.filter((l) => l.qty > 0);
      invoices.push({
        day,
        date: ddmmyyyy(year, month, day),
        weekday: weekdayName(year, month, day),
        no: invoiceNo(branch, year, month, day),
        lines: kept,
        totalCents: dayTotalCents
      });
      monthTotalCents += dayTotalCents;
    }
  }

  return { year, month, invoices, itemTotals, specialRecords, monthTotalCents };
}

// Flat row model of what goes into the Excel file (one entry per spreadsheet row).
function buildExcelRows(branch, built) {
  const rows = [];
  built.invoices.forEach((inv) => {
    inv.lines.forEach((line, i) => {
      rows.push({
        first: i === 0,
        contactCode: i === 0 ? branch.contact_code : '',
        legalName: i === 0 ? branch.legal_name : '',
        no: i === 0 ? inv.no : '',
        date: i === 0 ? inv.date : '',
        paymentTerm: i === 0 ? branch.payment_term : '',
        tags: i === 0 ? branch.tags : '',
        product: line.product,
        account: branch.account_code,
        description: line.product,
        qty: line.qty,
        unitPrice: centsToNumber(line.unitCents),
        _unitCents: line.unitCents
      });
    });
  });
  return rows;
}

// Section 9 checks. Returns an array of human-readable problems (empty = OK).
function runChecks(branch, menu, built, year, month) {
  const errors = [];

  if (!validYearMonth(year, month)) errors.push('请先选择有效的年份和月份。');

  if (!String(branch.contact_code || '').trim() && !String(branch.legal_name || '').trim()) {
    errors.push('Contact Code 和 Legal Name 至少要填一个。');
  }
  if (!String(branch.account_code || '').trim()) errors.push('Account Code 不可空白。');

  const seen = new Set();
  menu.forEach((m, i) => {
    const name = String(m.product || '').trim();
    if (!name) errors.push(`菜单第 ${i + 1} 项没有名字。`);
    else if (seen.has(name.toLowerCase())) errors.push(`菜单名字重复：${name}`);
    seen.add(name.toLowerCase());
    if (m.unit_price == null || isNaN(Number(m.unit_price)) || Number(m.unit_price) < 0) errors.push(`菜单「${name || i + 1}」的单价无效。`);
  });

  if (built.invoices.length === 0) errors.push('这个月没有任何一天有开单（所有数量都是 0）。');

  // Checks 6 & 7 run against the exact row model that will be written to Excel.
  const rows = buildExcelRows(branch, built);
  const rowsCents = rows.reduce((s, r) => s + r.qty * r._unitCents, 0);
  if (rowsCents !== built.monthTotalCents) errors.push('Excel 总额与每日进单总额不一致。');

  const nos = new Set();
  rows.forEach((r) => {
    if (r.first) {
      if (nos.has(r.no)) errors.push(`单号重复：${r.no}`);
      nos.add(r.no);
    } else if (r.contactCode || r.legalName || r.no || r.date || r.paymentTerm || r.tags) {
      errors.push('同一张单第二行起的 B–M 资料必须留空。');
    }
  });

  return errors;
}

module.exports = {
  YEAR_MIN, YEAR_MAX, WEEKDAYS, MONTH_NAMES,
  pad2, daysInMonth, toCents, centsToNumber, formatCents, weekdayName, ddmmyyyy,
  invoiceNo, reportFileBase, validYearMonth, buildMonth, buildExcelRows, runChecks
};
