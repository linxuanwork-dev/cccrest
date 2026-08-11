const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyLogin, setSessionCookie, clearSessionCookie, COOKIE_NAME, requireAuth } = require('../auth');
const { logActivity } = require('../lib/activity');
const jwt = require('jsonwebtoken');

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
    staffId: user.staff_id
  };
}

router.post('/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return res.status(400).json({ error: 'Missing loginId or password' });

  const user = await verifyLogin(loginId, password);
  if (!user) return res.status(401).json({ error: 'Unrecognized ID or wrong password' });

  setSessionCookie(res, user);
  res.json(await publicProfile(user));
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [payload.sub]);
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
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  await logActivity(user.id, 'Changed password', user.display_name, null);

  res.json({ ok: true });
});

module.exports = router;
