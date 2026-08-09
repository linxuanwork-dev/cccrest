-- Core access-control entities

CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  short_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  client_limit INTEGER NOT NULL DEFAULT 20,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE company_staff (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, staff_id)
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','client')),
  display_name TEXT NOT NULL,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assignment_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  current_staff_ids INTEGER[] NOT NULL DEFAULT '{}',
  requested_staff_ids INTEGER[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE activity_log (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactional / reporting entities (one per mock generator in the old index.html)

CREATE TABLE sales_records (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  invoice_no TEXT NOT NULL,
  gross NUMERIC(12,2) NOT NULL,
  settled NUMERIC(12,2) NOT NULL,
  petty_out NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('Synced','Pending'))
);

CREATE TABLE bank_statement_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  description TEXT NOT NULL,
  debit NUMERIC(12,2),
  credit NUMERIC(12,2),
  balance NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Matched','Unmatched'))
);

CREATE TABLE purchase_bills (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  supplier TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Paid','Unpaid'))
);

CREATE TABLE claim_bills (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  claim_no TEXT NOT NULL,
  staff_id INTEGER REFERENCES staff(id),
  category TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Approved','Pending'))
);

CREATE TABLE petty_cash_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  description TEXT NOT NULL,
  amount_in NUMERIC(12,2),
  amount_out NUMERIC(12,2),
  balance NUMERIC(12,2) NOT NULL
);

CREATE TABLE merchant_settlements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  txns INTEGER NOT NULL,
  approved_amt NUMERIC(12,2) NOT NULL,
  failed_amt NUMERIC(12,2) NOT NULL,
  fee NUMERIC(12,2) NOT NULL,
  net NUMERIC(12,2) NOT NULL
);

CREATE TABLE reconciliation_batches (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month TEXT NOT NULL,
  invoices_count INTEGER NOT NULL DEFAULT 0,
  exceptions_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('Needs Review','In Progress','Not Started','Completed')),
  bank_verified TEXT,
  output_summary_ready BOOLEAN NOT NULL DEFAULT false,
  output_sales_ready BOOLEAN NOT NULL DEFAULT false,
  output_payment_ready BOOLEAN NOT NULL DEFAULT false,
  output_carryover_ready BOOLEAN NOT NULL DEFAULT false,
  output_flags_ready BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_month)
);

CREATE TABLE reconciliation_line_items (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES reconciliation_batches(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  invoice_no TEXT NOT NULL,
  bill_amt NUMERIC(12,2) NOT NULL,
  txn_fee NUMERIC(12,2) NOT NULL,
  failed_cancelled NUMERIC(12,2) NOT NULL DEFAULT 0,
  actual_amt NUMERIC(12,2) NOT NULL,
  settlement NUMERIC(12,2) NOT NULL,
  receipt_no TEXT,
  status TEXT NOT NULL CHECK (status IN ('Matched','Needs Review'))
);

CREATE INDEX idx_sales_company ON sales_records(company_id);
CREATE INDEX idx_bank_company ON bank_statement_entries(company_id);
CREATE INDEX idx_purchases_company ON purchase_bills(company_id);
CREATE INDEX idx_claims_company ON claim_bills(company_id);
CREATE INDEX idx_petty_company ON petty_cash_entries(company_id);
CREATE INDEX idx_merchant_company ON merchant_settlements(company_id);
CREATE INDEX idx_recon_batches_company ON reconciliation_batches(company_id);
CREATE INDEX idx_recon_lines_batch ON reconciliation_line_items(batch_id);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX idx_assignment_requests_company ON assignment_requests(company_id);
CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_users_staff ON users(staff_id);
