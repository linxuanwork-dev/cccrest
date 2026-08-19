const VALID_TYPES = ['DUITNOW_QR_TNGD', 'DUITNOW_QR_AQC', 'DUITNOW_QR_AQC_CB'];

// Order here is the order outlets appear in the output workbook.
const OUTLETS = [
  { key: 'UKD_NOODLE', label: 'UKD Noodle', prefix: 'UKD', matchNames: ['ukd noodle'], fromReport: true },
  { key: 'UKTN', label: 'UKTN', prefix: 'TN', matchNames: ['uktn'], fromReport: true },
  { key: 'UKTU', label: 'UKTU', prefix: 'TU', matchNames: ['uktu'], fromReport: true },
  { key: 'UKHP', label: 'UKHP', prefix: 'HP', matchNames: ['ukhp'], fromReport: true },
  { key: 'UNCLE_KOH', label: 'Uncle Koh', prefix: 'UK', matchNames: [], fromReport: false }
];

const BUKKU_FIXED = {
  customerCode: 'C-C0001',
  depositAccount: '1000-01',
  paymentMethod: 'TNG',
  description: 'TNG PAYMENT'
};

function findOutletByName(rawName) {
  const norm = String(rawName || '').trim().toLowerCase();
  return OUTLETS.find((o) => o.matchNames.includes(norm)) || null;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function aggregateByDay(transactions) {
  const map = {};
  transactions.forEach((t) => {
    if (!map[t.day]) map[t.day] = { amount: 0, count: 0 };
    map[t.day].amount += t.amount;
    map[t.day].count += 1;
  });
  return map;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// YYMMDD for reference/invoice numbers, e.g. 2026-07-05 -> "260705".
function yymmdd(year, month, day) {
  return String(year).slice(-2) + pad2(month) + pad2(day);
}

module.exports = { VALID_TYPES, OUTLETS, BUKKU_FIXED, findOutletByName, daysInMonth, aggregateByDay, pad2, yymmdd };
