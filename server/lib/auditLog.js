// The one audit_log (migration 057): who, when, which company, module and record, what was done, before / after, why.
// A row can not be changed or deleted (a trigger refuses). `db` is the pool or a client inside a transaction.
const { pool } = require('../db');

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

async function write(db, e) {
  await (db || pool).query(
    `INSERT INTO audit_log (who, user_id, company_id, module, record, action, field, before, after, reason, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [clip(e.who, 120) || 'system', e.userId || null, e.companyId || null, clip(e.module, 60), clip(e.record, 200), clip(e.action, 40),
      clip(e.field, 120), clip(e.before, 2000), clip(e.after, 2000), clip(e.reason, 500), clip(e.source, 100)]
  );
}

async function userName(db, userId) {
  if (!userId) return '';
  const { rows } = await (db || pool).query('SELECT display_name, login_id FROM users WHERE id = $1', [userId]);
  return rows[0] ? (rows[0].display_name || rows[0].login_id || '') : '';
}

module.exports = { write, userName };
