const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

router.get('/staff', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.client_limit, s.active,
      (SELECT COUNT(*) FROM company_staff cs WHERE cs.staff_id = s.id)::int AS assigned_count
    FROM staff s
    ORDER BY s.name
  `);
  res.json(rows);
});

router.patch('/staff/:id', requireRole('admin'), async (req, res) => {
  const { clientLimit, active } = req.body || {};
  const id = Number(req.params.id);

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
