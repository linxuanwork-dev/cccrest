/* Malaysian payroll: EPF, SOCSO (incl. SKBBK), EIS and the monthly pay lines.
   One file used by the server and (served as a script) by the HR Attendance page, so both always calculate the same way.
   PCB is NOT calculated here: it is typed in by hand for now (needs the LHDN schedule / reliefs).

   Rules (from the official tables the Owner supplied and the MINIFISH salary workbook):
   - EPF (Third Schedule, effective October 2025 wages): wages without overtime; wages are taken in bands (RM20 up to RM5,000, RM100 up to RM20,000,
     exact above RM20,000); employee 11 %, employer 13 % (12 % when the wages are above RM5,000); every share is rounded up to the next ringgit.
     From the month after the person turns 60: employee 0 %, employer 4 %. Foreign workers: 2 % + 2 %.
   - SOCSO / EIS: wages including overtime, up to RM6,000, from the band table. First category (under 60) pays employment injury + invalidity;
     the second category (60 and above, foreign workers) employment injury only. From 1 June 2026 the employee also pays the non-employment injury
     scheme (SKBBK). EIS: Malaysian / PR aged 18 to 59 only.
   - Overtime rate (MINIFISH workbook): daily = basic / 26 (1 decimal), hourly = daily / 7.5 rounded UP to 1 decimal, OT rate = hourly x 1.5 rounded UP to 1 decimal.
   - Unpaid leave: basic / 26 per day. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./statutoryTables'));
  else root.STAT = factory(root.STAT_TABLES);
}(typeof self !== 'undefined' ? self : this, function (TABLES) {
  var r2 = function (n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; };
  var up = function (n, step) { return Math.ceil(Math.round(n / step * 1e6) / 1e6) * step; };   // round up to a multiple of step (float safe)
  var ceilUnit = function (n) { return Math.ceil(Math.round(n * 1e6) / 1e6); };                   // next ringgit

  var SKBBK_FROM = '2026-06';   // month from which the employee also pays the non-employment injury scheme (SKBBK)

  // the person has turned 60 before this month (the lower EPF rate and the second SOCSO category start the month after the 60th birthday)
  function over60(dob, month) {
    if (!dob) return false;
    var d = new Date(String(dob).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d)) return false;
    var b60 = Date.UTC(d.getUTCFullYear() + 60, d.getUTCMonth(), d.getUTCDate());
    var first = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
    return b60 < first;
  }
  function under18(dob, month) {
    if (!dob) return false;
    var d = new Date(String(dob).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d)) return false;
    var b18 = Date.UTC(d.getUTCFullYear() + 18, d.getUTCMonth(), d.getUTCDate());
    var last = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
    return b18 > last;
  }

  function epfBand(w) { return w <= 5000 ? up(w, 20) : w <= 20000 ? up(w, 100) : w; }
  function epf(wage, o) {   // o: { over60, foreign }
    wage = Number(wage) || 0;
    if (wage <= 0) return { employee: 0, employer: 0 };
    var base = epfBand(wage);
    if (o.foreign) return { employee: ceilUnit(base * 0.02), employer: ceilUnit(base * 0.02) };
    if (o.over60) return { employee: 0, employer: ceilUnit(base * 0.04) };
    return { employee: ceilUnit(base * 0.11), employer: ceilUnit(base * (wage > 5000 ? 0.12 : 0.13)) };
  }

  function socsoRow(wage) {
    var w = Math.min(Number(wage) || 0, 6000);
    var rows = TABLES.socso;
    for (var i = 0; i < rows.length; i++) { if (rows[i].upper === null || w <= rows[i].upper) return rows[i]; }
    return rows[rows.length - 1];
  }
  function socso(wage, month, o) {   // o: { cat2, skbbkOptOut }
    wage = Number(wage) || 0;
    if (wage <= 0) return { employee: 0, skbbk: 0, employer: 0 };
    var row = socsoRow(wage), withSkbbk = month >= SKBBK_FROM && !o.skbbkOptOut;
    if (o.cat2) return { employee: 0, skbbk: withSkbbk ? row.cat2.skbbk : 0, employer: row.cat2.employer };
    return { employee: row.cat1.invalidity, skbbk: withSkbbk ? row.cat1.skbbk : 0, employer: row.cat1.employer };
  }
  function eis(wage, o) {   // o: { applies }
    wage = Number(wage) || 0;
    if (wage <= 0 || !o.applies) return { employee: 0, employer: 0 };
    var w = Math.min(wage, 6000), rows = TABLES.eis;
    for (var i = 0; i < rows.length; i++) { if (w <= rows[i].upper) return { employee: rows[i].employee, employer: rows[i].employer }; }
    var last = rows[rows.length - 1];
    return { employee: last.employee, employer: last.employer };
  }

  // overtime rate per hour (MINIFISH workbook)
  function otRate(basic) {
    var daily = Math.round((Number(basic) || 0) / 26 * 10) / 10;
    var hourly = up(daily / 7.5, 0.1);
    return Math.round(up(hourly * 1.5, 0.1) * 10) / 10;
  }

  /* p: { month 'YYYY-MM', basic, otHours, unpaidDays, allowance, incentive, commission, other, advance, pcb, dob, nationality ('MALAYSIAN' | 'PR' | 'FOREIGN'), skbbkOptOut }
     'other' may be negative. Returns every line of the payslip and the employer's share. */
  function calc(p) {
    var month = String(p.month || '');
    var nat = String(p.nationality || 'MALAYSIAN').toUpperCase();
    var foreign = nat === 'FOREIGN';
    var old = over60(p.dob, month), minor = under18(p.dob, month);
    var basic = Number(p.basic) || 0;
    var rate = otRate(basic);
    var unpaid = r2(Math.round((basic / 26) * 100) / 100 * (Number(p.unpaidDays) || 0));
    var otPay = r2((Number(p.otHours) || 0) * rate);
    var allowance = r2(p.allowance), incentive = r2(p.incentive), commission = r2(p.commission), other = r2(p.other);
    var gross = r2(basic - unpaid + otPay + allowance + incentive + commission + other);
    var epfWage = r2(gross - otPay);
    var e = epf(epfWage, { over60: old, foreign: foreign });
    var s = socso(gross, month, { cat2: old || foreign, skbbkOptOut: !!p.skbbkOptOut && !foreign });
    var i = eis(gross, { applies: !foreign && !old && !minor });
    var pcb = r2(p.pcb);
    var deduction = r2(e.employee + s.employee + s.skbbk + i.employee + pcb);
    var advance = r2(p.advance);
    return {
      month: month, over60: old, otRate: rate, basic: r2(basic), unpaidDeduction: unpaid, otHours: Number(p.otHours) || 0, otPay: otPay,
      allowance: allowance, incentive: incentive, commission: commission, other: other, gross: gross, epfWage: epfWage,
      epfEmployee: e.employee, epfEmployer: e.employer, socsoEmployee: s.employee, skbbkEmployee: s.skbbk, socsoEmployer: s.employer,
      eisEmployee: i.employee, eisEmployer: i.employer, pcb: pcb, totalDeduction: deduction, advance: advance,
      net: r2(gross - deduction - advance), employerTotal: r2(e.employer + s.employer + i.employer)
    };
  }

  // the basic salary that applies in a month, from the salary history [{ effective: 'YYYY-MM-DD', amount }]: the latest change that started in or before the month
  // (a change applies to the whole month its date falls in); before the first record the first amount; without a history the current salary
  function salaryOn(history, month, fallback) {
    var h = (history || []).filter(function (r) { return r && r.effective; }).slice().sort(function (a, b) { return a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0; });
    if (!h.length) return Number(fallback) || 0;
    var use = null;
    h.forEach(function (r) { if (String(r.effective).slice(0, 7) <= month) use = r; });
    return Number((use || h[0]).amount) || 0;
  }

  return { salaryOn: salaryOn, calc: calc, epf: epf, socso: socso, eis: eis, otRate: otRate, over60: over60, SKBBK_FROM: SKBBK_FROM };
}));
