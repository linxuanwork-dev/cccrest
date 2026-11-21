// Company settings (migration 057): the differences between companies are rows here, not code.
// A setting has a key, a JSON value and the date it starts. The newest row that has started is in force; older rows are the history.
const { pool } = require('../db');
const auditLog = require('./auditLog');

// the keys the page needs for every company (what to show, short name for file names): these are sent with /api/companies.
// Everything else (bank accounts, numbering ...) is only readable through the admin routes.
const PUBLIC_KEYS = ['sales_panel', 'merchant_report', 'eno_preselect', 'short_name'];
const KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

const today = () => new Date().toISOString().slice(0, 10);

/* { companyId: { key: value } } as in force on `date` */
async function effective(companyIds, date, opts) {
  const ids = (companyIds || []).map(Number).filter(Boolean);
  const out = {}; ids.forEach((id) => { out[id] = {}; });
  if (!ids.length) return out;
  const keys = opts && opts.keys;
  const { rows } = await (opts && opts.db || pool).query(
    `SELECT DISTINCT ON (company_id, key) company_id, key, value
       FROM company_settings
      WHERE company_id = ANY($1::int[]) AND effective_from <= $2::date ${keys ? 'AND key = ANY($3::text[])' : ''}
      ORDER BY company_id, key, effective_from DESC`,
    keys ? [ids, date || today(), keys] : [ids, date || today()]
  );
  rows.forEach((r) => { out[r.company_id][r.key] = r.value; });
  return out;
}

async function get(companyId, key, date, db) {
  const all = await effective([companyId], date, { db, keys: [key] });
  const v = all[companyId] && all[companyId][key];
  return v === undefined ? null : v;
}

/* Sets a value from a date on. The same key and date is replaced (the old value goes in the audit_log). A reason is required. */
async function set(db, { companyId, key, value, effectiveFrom, note, who, userId, reason }) {
  if (!KEY_RE.test(String(key || ''))) throw Object.assign(new Error('Setting key: lower case letters, digits and _ only'), { status: 400 });
  if (String(reason || '').trim().length < 3) throw Object.assign(new Error('A reason is required'), { status: 400 });
  if (value === undefined) throw Object.assign(new Error('A value is required'), { status: 400 });
  const from = effectiveFrom || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw Object.assign(new Error('The start date must be YYYY-MM-DD'), { status: 400 });
  const before = await get(companyId, key, from, db);
  await db.query(
    `INSERT INTO company_settings (company_id, key, value, effective_from, note, created_by)
     VALUES ($1,$2,$3::jsonb,$4::date,$5,$6)
     ON CONFLICT (company_id, key, effective_from) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()`,
    [companyId, key, JSON.stringify(value), from, note || null, who || null]
  );
  await auditLog.write(db, {
    who, userId, companyId, module: 'company_settings', record: key + ' (from ' + from + ')', action: before === null ? 'create' : 'update',
    field: key, before: before === null ? null : JSON.stringify(before), after: JSON.stringify(value), reason
  });
}

module.exports = { effective, get, set, PUBLIC_KEYS, KEY_RE };
