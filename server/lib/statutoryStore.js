// The statutory payroll rules in the database (migration 059): load them into lib/statutory.js, check a new version before it is saved.
const { pool } = require('../db');
const STAT = require('./statutory');
const { DEFAULT_RULES } = require('./statutoryRules');

const KINDS = ['epf', 'socso', 'eis', 'pay'];
let loadedAt = 0;

const norm = (r) => ({ id: r.id, kind: r.kind, effectiveFrom: r.effective_from, status: r.status, data: r.data, note: r.note, createdBy: r.created_by, createdAt: r.created_at, approvedBy: r.approved_by, approvedAt: r.approved_at });

const SELECT = `SELECT id, kind, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, status, data, note, created_by, created_at, approved_by, approved_at FROM statutory_rules`;

// the first time (or when a kind has no approved version at all): the rules the program had until now, in force from the beginning
async function ensureSeed(db) {
  const q = db || pool;
  const have = new Set((await q.query("SELECT DISTINCT kind FROM statutory_rules WHERE status = 'approved'")).rows.map((r) => r.kind));
  for (const r of DEFAULT_RULES) {
    if (have.has(r.kind)) continue;
    await q.query(
      `INSERT INTO statutory_rules (kind, effective_from, status, data, note, created_by, approved_by, approved_at)
       VALUES ($1,$2::date,'approved',$3::jsonb,$4,'built-in rules','built-in rules',now()) ON CONFLICT DO NOTHING`,
      [r.kind, r.effectiveFrom, JSON.stringify(r.data), r.note]);
  }
}

async function approvedList(db) {
  return (await (db || pool).query(SELECT + " WHERE status = 'approved' ORDER BY kind, effective_from")).rows.map(norm);
}
async function allRows(db) {
  return (await (db || pool).query(SELECT + ' ORDER BY kind, effective_from, id')).rows.map(norm);
}

// a kind that has nothing approved falls back to the built-in rule (never an empty calculator)
function withDefaults(list) {
  const out = list.slice();
  for (const r of DEFAULT_RULES) if (!list.some((x) => x.kind === r.kind)) out.push(r);
  return out;
}

async function refresh(db) {
  await ensureSeed(db);
  STAT.setRules(withDefaults(await approvedList(db)));
  loadedAt = Date.now();
}
// before a calculation: the rules in memory are at most 30 seconds old
async function ready(db) { if (Date.now() - loadedAt > 30000) await refresh(db); }

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
function shape(kind, d) {
  const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!d || typeof d !== 'object') bad('The rule data is missing');
  const nums = (o, keys, where) => keys.forEach((k) => { if (!o || !isNum(o[k])) bad(where + '.' + k + ' must be a number'); });
  const rows = (t, keys, where) => {
    if (!Array.isArray(t) || !t.length) bad(where + ' must be a list');
    let prev = -Infinity;
    t.forEach((r, i) => {
      const up = r.upper === null ? Infinity : r.upper;
      if (r.upper !== null && !isNum(r.upper)) bad(where + '[' + i + '].upper must be a number or null');
      if (up <= prev) bad(where + ' must go up in order of "upper" (null only on the last row)');
      prev = up; keys(r, where + '[' + i + ']');
    });
  };
  if (kind === 'epf') {
    if (!Array.isArray(d.bands) || !d.bands.length) bad('bands must be a list');
    d.bands.forEach((b, i) => nums(b, ['upto', 'step'], 'bands[' + i + ']'));
    nums(d, ['employee', 'employerLow', 'employerHigh', 'employerThreshold'], 'epf'); nums(d.over60, ['employee', 'employer'], 'over60'); nums(d.foreign, ['employee', 'employer'], 'foreign');
  } else if (kind === 'socso') {
    nums(d, ['ceiling'], 'socso'); if (!isMonth(d.skbbkFrom)) bad('skbbkFrom must be YYYY-MM');
    rows(d.table, (r, w) => { nums(r.cat1, ['employer', 'invalidity', 'skbbk'], w + '.cat1'); nums(r.cat2, ['employer', 'skbbk'], w + '.cat2'); }, 'table');
  } else if (kind === 'eis') {
    nums(d, ['ceiling'], 'eis'); rows(d.table, (r, w) => nums(r, ['employer', 'employee'], w), 'table');
  } else if (kind === 'pay') {
    nums(d.overtime, ['dailyDivisor', 'hoursPerDay', 'multiplier', 'step'], 'overtime'); nums(d, ['unpaidDivisor'], 'pay'); nums(d.age, ['senior', 'minor'], 'age');
    nums(d.estimate, ['ceiling', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer'], 'estimate');
    if (d.overtime.step <= 0 || d.overtime.dailyDivisor <= 0 || d.overtime.hoursPerDay <= 0 || d.unpaidDivisor <= 0) bad('divisors and the step must be above 0');
  } else bad('Unknown kind');
}

// the shape is right and a payslip can be calculated with it (no error, only finite numbers) for the main kinds of people
function check(kind, data) {
  shape(kind, data);
  const list = DEFAULT_RULES.filter((r) => r.kind !== kind).concat([{ kind, effectiveFrom: '1970-01-01', status: 'approved', data }]);
  const S = STAT.make(list);
  for (const month of ['2026-01', '2026-07', '2027-06']) for (const basic of [0, 800, 1500, 3000, 5000, 5400, 8000, 25000]) for (const [dob, nationality] of [['1985-05-05', 'MALAYSIAN'], ['1950-01-01', 'MALAYSIAN'], ['1990-01-01', 'FOREIGN']]) {
    let c; try { c = S.calc({ month, basic, otHours: 5, dob, nationality }); } catch (e) { throw Object.assign(new Error('A payslip can not be calculated with this rule: ' + e.message), { status: 400 }); }
    for (const [k, v] of Object.entries(c)) if (typeof v === 'number' && !Number.isFinite(v)) throw Object.assign(new Error('The rule gives a number that is not valid (' + k + ')'), { status: 400 });
  }
}

// the same wages calculated with the rules in force and with the rules plus one new version: for the Owner to look at before approving
const GRID = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000];
function compare(approved, candidate, month) {
  const base = STAT.make(withDefaults(approved));
  const next = STAT.make(withDefaults(approved.concat([Object.assign({}, candidate, { status: 'approved' })])));
  const rows = [];
  for (const [label, dob, nationality] of [['Malaysian, under 60', '1985-05-05', 'MALAYSIAN'], ['Malaysian, 60 and above', '1950-01-01', 'MALAYSIAN'], ['Foreign worker', '1990-01-01', 'FOREIGN']]) {
    for (const basic of GRID) {
      const p = { month, basic, dob, nationality }; const a = base.calc(p), b = next.calc(p);
      const pick = (c) => ({ epfEmployee: c.epfEmployee, epfEmployer: c.epfEmployer, socsoEmployee: c.socsoEmployee, skbbkEmployee: c.skbbkEmployee, socsoEmployer: c.socsoEmployer, eisEmployee: c.eisEmployee, eisEmployer: c.eisEmployer, otRate: c.otRate, net: c.net });
      const x = pick(a), y = pick(b);
      rows.push({ person: label, wages: basic, before: x, after: y, changed: JSON.stringify(x) !== JSON.stringify(y) });
    }
  }
  return rows;
}

module.exports = { KINDS, ensureSeed, approvedList, allRows, refresh, ready, check, compare, withDefaults, norm };
