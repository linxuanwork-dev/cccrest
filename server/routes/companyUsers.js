const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, scopeToCompany } = require('../auth');
const { isManagerLevel } = require('../lib/companyLevel');
const { logActivity } = require('../lib/activity');

const router = express.Router();
const LEVELS = ['staff', 'manager'];
const MANAGER_ONLY_MSG = '只有 Manager 可以管理用户';

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'patch'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

async function requireUserManager(req, res, next) {
  if (await isManagerLevel(req)) return next();
  res.status(403).json({ error: MANAGER_ONLY_MSG });
}

function publicUser(u) {
  return { id: u.id, loginId: u.login_id, displayName: u.display_name, level: u.company_level, active: u.active };
}

// Everyone below is a company user: role "client" tied to this company, with a level (staff / manager).
router.get('/companies/:companyId/users', requireAuth, scopeToCompany, requireUserManager, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login_id, display_name, company_level, active FROM users
     WHERE company_id = $1 AND role = 'client' ORDER BY company_level DESC, login_id`,
    [req.params.companyId]
  );
  res.json({ users: rows.map(publicUser), currentUserId: req.user.sub });
});

router.post('/companies/:companyId/users', requireAuth, scopeToCompany, requireUserManager, async (req, res) => {
  const body = req.body || {};
  const loginId = String(body.loginId || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim();
  const password = String(body.password || '');
  const level = body.level;

  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(loginId)) return res.status(400).json({ error: 'Login ID 需为 3–40 个字符（小写字母、数字、. _ -）。' });
  if (!displayName) return res.status(400).json({ error: '请填写姓名。' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 个字符。' });
  if (!LEVELS.includes(level)) return res.status(400).json({ error: '请选择级别（Staff 或 Manager）。' });

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [req.params.companyId]);
  if (!companyRows[0]) return res.status(404).json({ error: 'Company not found' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, company_id, company_level, active)
       VALUES ($1,$2,'client',$3,$4,$5,true) RETURNING id, login_id, display_name, company_level, active`,
      [loginId, hash, displayName, req.params.companyId, level]
    );
    await logActivity(req.user.sub, 'Added company user', companyRows[0].name, `${loginId} (${level})`);
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '这个 Login ID 已经被使用。' });
    throw err;
  }
});

router.patch('/companies/:companyId/users/:userId', requireAuth, scopeToCompany, requireUserManager, async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT * FROM users WHERE id = $1 AND company_id = $2 AND role = 'client'`,
    [req.params.userId, req.params.companyId]
  );
  const u = existing[0];
  if (!u) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const level = body.level === undefined ? u.company_level : body.level;
  const active = typeof body.active === 'boolean' ? body.active : u.active;
  const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : u.display_name;
  if (!LEVELS.includes(level)) return res.status(400).json({ error: '级别无效。' });
  if (body.password !== undefined && body.password !== '' && String(body.password).length < 6) return res.status(400).json({ error: '密码至少 6 个字符。' });

  if (u.id === req.user.sub && (level !== u.company_level || active !== u.active)) {
    return res.status(400).json({ error: '不能修改自己的级别或停用自己的账号。' });
  }

  const hash = body.password ? await bcrypt.hash(String(body.password), 10) : u.password_hash;
  const { rows } = await pool.query(
    `UPDATE users SET display_name = $1, company_level = $2, active = $3, password_hash = $4
     WHERE id = $5 RETURNING id, login_id, display_name, company_level, active`,
    [displayName, level, active, hash, u.id]
  );

  const changes = [];
  if (level !== u.company_level) changes.push(`level ${u.company_level} → ${level}`);
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
