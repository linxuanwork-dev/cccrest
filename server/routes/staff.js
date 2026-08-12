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

// Unified account creation — Owner picks the role (staff/manager/admin) instead
// of using separate endpoints per role. Staff also get a `staff` business
// record (assignable to companies, has a client limit); manager/admin are
// plain login-only accounts.
router.post('/users', requireRole('admin'), async (req, res) => {
  const { role, name, loginId, password, clientLimit } = req.body || {};
  if (!role || !name || !loginId || !password) {
    return res.status(400).json({ error: 'role, name, loginId, and password are required' });
  }
  if (!['staff', 'manager', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be staff, manager, or admin' });
  }

  const trimmedName = name.trim();
  const trimmedLoginId = loginId.trim().toLowerCase();
  const hash = await bcrypt.hash(password, 10);

  if (role === 'staff') {
    const limit = Number.isFinite(Number(clientLimit)) && Number(clientLimit) > 0 ? Number(clientLimit) : 20;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: staffRows } = await client.query(
        'INSERT INTO staff (name, client_limit, active) VALUES ($1,$2,true) RETURNING *',
        [trimmedName, limit]
      );
      await client.query(
        `INSERT INTO users (login_id, password_hash, role, display_name, staff_id, active)
         VALUES ($1,$2,'staff',$3,$4,true)`,
        [trimmedLoginId, hash, trimmedName, staffRows[0].id]
      );
      await client.query('COMMIT');
      await logActivity(req.user.sub, 'Created staff account', trimmedName, 'Login ID: ' + trimmedLoginId);
      return res.status(201).json(staffRows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(400).json({ error: 'That staff name or login ID is already taken' });
      throw err;
    } finally {
      client.release();
    }
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, active)
       VALUES ($1,$2,$3,$4,true) RETURNING id, login_id, display_name, role, active`,
      [trimmedLoginId, hash, role, trimmedName]
    );
    await logActivity(req.user.sub, 'Created ' + role + ' account', trimmedName, 'Login ID: ' + trimmedLoginId);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'That login ID is already taken' });
    throw err;
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

// ============ STAFF COMPANY ASSIGNMENT (Owner only — staff-centric view) ============
// Complements the per-company "Assign" flow in Customer Queue by letting the
// Owner manage one staff member's full company list in one place.

router.get('/staff/:id/companies', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name FROM company_staff cs JOIN companies c ON c.id = cs.company_id
     WHERE cs.staff_id = $1 ORDER BY c.name`,
    [req.params.id]
  );
  res.json(rows);
});

router.put('/staff/:id/companies', requireRole('admin'), async (req, res) => {
  const { companyIds } = req.body || {};
  if (!Array.isArray(companyIds)) return res.status(400).json({ error: 'companyIds must be an array' });
  const staffId = Number(req.params.id);

  const { rows: staffRows } = await pool.query('SELECT * FROM staff WHERE id = $1', [staffId]);
  if (!staffRows[0]) return res.status(404).json({ error: 'Staff not found' });
  if (companyIds.length > staffRows[0].client_limit) {
    return res.status(400).json({ error: `Exceeds this staff member's client limit (${staffRows[0].client_limit})` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: currentRows } = await client.query('SELECT company_id FROM company_staff WHERE staff_id = $1', [staffId]);
    const currentIds = currentRows.map((r) => r.company_id);
    const toAdd = companyIds.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !companyIds.includes(id));

    if (toAdd.length) {
      const { rows: capRows } = await client.query(
        `SELECT company_id, COUNT(*)::int AS cnt FROM company_staff WHERE company_id = ANY($1) GROUP BY company_id`,
        [toAdd]
      );
      const capByCompany = new Map(capRows.map((r) => [r.company_id, r.cnt]));
      for (const cid of toAdd) {
        if ((capByCompany.get(cid) || 0) >= 2) {
          await client.query('ROLLBACK');
          const { rows: nameRows } = await pool.query('SELECT name FROM companies WHERE id = $1', [cid]);
          return res.status(400).json({ error: `${nameRows[0] ? nameRows[0].name : 'That company'} already has 2 staff assigned` });
        }
      }
    }

    for (const cid of toRemove) {
      await client.query('DELETE FROM company_staff WHERE staff_id = $1 AND company_id = $2', [staffId, cid]);
    }
    for (const cid of toAdd) {
      await client.query('INSERT INTO company_staff (company_id, staff_id) VALUES ($1,$2)', [cid, staffId]);
    }
    await client.query('COMMIT');

    const { rows: companyNameRows } = await pool.query('SELECT name FROM companies WHERE id = ANY($1)', [companyIds]);
    await logActivity(
      req.user.sub,
      'Updated staff assignment',
      staffRows[0].name,
      'Companies: ' + (companyNameRows.length ? companyNameRows.map((r) => r.name).join(', ') : 'none')
    );
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
