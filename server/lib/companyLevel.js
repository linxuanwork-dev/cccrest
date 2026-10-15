const { pool } = require('../db');

// "Manager level" = the Owner (admin), a CC CREST team manager, or a company user whose level is "manager".
// Company users' level is read from the database each time, so changing it takes effect immediately
// (not only after their next login).
async function isManagerLevel(req) {
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'manager') return true;
  if (role === 'client') {
    const { rows } = await pool.query('SELECT company_level FROM users WHERE id = $1 AND active = true', [req.user.sub]);
    return !!rows[0] && rows[0].company_level === 'manager';
  }
  return false;
}

module.exports = { isManagerLevel };
