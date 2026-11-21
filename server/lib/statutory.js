/* Malaysian payroll: EPF, SOCSO (incl. SKBBK), EIS and the monthly pay lines.
   One file used by the server and (served as a script) by the HR Attendance page, so both always calculate the same way.
   PCB is NOT calculated here: it is typed in by hand for now (needs the LHDN schedule / reliefs).

   The NUMBERS (rates, bands, tables, ceilings, the overtime formula, ages) are not in this file any more: they are rules with an effective date
   (statutory_rules table, see statutoryRules.js for the values and how they are written). The month of the wages decides which version is used:
   the newest approved version whose effective date is not after the month. The functions below only say HOW the rules are applied:

   - EPF: wages without overtime; wages are taken in bands; every share is rounded up to the next ringgit. From the month after the person turns
     60 the senior rates; foreign workers their own rates.
   - SOCSO / EIS: wages including overtime, up to the ceiling, from the band table. First category (under 60) pays employment injury + invalidity;
     the second category (60 and above, foreign workers) employment injury only. From the SKBBK month the employee also pays the non-employment
     injury scheme (SKBBK). EIS: Malaysian / PR aged 18 to 59 only.
   - Overtime rate: daily = basic / divisor (1 decimal), hourly = daily / hours per day rounded UP to 1 decimal, OT rate = hourly x multiplier
     rounded UP to 1 decimal.
   - Unpaid leave: basic / divisor per day. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./statutoryRules').DEFAULT_RULES);
  else root.STAT = factory(root.STAT_RULES);
}(typeof self !== 'undefined' ? self : this, function (DEFAULT_RULES) {
  var r2 = function (n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; };
  var up = function (n, step) { return Math.ceil(Math.round(n / step * 1e6) / 1e6) * step; };   // round up to a multiple of step (float safe)
  var ceilUnit = function (n) { return Math.ceil(Math.round(n * 1e6) / 1e6); };                   // next ringgit

  /* make(list): the calculator for a list of rule versions [{ kind, effectiveFrom, status, data }]. Only approved versions count. */
  function make(list) {
    var rules = (list || []).filter(function (r) { return r && r.status === 'approved'; });

    // the rule of one kind in force in a month (month 'YYYY-MM'; none given = the newest version)
    function R(kind, month) {
      var use = null;
      rules.forEach(function (r) {
        if (r.kind !== kind) return;
        if (month && String(r.effectiveFrom).slice(0, 7) > month) return;
        if (!use || String(r.effectiveFrom) >= String(use.effectiveFrom)) use = r;
      });
      if (!use) throw new Error('No ' + kind + ' rule in force for ' + (month || 'now'));
      return use.data;
    }

    // the person has turned 60 before this month (the lower EPF rate and the second SOCSO category start the month after the 60th birthday)
    function over60(dob, month) {
      if (!dob) return false;
      var d = new Date(String(dob).slice(0, 10) + 'T00:00:00Z');
      if (isNaN(d)) return false;
      var b60 = Date.UTC(d.getUTCFullYear() + R('pay', month).age.senior, d.getUTCMonth(), d.getUTCDate());
      var first = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
      return b60 < first;
    }
    function under18(dob, month) {
      if (!dob) return false;
      var d = new Date(String(dob).slice(0, 10) + 'T00:00:00Z');
      if (isNaN(d)) return false;
      var b18 = Date.UTC(d.getUTCFullYear() + R('pay', month).age.minor, d.getUTCMonth(), d.getUTCDate());
      var last = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
      return b18 > last;
    }

    function epfBand(w, bands) {
      for (var i = 0; i < bands.length; i++) { if (w <= bands[i].upto) return up(w, bands[i].step); }
      return w;
    }
    function epf(wage, o) {   // o: { over60, foreign, month }
      wage = Number(wage) || 0;
      if (wage <= 0) return { employee: 0, employer: 0 };
      var c = R('epf', o.month);
      var base = epfBand(wage, c.bands);
      if (o.foreign) return { employee: ceilUnit(base * (c.foreign.employee / 100)), employer: ceilUnit(base * (c.foreign.employer / 100)) };
      if (o.over60) return { employee: ceilUnit(base * (c.over60.employee / 100)), employer: ceilUnit(base * (c.over60.employer / 100)) };
      return { employee: ceilUnit(base * (c.employee / 100)), employer: ceilUnit(base * ((wage > c.employerThreshold ? c.employerHigh : c.employerLow) / 100)) };
    }

    function socsoRow(wage, c) {
      var w = Math.min(Number(wage) || 0, c.ceiling);
      var rows = c.table;
      for (var i = 0; i < rows.length; i++) { if (rows[i].upper === null || w <= rows[i].upper) return rows[i]; }
      return rows[rows.length - 1];
    }
    function socso(wage, month, o) {   // o: { cat2, skbbkOptOut }
      wage = Number(wage) || 0;
      if (wage <= 0) return { employee: 0, skbbk: 0, employer: 0 };
      var c = R('socso', month), row = socsoRow(wage, c), withSkbbk = month >= c.skbbkFrom && !o.skbbkOptOut;
      if (o.cat2) return { employee: 0, skbbk: withSkbbk ? row.cat2.skbbk : 0, employer: row.cat2.employer };
      return { employee: row.cat1.invalidity, skbbk: withSkbbk ? row.cat1.skbbk : 0, employer: row.cat1.employer };
    }
    function eis(wage, o) {   // o: { applies, month }
      wage = Number(wage) || 0;
      if (wage <= 0 || !o.applies) return { employee: 0, employer: 0 };
      var c = R('eis', o.month), w = Math.min(wage, c.ceiling), rows = c.table;
      for (var i = 0; i < rows.length; i++) { if (w <= rows[i].upper) return { employee: rows[i].employee, employer: rows[i].employer }; }
      var last = rows[rows.length - 1];
      return { employee: last.employee, employer: last.employer };
    }

    // overtime rate per hour
    function otRate(basic, month) {
      var o = R('pay', month).overtime, k = Math.round(1 / o.step);
      var daily = Math.round((Number(basic) || 0) / o.dailyDivisor * k) / k;
      var hourly = up(daily / o.hoursPerDay, o.step);
      return Math.round(up(hourly * o.multiplier, o.step) * k) / k;
    }

    // the month from which the employee also pays the non-employment injury scheme (SKBBK) according to the rule in force
    function skbbkFrom(month) { return R('socso', month).skbbkFrom; }

    /* p: { month 'YYYY-MM', basic, otHours, unpaidDays, allowance, incentive, commission, other, advance, pcb, dob, nationality ('MALAYSIAN' | 'PR' | 'FOREIGN'), skbbkOptOut }
       'other' may be negative. Returns every line of the payslip and the employer's share. */
    function calc(p) {
      var month = String(p.month || '');
      var nat = String(p.nationality || 'MALAYSIAN').toUpperCase();
      var foreign = nat === 'FOREIGN';
      var old = over60(p.dob, month), minor = under18(p.dob, month);
      var basic = Number(p.basic) || 0;
      var rate = otRate(basic, month);
      var unpaid = r2(Math.round((basic / R('pay', month).unpaidDivisor) * 100) / 100 * (Number(p.unpaidDays) || 0));
      var otPay = r2((Number(p.otHours) || 0) * rate);
      var allowance = r2(p.allowance), incentive = r2(p.incentive), commission = r2(p.commission), other = r2(p.other);
      // an incomplete month (joined or left during it): the basic salary is paid by the calendar days worked, days in the month (Employment Act s.18A); the unpaid-leave deduction and the overtime rate stay on the full salary
      var proDays = Number(p.proDays) || 0, calDays = Number(p.calDays) || 0;
      var fullBasic = basic;
      if (proDays > 0 && calDays > 0 && proDays < calDays) basic = r2(basic * proDays / calDays);
      var gross = r2(basic - unpaid + otPay + allowance + incentive + commission + other);
      var epfWage = r2(gross - otPay);
      var e = epf(epfWage, { over60: old, foreign: foreign, month: month });
      var s = socso(gross, month, { cat2: old || foreign, skbbkOptOut: !!p.skbbkOptOut && !foreign });
      var i = eis(gross, { applies: !foreign && !old && !minor, month: month });
      var pcb = r2(p.pcb);
      var deduction = r2(e.employee + s.employee + s.skbbk + i.employee + pcb);
      var advance = r2(p.advance);
      return {
        month: month, over60: old, otRate: rate, basic: r2(basic), fullBasic: r2(fullBasic), proDays: proDays, calDays: calDays, unpaidDeduction: unpaid, otHours: Number(p.otHours) || 0, otPay: otPay,
        allowance: allowance, incentive: incentive, commission: commission, other: other, gross: gross, epfWage: epfWage,
        epfEmployee: e.employee, epfEmployer: e.employer, socsoEmployee: s.employee, skbbkEmployee: s.skbbk, socsoEmployer: s.employer,
        eisEmployee: i.employee, eisEmployer: i.employer, pcb: pcb, totalDeduction: deduction, advance: advance,
        net: r2(gross - deduction - advance), employerTotal: r2(e.employer + s.employer + i.employer)
      };
    }

    // a quick estimate of EPF / SOCSO / EIS from flat percentages (the old Payroll suggestion; not the official tables, to be reviewed)
    function estimate(wage, month) {
      var c = R('epf', month), z = R('pay', month).estimate;
      var epfEmployee = r2(wage * (c.employee / 100));
      var epfEmployer = r2(wage * ((wage <= c.employerThreshold ? c.employerLow : c.employerHigh) / 100));
      var capped = Math.min(wage, z.ceiling);
      return { epfEmployee: epfEmployee, epfEmployer: epfEmployer, socsoEmployee: r2(capped * (z.socsoEmployee / 100)), socsoEmployer: r2(capped * (z.socsoEmployer / 100)), eisEmployee: r2(capped * (z.eisEmployee / 100)), eisEmployer: r2(capped * (z.eisEmployer / 100)) };
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

    return {
      salaryOn: salaryOn, calc: calc, epf: epf, socso: socso, eis: eis, otRate: otRate, over60: over60, estimate: estimate, skbbkFrom: skbbkFrom,
      rulesIn: function () { return rules; },
      // the older name: the SKBBK month of the newest rule
      get SKBBK_FROM() { return skbbkFrom(); }
    };
  }

  // the calculator in use: it starts with the built-in rules; setRules() swaps in the rules of the database / the server
  var current = make(DEFAULT_RULES);
  var api = {
    make: make,
    setRules: function (list) { current = make(list && list.length ? list : DEFAULT_RULES); },
    rulesIn: function () { return current.rulesIn(); }
  };
  ['salaryOn', 'calc', 'epf', 'socso', 'eis', 'otRate', 'over60', 'estimate', 'skbbkFrom'].forEach(function (k) {
    api[k] = function () { return current[k].apply(null, arguments); };
  });
  Object.defineProperty(api, 'SKBBK_FROM', { get: function () { return current.SKBBK_FROM; }, enumerable: true });
  return api;
}));
