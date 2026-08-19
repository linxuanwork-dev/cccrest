const VALID_TYPES = ['DUITNOW_QR_TNGD', 'DUITNOW_QR_AQC', 'DUITNOW_QR_AQC_CB', 'PAYMENT'];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

module.exports = { VALID_TYPES, MONTH_NAMES, daysInMonth, aggregateByDay };
