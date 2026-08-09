const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();

router.get('/activity-log', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT al.id, al.action, al.target, al.details, al.created_at,
      COALESCE(u.display_name, 'System') AS actor
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.actor_user_id
    ORDER BY al.created_at DESC
    LIMIT 200
  `);
  res.json(rows);
});

module.exports = router;
