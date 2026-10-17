const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { PAGES, normaliseLevels, validLevels } = require('../lib/access');
const { logActivity } = require('../lib/activity');

const router = express.Router();
const USER_TYPES = ['user', 'administrator'];

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'patch'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Company users are managed ONLY by the CC CREST Owner (main admin account), from Customer Queue.
// Nobody else can list, add or change them.

// Company users always have a level on every page (1 Read Only .. 4 Full Access); anything missing is Read Only.
const normalisePermissions = (input) => normaliseLevels(input, 1, 1);
const validPermissions = (input) => validLevels(input, 1);

function publicUser(u) {
  return {
    id: u.id, loginId: u.login_id, displayName: u.display_name, userType: u.user_type,
    permissions: normalisePermissions(u.permissions), canApprove: u.can_approve, active: u.active
  };
}

// An approver needs at least Create & Update on Sales Summary (Administrators always have Full Access).
function approverProblem(userType, permissions, canApprove) {
  if (canApprove && userType !== 'administrator' && permissions.sales < 3) return '审核人需要 Sales Summary 至少 L3（Create & Update）。';
  return null;
}

router.get('/companies/:companyId/users', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login_id, display_name, user_type, permissions, can_approve, active FROM users
     WHERE company_id = $1 AND role = 'client' ORDER BY user_type DESC, login_id`,
    [req.params.companyId]
  );
  res.json({ users: rows.map(publicUser), pages: PAGES });
});

router.post('/companies/:companyId/users', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const loginId = String(body.loginId || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim();
  const password = String(body.password || '');
  const userType = body.userType;

  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(loginId)) return res.status(400).json({ error: 'Login ID 需为 3–40 个字符（小写字母、数字、. _ -）。' });
  if (!displayName) return res.status(400).json({ error: '请填写姓名。' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 个字符。' });
  if (!USER_TYPES.includes(userType)) return res.status(400).json({ error: '请选择类型（User 或 Administrator）。' });
  if (!validPermissions(body.permissions)) return res.status(400).json({ error: '权限级别无效（L1–L4）。' });

  const permissions = normalisePermissions(body.permissions);
  const canApprove = body.canApprove === true;
  const problem = approverProblem(userType, permissions, canApprove);
  if (problem) return res.status(400).json({ error: problem });

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  if (!companyRows[0]) return res.status(404).json({ error: 'Company not found' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, company_id, user_type, permissions, can_approve, active)
       VALUES ($1,$2,'client',$3,$4,$5,$6,$7,true)
       RETURNING id, login_id, display_name, user_type, permissions, can_approve, active`,
      [loginId, hash, displayName, req.params.companyId, userType, JSON.stringify(permissions), canApprove]
    );
    await logActivity(req.user.sub, 'Added company user', companyRows[0].name, `${loginId} (${userType}${canApprove ? ', approver' : ''})`);
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '这个 Login ID 已经被使用。' });
    throw err;
  }
});

router.patch('/companies/:companyId/users/:userId', requireRole('admin'), async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT * FROM users WHERE id = $1 AND company_id = $2 AND role = 'client'`,
    [req.params.userId, req.params.companyId]
  );
  const u = existing[0];
  if (!u) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const userType = body.userType === undefined ? u.user_type : body.userType;
  if (!USER_TYPES.includes(userType)) return res.status(400).json({ error: '类型无效。' });
  if (!validPermissions(body.permissions)) return res.status(400).json({ error: '权限级别无效（L1–L4）。' });
  if (body.password !== undefined && body.password !== '' && String(body.password).length < 6) return res.status(400).json({ error: '密码至少 6 个字符。' });

  const permissions = body.permissions === undefined ? normalisePermissions(u.permissions) : normalisePermissions(body.permissions);
  const canApprove = typeof body.canApprove === 'boolean' ? body.canApprove : u.can_approve;
  const active = typeof body.active === 'boolean' ? body.active : u.active;
  const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : u.display_name;
  const problem = approverProblem(userType, permissions, canApprove);
  if (problem) return res.status(400).json({ error: problem });

  const hash = body.password ? await bcrypt.hash(String(body.password), 10) : u.password_hash;
  const { rows } = await pool.query(
    `UPDATE users SET display_name = $1, user_type = $2, permissions = $3, can_approve = $4, active = $5, password_hash = $6
     WHERE id = $7 RETURNING id, login_id, display_name, user_type, permissions, can_approve, active`,
    [displayName, userType, JSON.stringify(permissions), canApprove, active, hash, u.id]
  );

  const changes = [];
  if (userType !== u.user_type) changes.push(`type ${u.user_type} → ${userType}`);
  if (JSON.stringify(normalisePermissions(u.permissions)) !== JSON.stringify(permissions)) changes.push('page levels changed');
  if (canApprove !== u.can_approve) changes.push(canApprove ? 'made an approver' : 'approver removed');
  if (active !== u.active) changes.push(active ? 'access re-enabled' : 'access removed');
  if (body.password) changes.push('password reset');
  if (displayName !== u.display_name) changes.push('name changed');
  if (changes.length) {
    const { rows: co } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
    await logActivity(req.user.sub, 'Updated company user', co[0].name, `${u.login_id}: ${changes.join('; ')}`);
  }
  res.json(publicUser(rows[0]));
});

router.use((err, req, res, next) => {
  console.error('companyUsers route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
