const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const {
  slugify,
  invoicePrefix,
  genSales,
  genBank,
  genPurchases,
  genClaim,
  genPetty,
  genMerchant,
  genReconLines
} = require('./lib/mockGen');

const STAFF_ROSTER = ['Nurul Huda', 'Chen Wei Ming', 'Ahmad Faiz', 'Priya Suresh'];

const COMPANY_SHORT_NAMES = {
  'MINIFISH SDN BHD': 'MF',
  'INVIRO CLEANING SDN BHD': 'INVIRO',
  'OWN LAUNDRY SDN BHD': 'OL',
  'OWN MARKET SDN BHD': 'OM',
  'DIDIK MULIA SDN BHD': 'DM',
  'WEALTHY CC HOUSE (M) SDN  BHD': 'WCCHMSB',
  'SK AUTO DETAILING (M) SDN BHD': 'SKMSB',
  'SK AUTO DETAILING PERMAS SDN BHD': 'SKPSB'
};

const SEED_ASSIGNMENT_REQUESTS = [
  { company: 'TD - Senai', currentStaff: ['Nurul Huda'], requestedStaff: ['Nurul Huda', 'Chen Wei Ming'], status: 'Pending' },
  { company: 'Restoran Senai', currentStaff: ['Priya Suresh'], requestedStaff: ['Ahmad Faiz'], status: 'Pending' },
  { company: 'Kulai Hardware Sdn Bhd', currentStaff: ['Chen Wei Ming'], requestedStaff: ['Chen Wei Ming', 'Ahmad Faiz'], status: 'Rejected' }
];

const SEED_MANAGERS = [
  { loginId: 'aisha-rahman', displayName: 'Aisha Rahman', team: ['Nurul Huda', 'Chen Wei Ming'] },
  { loginId: 'farid-hassan', displayName: 'Farid Hassan', team: ['Ahmad Faiz', 'Priya Suresh'] }
];

const DEMO_PASSWORD = { admin: 'admin123', manager: 'manager123', staff: 'staff123', client: 'client123' };

function shortNameFor(name) {
  return COMPANY_SHORT_NAMES[name] || invoicePrefix(name);
}

async function clearAll(client) {
  const tables = [
    'reconciliation_line_items',
    'reconciliation_batches',
    'merchant_settlements',
    'petty_cash_entries',
    'claim_bills',
    'purchase_bills',
    'bank_statement_entries',
    'sales_records',
    'activity_log',
    'assignment_requests',
    'company_staff',
    'users',
    'staff',
    'companies'
  ];
  for (const t of tables) {
    await client.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
  }
}

async function seed() {
  const customers = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data/customers.json'), 'utf8'));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await clearAll(client);

    // ---- staff ----
    const staffIdByName = {};
    for (const name of STAFF_ROSTER) {
      const { rows } = await client.query(
        'INSERT INTO staff (name, client_limit, active) VALUES ($1, 20, true) RETURNING id',
        [name]
      );
      staffIdByName[name] = rows[0].id;
    }

    // ---- companies + company_staff ----
    const companyIdByName = {};
    for (const c of customers) {
      const slug = slugify(c.name);
      const { rows } = await client.query(
        'INSERT INTO companies (name, slug, type, short_name) VALUES ($1, $2, $3, $4) RETURNING id',
        [c.name, slug, c.type, shortNameFor(c.name)]
      );
      companyIdByName[c.name] = rows[0].id;
      for (const staffName of c.staff) {
        await client.query('INSERT INTO company_staff (company_id, staff_id) VALUES ($1, $2)', [
          rows[0].id,
          staffIdByName[staffName]
        ]);
      }
    }

    // ---- users: 1 admin, 1 per staff, 1 per company (client) ----
    const adminHash = await bcrypt.hash(DEMO_PASSWORD.admin, 10);
    const { rows: adminRows } = await client.query(
      `INSERT INTO users (login_id, password_hash, role, display_name, active)
       VALUES ('admin01', $1, 'admin', 'Siti Aminah', true) RETURNING id`,
      [adminHash]
    );
    const adminUserId = adminRows[0].id;

    const staffHash = await bcrypt.hash(DEMO_PASSWORD.staff, 10);
    for (const name of STAFF_ROSTER) {
      await client.query(
        `INSERT INTO users (login_id, password_hash, role, display_name, staff_id, active)
         VALUES ($1, $2, 'staff', $3, $4, true)`,
        [slugify(name), staffHash, name, staffIdByName[name]]
      );
    }

    const managerHash = await bcrypt.hash(DEMO_PASSWORD.manager, 10);
    for (const m of SEED_MANAGERS) {
      const { rows: mgrRows } = await client.query(
        `INSERT INTO users (login_id, password_hash, role, display_name, active)
         VALUES ($1, $2, 'manager', $3, true) RETURNING id`,
        [m.loginId, managerHash, m.displayName]
      );
      for (const staffName of m.team) {
        await client.query('INSERT INTO manager_staff (manager_user_id, staff_id) VALUES ($1,$2)', [mgrRows[0].id, staffIdByName[staffName]]);
      }
    }

    const clientHash = await bcrypt.hash(DEMO_PASSWORD.client, 10);
    for (const c of customers) {
      await client.query(
        `INSERT INTO users (login_id, password_hash, role, display_name, company_id, active)
         VALUES ($1, $2, 'client', $3, $4, true)`,
        [slugify(c.name), clientHash, c.name, companyIdByName[c.name]]
      );
    }

    // ---- assignment_requests (seed history) ----
    for (const r of SEED_ASSIGNMENT_REQUESTS) {
      const currentIds = r.currentStaff.map((n) => staffIdByName[n]);
      const requestedIds = r.requestedStaff.map((n) => staffIdByName[n]);
      await client.query(
        `INSERT INTO assignment_requests
           (company_id, requested_by_user_id, current_staff_ids, requested_staff_ids, status, resolved_at, resolved_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          companyIdByName[r.company],
          adminUserId,
          currentIds,
          requestedIds,
          r.status,
          r.status === 'Pending' ? null : new Date(),
          r.status === 'Pending' ? null : adminUserId
        ]
      );
    }

    // ---- activity_log (seed history) ----
    await client.query(
      `INSERT INTO activity_log (actor_user_id, action, target, details, created_at)
       VALUES ($1, 'Rejected assignment', 'Kulai Hardware Sdn Bhd', 'Requested staff: Chen Wei Ming, Ahmad Faiz', now() - interval '6 days')`,
      [adminUserId]
    );
    await client.query(
      `INSERT INTO activity_log (actor_user_id, action, target, details, created_at)
       VALUES ($1, 'Set client limit', 'Ahmad Faiz', 'limit set to 20', now() - interval '8 days')`,
      [adminUserId]
    );

    // ---- transactional data + reconciliation per company ----
    for (const c of customers) {
      const companyId = companyIdByName[c.name];

      for (const row of genSales(c.name)) {
        await client.query(
          `INSERT INTO sales_records (company_id, date, invoice_no, gross, settled, petty_out, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [companyId, row.date, row.invoice, row.gross, row.settled, row.pettyOut, row.status]
        );
      }

      for (const row of genBank(c.name)) {
        await client.query(
          `INSERT INTO bank_statement_entries (company_id, date, description, debit, credit, balance, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [companyId, row.date, row.description, row.debit, row.credit, row.balance, row.status]
        );
      }

      for (const row of genPurchases(c.name)) {
        await client.query(
          `INSERT INTO purchase_bills (company_id, invoice_no, supplier, amount, date, status)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [companyId, row.invoiceNo, row.supplier, row.amount, row.date, row.status]
        );
      }

      for (const row of genClaim(c.name, c.staff)) {
        await client.query(
          `INSERT INTO claim_bills (company_id, claim_no, staff_id, category, amount, date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [companyId, row.claimNo, row.staffName ? staffIdByName[row.staffName] : null, row.category, row.amount, row.date, row.status]
        );
      }

      for (const row of genPetty(c.name)) {
        await client.query(
          `INSERT INTO petty_cash_entries (company_id, date, description, amount_in, amount_out, balance)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [companyId, row.date, row.description, row.amountIn, row.amountOut, row.balance]
        );
      }

      for (const row of genMerchant(c.name)) {
        await client.query(
          `INSERT INTO merchant_settlements (company_id, date, txns, approved_amt, failed_amt, fee, net)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [companyId, row.date, row.txns, row.approved, row.failed, row.fee, row.net]
        );
      }

      const needsReview = c.status === 'Needs Review';
      const outputsReady = c.outReady || 0;
      const { rows: batchRows } = await client.query(
        `INSERT INTO reconciliation_batches
           (company_id, period_month, invoices_count, exceptions_count, status, input_file_name,
            output_summary_ready, output_sales_ready, output_payment_ready, output_carryover_ready, output_flags_ready)
         VALUES ($1,'2026-08',$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [
          companyId,
          5,
          needsReview ? 1 : 0,
          c.status,
          c.input || null,
          outputsReady >= 1,
          outputsReady >= 2,
          outputsReady >= 3,
          c.status === 'Completed'
        ]
      );
      const batchId = batchRows[0].id;

      for (const line of genReconLines(c.name, needsReview)) {
        await client.query(
          `INSERT INTO reconciliation_line_items
             (batch_id, date, invoice_no, bill_amt, txn_fee, failed_cancelled, actual_amt, settlement, receipt_no, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [batchId, line.date, line.invoiceNo, line.billAmt, line.txnFee, line.failedCancelled, line.actualAmt, line.settlement, line.receiptNo, line.status]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`Seeded ${customers.length} companies, ${STAFF_ROSTER.length} staff, ${customers.length + STAFF_ROSTER.length + 1} users.`);
    console.log('Demo passwords:', DEMO_PASSWORD);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

module.exports = { seed };
