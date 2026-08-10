const express = require('express');
const { pool } = require('../db');
const { verifyLogin, setSessionCookie, clearSessionCookie, COOKIE_NAME } = require('../auth');
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

module.exports = router;
