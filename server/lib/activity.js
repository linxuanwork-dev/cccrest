const { pool } = require('../db');

// Server-side activity logging: called from inside mutating route handlers so
// the log can't be spoofed or skipped by the client (unlike the old frontend
// mock which just pushed to a JS array anyone could bypass).
async function logActivity(actorUserId, action, target, details) {
  await pool.query(
    'INSERT INTO activity_log (actor_user_id, action, target, details) VALUES ($1,$2,$3,$4)',
    [actorUserId, action, target, details || null]
  );
}

module.exports = { logActivity };
