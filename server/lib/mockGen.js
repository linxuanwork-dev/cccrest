// Ported 1:1 from the original client-side generators in index.html so seeded
// data matches exactly what the mock UI was already showing.

function hashStr(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

function mulberry32(seed) {
  var a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(company, panel) {
  return mulberry32(hashStr(company + '::' + panel));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function invoicePrefix(company) {
  var letters = company
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map(function (w) {
      return w[0];
    })
    .join('')
    .toUpperCase();
  return letters.slice(0, 3) || 'INV';
}

var DATE_POOL = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'];

function genSales(company) {
  var rng = rngFor(company, 'sales');
  var base = 150 + rng() * 420;
  var prefix = invoicePrefix(company);
  var rows = DATE_POOL.map(function (d, i) {
    var gross = round2(base * (0.65 + rng() * 0.7));
    var isToday = i === DATE_POOL.length - 1;
    var synced = rng() > (isToday ? 0.55 : 0.12);
    var settled = synced ? round2(gross - rng() * 4) : rng() > 0.5 ? round2(gross * rng() * 0.5) : 0;
    var pettyOut = round2(rng() * 15);
    return {
      date: d,
      invoice: prefix + '-' + (1000 + i * 7 + Math.floor(rng() * 80)),
      gross: gross,
      settled: settled,
      pettyOut: pettyOut,
      status: synced ? 'Synced' : 'Pending'
    };
  });
  return rows;
}

function genBank(company) {
  var rng = rngFor(company, 'bank');
  var balance = 8000 + rng() * 22000;
  var rows = [];
  DATE_POOL.slice(1).forEach(function (d) {
    if (rng() > 0.3) {
      var credit = round2(300 + rng() * 1800);
      balance = round2(balance + credit);
      rows.push({
        date: d,
        description: 'DuitNow Settlement — FIUU',
        debit: null,
        credit: credit,
        balance: balance,
        status: rng() > 0.15 ? 'Matched' : 'Unmatched'
      });
    }
    if (rng() > 0.55) {
      var debit = round2(20 + rng() * 550);
      balance = round2(balance - debit);
      rows.push({
        date: d,
        description: rng() > 0.5 ? 'Supplier Payment' : 'Bank Charges',
        debit: debit,
        credit: null,
        balance: balance,
        status: 'Matched'
      });
    }
  });
  return rows;
}

var SUPPLIERS = ['ABC Supplies Sdn Bhd', 'JB Trading Co', 'Prime Distributors', 'Sinar Wholesale Sdn Bhd', 'Delta Packaging'];

function genPurchases(company) {
  var rng = rngFor(company, 'purchases');
  var count = 3 + Math.floor(rng() * 3);
  var rows = [];
  for (var i = 0; i < count; i++) {
    rows.push({
      invoiceNo: 'INV-' + (4000 + Math.floor(rng() * 900)),
      supplier: SUPPLIERS[Math.floor(rng() * SUPPLIERS.length)],
      amount: round2(80 + rng() * 900),
      date: DATE_POOL[Math.floor(rng() * DATE_POOL.length)],
      status: rng() > 0.4 ? 'Paid' : 'Unpaid'
    });
  }
  return rows;
}

var CLAIM_CATEGORIES = ['Transport', 'Equipment Repair', 'Utilities', 'Cleaning Supplies', 'Stationery', 'Meals'];

function genClaim(company, staffNames) {
  var rng = rngFor(company, 'claim');
  var staffName = staffNames.length ? staffNames[Math.floor(rng() * staffNames.length)] : null;
  var count = 2 + Math.floor(rng() * 3);
  var rows = [];
  for (var i = 0; i < count; i++) {
    rows.push({
      claimNo: 'CLM-' + (5000 + Math.floor(rng() * 900)),
      staffName: staffName,
      category: CLAIM_CATEGORIES[Math.floor(rng() * CLAIM_CATEGORIES.length)],
      amount: round2(20 + rng() * 220),
      date: DATE_POOL[Math.floor(rng() * DATE_POOL.length)],
      status: rng() > 0.35 ? 'Approved' : 'Pending'
    });
  }
  return rows;
}

var PETTY_DESC = ['Float top-up', 'Cleaning supplies', 'Minor repair', 'Postage & courier', 'Parking / toll', 'Stationery'];

function genPetty(company) {
  var rng = rngFor(company, 'petty');
  var balance = round2(50 + rng() * 150);
  var rows = [];
  DATE_POOL.forEach(function (d) {
    if (rng() > 0.4) {
      var isIn = rng() > 0.7;
      var amt = round2(isIn ? 50 + rng() * 100 : 5 + rng() * 40);
      balance = round2(isIn ? balance + amt : balance - amt);
      rows.push({
        date: d,
        description: isIn ? 'Float top-up' : PETTY_DESC[1 + Math.floor(rng() * (PETTY_DESC.length - 1))],
        amountIn: isIn ? amt : null,
        amountOut: isIn ? null : amt,
        balance: balance
      });
    }
  });
  return rows;
}

function genMerchant(company) {
  var rng = rngFor(company, 'merchant');
  var rows = [];
  DATE_POOL.forEach(function (d) {
    var txns = 5 + Math.floor(rng() * 40);
    var approved = round2(txns * (15 + rng() * 25));
    var failed = round2(rng() * 40);
    var fee = round2(approved * 0.0086);
    var net = round2(approved - fee);
    rows.push({ date: d, txns: txns, approved: approved, failed: failed, fee: fee, net: net });
  });
  return rows;
}

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function genReconLines(company, needsReview) {
  var rng = rngFor(company, 'recon');
  var prefix = invoicePrefix(company);
  var days = DATE_POOL.slice(-3);
  return days.map(function (d, i) {
    var isLast = i === days.length - 1;
    var billAmt = round2(400 + rng() * 900);
    var txnFee = round2(billAmt * 0.01);
    var failedCancelled = round2(rng() > 0.6 ? rng() * 40 : 0);
    var actualAmt = round2(billAmt - txnFee - failedCancelled);
    var flagged = needsReview && isLast;
    var settlement = flagged ? round2(actualAmt * (0.35 + rng() * 0.15)) : actualAmt;
    return {
      date: d,
      invoiceNo: prefix + '-2608-' + d.slice(-2),
      billAmt: billAmt,
      txnFee: txnFee,
      failedCancelled: failedCancelled,
      actualAmt: actualAmt,
      settlement: settlement,
      receiptNo: flagged ? null : 'R' + prefix + '-2608-' + String(i + 1).padStart(2, '0'),
      status: flagged ? 'Needs Review' : 'Matched'
    };
  });
}

module.exports = {
  hashStr,
  mulberry32,
  rngFor,
  round2,
  invoicePrefix,
  slugify,
  DATE_POOL,
  genSales,
  genBank,
  genPurchases,
  genClaim,
  genPetty,
  genMerchant,
  genReconLines
};
