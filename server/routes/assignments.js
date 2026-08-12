const express = require('express');
const { pool } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();

async function namesForIds(ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await pool.query('SELECT id, name FROM staff WHERE id = ANY($1)', [ids]);
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

router.get('/assignment-requests', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT ar.id, ar.status, ar.created_at, ar.resolved_at,
      c.name AS company, c.id AS company_id,
      ar.current_staff_ids, ar.requested_staff_ids,
      u.display_name AS requested_by
    FROM assignment_requests ar
    JOIN companies c ON c.id = ar.company_id
    JOIN users u ON u.id = ar.requested_by_user_id
    ORDER BY (ar.status = 'Pending') DESC, ar.id DESC
  `);

  const out = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      status: r.status,
      company: r.company,
      companyId: r.company_id,
      currentStaff: await namesForIds(r.current_staff_ids),
      requestedStaff: await namesForIds(r.requested_staff_ids),
      requestedBy: r.requested_by,
      date: r.created_at
    });
  }
  res.json(out);
});

router.post('/assignment-requests', requireRole('admin', 'staff'), async (req, res) => {
  const { companyId, requestedStaffIds } = req.body || {};
  if (!companyId || !Array.isArray(requestedStaffIds) || requestedStaffIds.length === 0) {
    return res.status(400).json({ error: 'companyId and requestedStaffIds are required' });
  }
  if (requestedStaffIds.length > 2) {
    return res.status(400).json({ error: 'Maximum of 2 staff per client' });
  }

  const { rows: currentRows } = await pool.query('SELECT staff_id FROM company_staff WHERE company_id = $1', [companyId]);
  const currentIds = currentRows.map((r) => r.staff_id);

  const newlyAdded = requestedStaffIds.filter((id) => !currentIds.includes(id));
  if (newlyAdded.length > 0) {
    const { rows: staffRows } = await pool.query(
      `SELECT s.id, s.name, s.active, s.client_limit,
         (SELECT COUNT(*) FROM company_staff cs WHERE cs.staff_id = s.id)::int AS assigned_count
       FROM staff s WHERE s.id = ANY($1)`,
      [newlyAdded]
    );
    for (const s of staffRows) {
      if (!s.active) return res.status(400).json({ error: `${s.name}'s access is currently suspended` });
      if (s.assigned_count >= s.client_limit) return res.status(400).json({ error: `${s.name} is at their client limit` });
    }
  }

  const { rows: companyRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [companyId]);
  if (!companyRows[0]) return res.status(404).json({ error: 'Company not found' });

  const requestedNames = await namesForIds(requestedStaffIds);

  // Admin/Owner assignments apply immediately — the approval step exists to
  // give the Owner sign-off over staff-initiated requests, not to make the
  // Owner approve their own actions.
  if (req.user.role === 'admin') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO assignment_requests (company_id, requested_by_user_id, current_staff_ids, requested_staff_ids, status, resolved_at, resolved_by_user_id)
         VALUES ($1,$2,$3,$4,'Approved',now(),$2) RETURNING id, created_at`,
        [companyId, req.user.sub, currentIds, requestedStaffIds]
      );
      await client.query('DELETE FROM company_staff WHERE company_id = $1', [companyId]);
      for (const staffId of requestedStaffIds) {
        await client.query('INSERT INTO company_staff (company_id, staff_id) VALUES ($1,$2)', [companyId, staffId]);
      }
      await client.query('COMMIT');
      await logActivity(req.user.sub, 'Updated assignment', companyRows[0].name, `Staff: ${requestedNames.join(', ')}`);
      return res.status(201).json({ id: rows[0].id, createdAt: rows[0].created_at, status: 'Approved' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO assignment_requests (company_id, requested_by_user_id, current_staff_ids, requested_staff_ids)
     VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [companyId, req.user.sub, currentIds, requestedStaffIds]
  );

  await logActivity(
    req.user.sub,
    'Requested assignment change',
    companyRows[0].name,
    `Requested staff: ${requestedNames.join(', ')} — awaiting admin approval`
  );

  res.status(201).json({ id: rows[0].id, createdAt: rows[0].created_at });
});

router.patch('/assignment-requests/:id', requireRole('admin'), async (req, res) => {
  const { status } = req.body || {};
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM assignment_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    const request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    if (request.status !== 'Pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already resolved — cannot be edited further' });
    }

    if (status === 'Approved') {
      await client.query('DELETE FROM company_staff WHERE company_id = $1', [request.company_id]);
      for (const staffId of request.requested_staff_ids) {
        await client.query('INSERT INTO company_staff (company_id, staff_id) VALUES ($1,$2)', [request.company_id, staffId]);
      }
    }

    await client.query(
      'UPDATE assignment_requests SET status = $1, resolved_at = now(), resolved_by_user_id = $2 WHERE id = $3',
      [status, req.user.sub, req.params.id]
    );

    const { rows: companyRows } = await client.query('SELECT name FROM companies WHERE id = $1', [request.company_id]);
    const requestedNames = await namesForIds(request.requested_staff_ids);
    await client.query(
      'INSERT INTO activity_log (actor_user_id, action, target, details) VALUES ($1,$2,$3,$4)',
      [
        req.user.sub,
        `${status} assignment`,
        companyRows[0].name,
        `Staff: ${requestedNames.join(', ')}` + (status === 'Approved' ? ' — locked, requester can no longer edit' : '')
      ]
    );

    await client.query('COMMIT');
    res.json({ ok: true, status });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
