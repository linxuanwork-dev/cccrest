const { pool } = require('../db');
const auditLog = require('./auditLog');

// Server-side activity logging: called from inside mutating route handlers so
// the log can't be spoofed or skipped by the client (unlike the old frontend
// mock which just pushed to a JS array anyone could bypass).
// Every record is also written to the one audit_log (phase 1, step 5): `db` is the pool or the client of a running transaction.
async function logActivity(actorUserId, action, target, details, db) {
  const q = db || pool;
  const { rows } = await q.query(
    'INSERT INTO activity_log (actor_user_id, action, target, details) VALUES ($1,$2,$3,$4) RETURNING id',
    [actorUserId, action, target, details || null]
  );
  if (db) await q.query('SAVEPOINT audit_sp');   // inside a transaction a failed audit write must not abort the whole transaction
  try {
    const company = (await q.query('SELECT id FROM companies WHERE name = $1 ORDER BY id LIMIT 1', [target])).rows[0];
    await auditLog.write(q, {
      who: (await auditLog.userName(q, actorUserId)) || 'system', userId: actorUserId, companyId: company ? company.id : null,
      module: 'activity', record: target, action, after: details, source: 'activity_log:' + rows[0].id
    });
    if (db) await q.query('RELEASE SAVEPOINT audit_sp');
  } catch (err) {
    if (db) await q.query('ROLLBACK TO SAVEPOINT audit_sp').catch(() => {});
    // the old log is complete; a failure here must not break the work that was done (it is visible in the server log)
    console.error('audit_log write failed (activity):', err.message);
  }
}

module.exports = { logActivity };
