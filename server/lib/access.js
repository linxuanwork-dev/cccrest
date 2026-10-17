const { pool } = require('../db');

// Pages a user can be given a level on (keys match the permission JSON stored on the user / assignment).
const PAGES = ['sales', 'purchases', 'bank', 'claim', 'petty', 'merchant', 'payroll'];
const LEVEL_NAMES = { 0: 'No access', 1: 'Read Only', 2: 'Create', 3: 'Create & Update', 4: 'Full Access' };

// Fills in every page with a valid level. `min` is the lowest level allowed (0 = "No access" is possible for
// CC CREST staff; company users start at 1); anything missing or invalid becomes `fallback`.
function normaliseLevels(input, min, fallback) {
  const out = {};
  for (const page of PAGES) {
    const n = Number(input && input[page]);
    out[page] = Number.isInteger(n) && n >= min && n <= 4 ? n : fallback;
  }
  return out;
}

function validLevels(input, min) {
  if (input == null) return true;
  if (typeof input !== 'object') return false;
  return Object.keys(input).every((k) => PAGES.includes(k) && Number.isInteger(Number(input[k])) && Number(input[k]) >= min && Number(input[k]) <= 4);
}

// Resolves what the signed-in user may do on one page of the company in the URL:
//   level      0-4 (No access / Read Only / Create / Create & Update / Full Access)
//   canApprove named approver (needs at least L3)
//   ccCrest    CC CREST's own admin / manager accounts — the only people besides the approver who may
//              amend a record after it has been approved and locked
// CC CREST staff get the levels set on their assignment to this company; company users get the levels set on
// their account. Rows are read fresh each time so changes take effect immediately.
async function getAccess(req, page) {
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'manager') return { level: 4, canApprove: true, ccCrest: true };

  if (role === 'staff') {
    const { rows } = await pool.query(
      'SELECT permissions, can_approve FROM company_staff WHERE company_id = $1 AND staff_id = $2',
      [req.params.companyId, req.user.staffId]
    );
    const row = rows[0];
    if (!row) return { level: 0, canApprove: false, ccCrest: false };
    const raw = Number((row.permissions || {})[page]);
    const level = Number.isInteger(raw) && raw >= 0 && raw <= 4 ? raw : 0;
    return { level, canApprove: !!row.can_approve && level >= 3, ccCrest: false };
  }

  if (role === 'client') {
    const { rows } = await pool.query('SELECT user_type, permissions, can_approve FROM users WHERE id = $1 AND active = true', [req.user.sub]);
    const u = rows[0];
    if (!u) return { level: 0, canApprove: false, ccCrest: false };
    const level = u.user_type === 'administrator' ? 4 : Number((u.permissions || {})[page]) || 1;
    return { level, canApprove: !!u.can_approve && level >= 3, ccCrest: false };
  }

  return { level: 0, canApprove: false, ccCrest: false };
}

// Route guard for the page-specific endpoints: needs at least `minLevel` on `page`
// (1 = view, 2 = create, 3 = change). Admin / manager always pass.
function requirePage(page, minLevel = 1) {
  return async (req, res, next) => {
    try {
      const access = await getAccess(req, page);
      if (access.level < minLevel) {
        return res.status(403).json({ error: minLevel <= 1 ? '你没有权限使用这个页面' : `你的权限不足（这个操作需要 L${minLevel} 或以上）` });
      }
      req.pageAccess = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { PAGES, LEVEL_NAMES, normaliseLevels, validLevels, getAccess, requirePage };
