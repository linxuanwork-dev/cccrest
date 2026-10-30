const { pool } = require('../db');

// Limits on failed logins: a login ID is locked after USER_MAX failures inside WINDOW, and an address after IP_MAX.
// Locks last LOCK minutes. A successful login clears that login ID's counter.
const WINDOW = '15 minutes';
const LOCK = '15 minutes';
const USER_MAX = 5;
const IP_MAX = 30;

// -> minutes left on a lock, or 0 when the keys are free
async function lockedMinutes(keys) {
  const { rows } = await pool.query(
    'SELECT EXTRACT(EPOCH FROM (max(locked_until) - now())) AS secs FROM login_throttle WHERE key = ANY($1) AND locked_until > now()',
    [keys]
  );
  const secs = rows[0] && rows[0].secs ? Number(rows[0].secs) : 0;
  return secs > 0 ? Math.max(1, Math.ceil(secs / 60)) : 0;
}

async function recordFailure(key, max) {
  await pool.query(
    `INSERT INTO login_throttle (key, fails, window_start, locked_until)
     VALUES ($1, 1, now(), CASE WHEN $2::int <= 1 THEN now() + interval '${LOCK}' END)
     ON CONFLICT (key) DO UPDATE SET
       fails = CASE WHEN login_throttle.window_start < now() - interval '${WINDOW}' THEN 1 ELSE login_throttle.fails + 1 END,
       window_start = CASE WHEN login_throttle.window_start < now() - interval '${WINDOW}' THEN now() ELSE login_throttle.window_start END,
       locked_until = CASE WHEN (CASE WHEN login_throttle.window_start < now() - interval '${WINDOW}' THEN 1 ELSE login_throttle.fails + 1 END) >= $2::int
                           THEN now() + interval '${LOCK}' ELSE login_throttle.locked_until END`,
    [key, max]
  );
}

async function recordLoginFailure(loginKey, ipKey) {
  await recordFailure(loginKey, USER_MAX);
  await recordFailure(ipKey, IP_MAX);
  if (Math.random() < 0.05) await pool.query("DELETE FROM login_throttle WHERE window_start < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())");
}

async function clearLogin(loginKey) {
  await pool.query('DELETE FROM login_throttle WHERE key = $1', [loginKey]);
}

module.exports = { lockedMinutes, recordLoginFailure, clearLogin };
