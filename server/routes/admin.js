const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();

// One-time maintenance route: wipes all seeded/demo data and leaves a single
// fresh admin01 login so the owner can start entering real data. Removed
// from the codebase again right after use.
router.post('/admin/reset-data', requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = [
      'reconciliation_line_items', 'reconciliation_batches', 'merchant_settlements',
      'petty_cash_entries', 'claim_bills', 'purchase_bills', 'bank_statement_entries',
      'sales_records', 'activity_log', 'assignment_requests', 'job_reminders',
      'manager_staff', 'company_staff', 'users', 'staff', 'companies'
    ];
    for (const t of tables) {
      await client.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
    }
    const hash = await bcrypt.hash('admin123', 10);
    await client.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, active)
       VALUES ('admin01', $1, 'admin', 'Siti Aminah', true)`,
      [hash]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
