const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyLogin, setSessionCookie, clearSessionCookie, forgetUserState, requireAuth } = require('../auth');
const { logActivity } = require('../lib/activity');
const { checkPassword } = require('../lib/password');
const { lockedMinutes, recordLoginFailure, clearLogin } = require('../lib/throttle');

const router = express.Router();

async function publicProfile(user) {
  let companyName = null;
  let enabledFeatures = null;
  if (user.company_id) {
    const { rows } = await pool.query('SELECT name, enabled_features FROM companies WHERE id = $1', [user.company_id]);
    if (rows[0]) {
      companyName = rows[0].name;
      enabledFeatures = rows[0].enabled_features;
    }
  }
  return {
    role: user.role,
    loginId: user.login_id,
    displayName: user.display_name,
    companyId: user.company_id,
    companyName,
    enabledFeatures,
    staffId: user.staff_id,
    userType: user.role === 'client' ? user.user_type : null,
    mustChangePassword: !!user.must_change_password
  };
}

router.post('/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return res.status(400).json({ error: 'Missing loginId or password' });

  // Too many wrong passwords for this login ID, or from this address, locks it for a while (the login ID counts even if it does not exist).
  const loginKey = 'u:' + String(loginId).trim().toLowerCase().slice(0, 60);
  const ipKey = 'ip:' + (req.ip || 'unknown');
  const wait = await lockedMinutes([loginKey, ipKey]);
  if (wait) {
    res.setHeader('Retry-After', String(wait * 60));
    return res.status(429).json({ error: '登录失败次数太多，请 ' + wait + ' 分钟后再试。 Too many failed attempts — try again in ' + wait + ' minute(s).' });
  }

  const user = await verifyLogin(loginId, password);
  if (!user) {
    await recordLoginFailure(loginKey, ipKey);
    return res.status(401).json({ error: 'Unrecognized ID or wrong password' });
  }
  await clearLogin(loginKey);

  setSessionCookie(res, user);
  res.json(await publicProfile(user));
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [req.user.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'Not signed in' });
  res.json(await publicProfile(rows[0]));
});

router.patch('/me/profile', requireAuth, async (req, res) => {
  const { displayName } = req.body || {};
  const trimmed = (displayName || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Display name is required' });

  const { rows } = await pool.query(
    'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING *',
    [trimmed, req.user.sub]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  await logActivity(user.id, 'Updated profile', trimmed, 'Changed display name');
  res.json(await publicProfile(user));
});

router.patch('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
  const problem = checkPassword(newPassword, user.login_id);
  if (problem) return res.status(400).json({ error: problem });
  if (await bcrypt.compare(newPassword, user.password_hash)) return res.status(400).json({ error: '新密码不能和旧密码一样。 The new password must be different from the old one.' });

  // A new password ends every other session of this account (token_version) and clears "must change password";
  // this browser gets a fresh session right away.
  const hash = await bcrypt.hash(newPassword, 10);
  const { rows: updated } = await pool.query(
    'UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1 WHERE id = $2 RETURNING *',
    [hash, user.id]
  );
  forgetUserState(user.id);
  setSessionCookie(res, updated[0]);
  await logActivity(user.id, 'Changed password', user.display_name, null);

  res.json({ ok: true });
});

module.exports = router;
