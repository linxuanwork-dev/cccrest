// The statutory payroll rules as DATA (phase 1, step 4): the numbers that used to be written inside statutory.js.
// Each kind (epf / socso / eis / pay) has its own versions with an effective date. These are the rules the program had until now, in force
// "from the beginning" (1970-01-01) so that every month still calculates exactly as before; a new rule is added as a new version with its own date
// (draft first, approved by the Owner), the old versions stay for ever.
const TABLES = require('./statutoryTables');

const DEFAULT_RULES = [
  {
    kind: 'epf', effectiveFrom: '1970-01-01', status: 'approved',
    note: 'EPF Third Schedule, wages from October 2025: bands, 11 % employee, 13 % employer (12 % above RM5,000), 60 and above, foreign workers',
    data: {
      bands: [{ upto: 5000, step: 20 }, { upto: 20000, step: 100 }],          // wages are taken in bands (RM20 up to RM5,000, RM100 up to RM20,000, exact above)
      employee: 11, employerLow: 13, employerHigh: 12, employerThreshold: 5000,   // percent; the employer pays employerHigh when the wages are above the threshold
      over60: { employee: 0, employer: 4 },
      foreign: { employee: 2, employer: 2 }
    }
  },
  {
    kind: 'socso', effectiveFrom: '1970-01-01', status: 'approved',
    note: 'PERKESO contribution table (Act 4 + SKBBK from 1 June 2026)',
    data: { ceiling: 6000, skbbkFrom: '2026-06', table: TABLES.socso }
  },
  {
    kind: 'eis', effectiveFrom: '1970-01-01', status: 'approved',
    note: 'EIS table (ceiling RM6,000)',
    data: { ceiling: 6000, table: TABLES.eis }
  },
  {
    kind: 'pay', effectiveFrom: '1970-01-01', status: 'approved',
    note: 'overtime rate (MINIFISH workbook), unpaid leave per day, the ages that matter, and the flat percentages of the quick estimate',
    data: {
      overtime: { dailyDivisor: 26, hoursPerDay: 7.5, multiplier: 1.5, step: 0.1 },
      unpaidDivisor: 26,
      age: { senior: 60, minor: 18 },
      estimate: { ceiling: 6000, socsoEmployee: 0.5, socsoEmployer: 1.75, eisEmployee: 0.2, eisEmployer: 0.2 }   // percent of the wages (up to the ceiling)
    }
  }
];

module.exports = { DEFAULT_RULES };
