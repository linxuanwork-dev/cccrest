const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireRole, staffInManagerTeam } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

router.get('/staff', requireRole('admin', 'manager'), async (req, res) => {
  const scopeClause = req.user.role === 'manager'
    ? 'WHERE s.id IN (SELECT staff_id FROM manager_staff WHERE manager_user_id = $1)'
    : '';
  const params = req.user.role === 'manager' ? [req.user.sub] : [];
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.client_limit, s.active,
      (SELECT COUNT(*) FROM company_staff cs WHERE cs.staff_id = s.id)::int AS assigned_count
    FROM staff s
    ${scopeClause}
    ORDER BY s.name
  `, params);
  res.json(rows);
});

router.post('/staff', requireRole('admin'), async (req, res) => {
  const { name, loginId, password, clientLimit } = req.body || {};
  if (!name || !loginId || !password) {
    return res.status(400).json({ error: 'name, loginId, and password are required' });
  }
  const limit = Number.isFinite(Number(clientLimit)) && Number(clientLimit) > 0 ? Number(clientLimit) : 20;
  const hash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: staffRows } = await client.query(
      'INSERT INTO staff (name, client_limit, active) VALUES ($1,$2,true) RETURNING *',
      [name.trim(), limit]
    );
    await client.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, staff_id, active)
       VALUES ($1,$2,'staff',$3,$4,true)`,
      [loginId.trim().toLowerCase(), hash, name.trim(), staffRows[0].id]
    );
    await client.query('COMMIT');
    await logActivity(req.user.sub, 'Created staff account', name.trim(), 'Login ID: ' + loginId.trim().toLowerCase());
    res.status(201).json(staffRows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'That staff name or login ID is already taken' });
    throw err;
  } finally {
    client.release();
  }
});

router.patch('/staff/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { clientLimit, active } = req.body || {};
  const id = Number(req.params.id);

  if (req.user.role === 'manager') {
    const inTeam = await staffInManagerTeam(req.user.sub, id);
    if (!inTeam) return res.status(403).json({ error: 'That staff member is not on your team' });
  }

  const { rows: before } = await pool.query('SELECT * FROM staff WHERE id = $1', [id]);
  if (!before[0]) return res.status(404).json({ error: 'Not found' });

  const newLimit = Number.isFinite(clientLimit) ? Math.max(1, clientLimit) : before[0].client_limit;
  const newActive = typeof active === 'boolean' ? active : before[0].active;

  const { rows } = await pool.query(
    'UPDATE staff SET client_limit = $1, active = $2 WHERE id = $3 RETURNING *',
    [newLimit, newActive, id]
  );

  const changes = [];
  if (before[0].client_limit !== newLimit) changes.push(`limit ${before[0].client_limit} → ${newLimit}`);
  if (before[0].active !== newActive) changes.push(newActive ? 'access re-enabled' : 'access suspended');
  if (changes.length) {
    await logActivity(req.user.sub, 'Updated staff access', before[0].name, changes.join('; '));
  }

  res.json(rows[0]);
});

module.exports = router;
