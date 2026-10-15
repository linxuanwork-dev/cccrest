const { pool } = require('../db');

// Pages a company user can be given a level on (keys match the permission JSON stored on the user).
const PAGES = ['sales', 'purchases', 'bank', 'claim', 'petty', 'merchant', 'payroll'];
const LEVEL_NAMES = { 1: 'Read Only', 2: 'Create', 3: 'Create & Update', 4: 'Full Access' };

// Resolves what the signed-in user may do on one page:
//   level      1-4 (Bukku style: Read Only / Create / Create & Update / Full Access)
//   canApprove named approver (needs at least L3)
//   ccCrest    CC CREST's own admin / manager accounts — the only people besides the approver who may
//              amend a record after it has been approved and locked
// The user row is read fresh each time so changing a user's permissions takes effect immediately.
async function getAccess(req, page) {
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'manager') return { level: 4, canApprove: true, ccCrest: true };
  if (role === 'staff') return { level: 3, canApprove: false, ccCrest: false };
  if (role === 'client') {
    const { rows } = await pool.query('SELECT user_type, permissions, can_approve FROM users WHERE id = $1 AND active = true', [req.user.sub]);
    const u = rows[0];
    if (!u) return { level: 0, canApprove: false, ccCrest: false };
    const level = u.user_type === 'administrator' ? 4 : Number((u.permissions || {})[page]) || 1;
    return { level, canApprove: !!u.can_approve && level >= 3, ccCrest: false };
  }
  return { level: 0, canApprove: false, ccCrest: false };
}

module.exports = { PAGES, LEVEL_NAMES, getAccess };
