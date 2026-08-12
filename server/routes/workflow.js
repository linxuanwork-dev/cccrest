const express = require('express');
const { pool } = require('../db');
const { requireRole, staffInManagerTeam } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
const PERIOD = '2026-08';

// ============ MANAGERS (admin only) ============

router.get('/managers', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.login_id, u.display_name, u.active,
      COALESCE(array_agg(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL), '{}') AS team_staff_ids,
      COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS team_staff_names
    FROM users u
    LEFT JOIN manager_staff ms ON ms.manager_user_id = u.id
    LEFT JOIN staff s ON s.id = ms.staff_id
    WHERE u.role = 'manager'
    GROUP BY u.id
    ORDER BY u.display_name
  `);
  res.json(rows);
});

router.put('/managers/:managerId/team', requireRole('admin'), async (req, res) => {
  const { staffIds } = req.body || {};
  if (!Array.isArray(staffIds)) return res.status(400).json({ error: 'staffIds must be an array' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: mgrRows } = await client.query("SELECT display_name FROM users WHERE id = $1 AND role = 'manager'", [req.params.managerId]);
    if (!mgrRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Manager not found' });
    }
    await client.query('DELETE FROM manager_staff WHERE manager_user_id = $1', [req.params.managerId]);
    for (const staffId of staffIds) {
      await client.query('INSERT INTO manager_staff (manager_user_id, staff_id) VALUES ($1,$2)', [req.params.managerId, staffId]);
    }
    await client.query('COMMIT');
    const { rows: staffRows } = await pool.query('SELECT name FROM staff WHERE id = ANY($1)', [staffIds]);
    await logActivity(req.user.sub, 'Updated manager team', mgrRows[0].display_name, 'Team: ' + staffRows.map((s) => s.name).join(', '));
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ============ WORKFLOW OVERVIEW (admin/owner only) ============

router.get('/workflow/overview', requireRole('admin'), async (req, res) => {
  const { rows: staffRows } = await pool.query(`
    SELECT s.id, s.name, s.active, s.client_limit,
      COUNT(DISTINCT cs.company_id)::int AS assigned_count,
      COUNT(DISTINCT CASE WHEN rb.status IS DISTINCT FROM 'Completed' THEN cs.company_id END)::int AS outstanding_count,
      COUNT(DISTINCT CASE WHEN rb.status = 'Completed' THEN cs.company_id END)::int AS completed_count
    FROM staff s
    LEFT JOIN company_staff cs ON cs.staff_id = s.id
    LEFT JOIN reconciliation_batches rb ON rb.company_id = cs.company_id AND rb.period_month = $1
    GROUP BY s.id
    ORDER BY s.name
  `, [PERIOD]);

  const { rows: managerRows } = await pool.query(`
    SELECT u.id, u.display_name,
      COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS team_names,
      COUNT(DISTINCT cs.company_id)::int AS team_assigned,
      COUNT(DISTINCT CASE WHEN rb.status IS DISTINCT FROM 'Completed' THEN cs.company_id END)::int AS team_outstanding
    FROM users u
    LEFT JOIN manager_staff ms ON ms.manager_user_id = u.id
    LEFT JOIN staff s ON s.id = ms.staff_id
    LEFT JOIN company_staff cs ON cs.staff_id = ms.staff_id
    LEFT JOIN reconciliation_batches rb ON rb.company_id = cs.company_id AND rb.period_month = $1
    WHERE u.role = 'manager'
    GROUP BY u.id
    ORDER BY u.display_name
  `, [PERIOD]);

  res.json({ staff: staffRows, managers: managerRows });
});

// ============ MY JOBS (admin/manager/staff) ============

async function outstandingJobsFor(staffId) {
  const { rows: jobs } = await pool.query(`
    SELECT c.id AS company_id, c.name AS company_name, rb.status, rb.updated_at
    FROM company_staff cs
    JOIN companies c ON c.id = cs.company_id
    LEFT JOIN reconciliation_batches rb ON rb.company_id = c.id AND rb.period_month = $2
    WHERE cs.staff_id = $1 AND (rb.status IS DISTINCT FROM 'Completed')
    ORDER BY c.name
  `, [staffId, PERIOD]);

  const { rows: reminders } = await pool.query(`
    SELECT jr.id, jr.company_id, jr.note, jr.created_at, jr.acknowledged_at, u.display_name AS sent_by
    FROM job_reminders jr JOIN users u ON u.id = jr.sent_by_user_id
    WHERE jr.staff_id = $1
    ORDER BY jr.created_at DESC
  `, [staffId]);

  return jobs.map((j) => ({
    ...j,
    reminders: reminders.filter((r) => r.company_id === j.company_id)
  }));
}

router.get('/workflow/my-jobs', requireRole('admin', 'manager', 'staff'), async (req, res) => {
  const result = { mine: [], team: [] };

  if (req.user.staffId) {
    result.mine = await outstandingJobsFor(req.user.staffId);
  }

  if (req.user.role === 'manager') {
    const { rows: team } = await pool.query(
      'SELECT s.id, s.name FROM manager_staff ms JOIN staff s ON s.id = ms.staff_id WHERE ms.manager_user_id = $1 ORDER BY s.name',
      [req.user.sub]
    );
    for (const member of team) {
      result.team.push({ staffId: member.id, staffName: member.name, jobs: await outstandingJobsFor(member.id) });
    }
  }

  res.json(result);
});

router.post('/workflow/remind', requireRole('admin', 'manager'), async (req, res) => {
  const { companyId, staffId, note } = req.body || {};
  if (!companyId || !staffId) return res.status(400).json({ error: 'companyId and staffId are required' });

  if (req.user.role === 'manager') {
    const inTeam = await staffInManagerTeam(req.user.sub, staffId);
    if (!inTeam) return res.status(403).json({ error: 'That staff member is not on your team' });
  }

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [companyId]);
  const { rows: staffRows } = await pool.query('SELECT name FROM staff WHERE id = $1', [staffId]);
  if (!companyRows[0] || !staffRows[0]) return res.status(404).json({ error: 'Not found' });

  const { rows: assignedRows } = await pool.query(
    'SELECT 1 FROM company_staff WHERE company_id = $1 AND staff_id = $2',
    [companyId, staffId]
  );
  if (!assignedRows[0]) {
    return res.status(400).json({ error: `${staffRows[0].name} is not assigned to ${companyRows[0].name}` });
  }

  const { rows } = await pool.query(
    'INSERT INTO job_reminders (company_id, staff_id, sent_by_user_id, note) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
    [companyId, staffId, req.user.sub, note || null]
  );

  await logActivity(req.user.sub, 'Sent reminder', staffRows[0].name, companyRows[0].name + (note ? ' — ' + note : ''));
  res.status(201).json(rows[0]);
});

router.post('/workflow/reminders/:id/acknowledge', requireRole('admin', 'manager', 'staff'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM job_reminders WHERE id = $1', [req.params.id]);
  const reminder = rows[0];
  if (!reminder) return res.status(404).json({ error: 'Not found' });

  if (req.user.role !== 'admin' && req.user.staffId !== reminder.staff_id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  await pool.query('UPDATE job_reminders SET acknowledged_at = now() WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
