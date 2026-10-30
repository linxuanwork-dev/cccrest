const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireRole, forgetUserState } = require('../auth');
const { logActivity } = require('../lib/activity');
const { checkPassword } = require('../lib/password');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers — see the same wrapper in dailySales.js.
['get', 'post', 'patch', 'delete'].forEach((method) => {
  const original = router[method].bind(router);
  router[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((fn) => (
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  )));
});

// Login accounts of the CC CREST team (Owner, managers, staff), managed ONLY by the Owner.
// Company (client) users are managed from Customer Queue instead.

async function loadAccount(id) {
  const { rows } = await pool.query(
    `SELECT id, login_id, display_name, role, staff_id, active, must_change_password FROM users WHERE id = $1 AND role IN ('admin','manager','staff')`,
    [id]
  );
  return rows[0] || null;
}

async function otherActiveOwners(exceptId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active = true AND id <> $1", [exceptId]);
  return rows[0].n;
}

router.get('/accounts', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login_id, display_name, role, staff_id, active, must_change_password FROM users
     WHERE role IN ('admin','manager','staff')
     ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, display_name`
  );
  res.json(rows.map((u) => ({
    id: u.id, loginId: u.login_id, displayName: u.display_name, role: u.role, active: u.active,
    mustChangePassword: u.must_change_password, isMe: u.id === req.user.sub
  })));
});

// Owner sets a new password for someone; they must choose their own at the next login and every open session ends.
router.post('/accounts/:id/reset-password', requireRole('admin'), async (req, res) => {
  const u = await loadAccount(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.sub) return res.status(400).json({ error: '请用右上角的 My Profile 修改自己的密码。 Use My Profile to change your own password.' });
  const password = String((req.body || {}).password || '');
  const problem = checkPassword(password, u.login_id);
  if (problem) return res.status(400).json({ error: problem });

  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash = $1, must_change_password = true, token_version = token_version + 1 WHERE id = $2', [hash, u.id]);
  forgetUserState(u.id);
  await pool.query('DELETE FROM login_throttle WHERE key = $1', ['u:' + u.login_id]);
  await logActivity(req.user.sub, 'Reset password', u.display_name, 'Login ID: ' + u.login_id);
  res.json({ ok: true });
});

// Switch an account off (cannot sign in, open sessions end) or back on.
router.patch('/accounts/:id', requireRole('admin'), async (req, res) => {
  const u = await loadAccount(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const active = (req.body || {}).active;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  if (!active) {
    if (u.id === req.user.sub) return res.status(400).json({ error: '不能停用自己的账号。 You cannot switch off your own account.' });
    if (u.role === 'admin' && (await otherActiveOwners(u.id)) === 0) return res.status(400).json({ error: '至少要保留一个启用中的 Owner 账号。 At least one active Owner account must remain.' });
  }
  await pool.query('UPDATE users SET active = $1, token_version = token_version + 1 WHERE id = $2', [active, u.id]);
  if (u.staff_id) await pool.query('UPDATE staff SET active = $1 WHERE id = $2', [active, u.staff_id]);
  // Switching someone off (e.g. they left) also takes them off every company and every manager's team.
  let removed = 0;
  if (!active) {
    if (u.staff_id) {
      const r = await pool.query('DELETE FROM company_staff WHERE staff_id = $1', [u.staff_id]);
      removed = r.rowCount;
      await pool.query('DELETE FROM manager_staff WHERE staff_id = $1', [u.staff_id]);
    }
    await pool.query('DELETE FROM manager_staff WHERE manager_user_id = $1', [u.id]);
  }
  forgetUserState(u.id);
  await logActivity(req.user.sub, active ? 'Switched account on' : 'Switched account off', u.display_name,
    'Login ID: ' + u.login_id + (removed ? '; removed from ' + removed + ' compan' + (removed === 1 ? 'y' : 'ies') : ''));
  res.json({ ok: true, active, removedCompanies: removed });
});

// Delete an account. A person who already has work history (activity log, requests, claims…) cannot be erased without
// breaking that history, so they are switched off and taken off every company instead.
router.delete('/accounts/:id', requireRole('admin'), async (req, res) => {
  const u = await loadAccount(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.sub) return res.status(400).json({ error: '不能删除自己的账号。 You cannot delete your own account.' });
  if (u.role === 'admin' && (await otherActiveOwners(u.id)) === 0) return res.status(400).json({ error: '至少要保留一个启用中的 Owner 账号。 At least one active Owner account must remain.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM users WHERE id = $1', [u.id]);
    if (u.staff_id) await client.query('DELETE FROM staff WHERE id = $1', [u.staff_id]);
    await client.query('COMMIT');
    forgetUserState(u.id);
    await logActivity(req.user.sub, 'Deleted account', u.display_name, 'Login ID: ' + u.login_id);
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code !== '23503') throw err;
  } finally {
    client.release();
  }

  // has history: keep the record, remove the access
  await pool.query('UPDATE users SET active = false, token_version = token_version + 1 WHERE id = $1', [u.id]);
  if (u.staff_id) {
    await pool.query('UPDATE staff SET active = false WHERE id = $1', [u.staff_id]);
    await pool.query('DELETE FROM company_staff WHERE staff_id = $1', [u.staff_id]);
  }
  await pool.query('DELETE FROM manager_staff WHERE manager_user_id = $1', [u.id]);
  forgetUserState(u.id);
  await logActivity(req.user.sub, 'Switched account off (has history, kept)', u.display_name, 'Login ID: ' + u.login_id);
  res.json({ ok: true, deleted: false, switchedOff: true });
});

router.use((err, req, res, next) => {
  console.error('accounts route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
