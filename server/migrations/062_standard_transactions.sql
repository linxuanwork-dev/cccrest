-- Phase 2: the standard transaction core (SPEC-system sections 3 and 4): transactions, matches, exceptions, approvals (+ imports, counters).
-- Every company, every module uses these tables; the differences are only in how things are imported and which accounts are used.
-- The first source connected is the Purchases Bill page (run beside the old flow; the old tables are not changed).

-- every file or batch that was read in
CREATE TABLE imports (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  module      TEXT NOT NULL,
  month       TEXT,
  file_name   TEXT,
  row_count   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'done',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the standard transaction. Two numbers: internal_no (given at import, for tracking: SK-2026-11-0035) and bukku_no (given when approved).
CREATE TABLE transactions (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id      INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  tx_date        DATE,
  type           TEXT NOT NULL CHECK (type IN ('sales', 'receipt', 'purchase', 'fee', 'bank')),
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax            NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method TEXT,
  counterparty   TEXT,
  source_ref     TEXT,
  import_id      INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  internal_no    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'imported'
                 CHECK (status IN ('imported', 'matched', 'pending', 'missing_doc', 'classified', 'in_review', 'approved', 'exported')),
  account        TEXT,
  contact_code   TEXT,
  bukku_no       TEXT,
  lines          JSONB NOT NULL DEFAULT '[]'::jsonb,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  origin         TEXT,
  submitted_by   TEXT,
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  exported_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, internal_no)
);
CREATE UNIQUE INDEX transactions_origin ON transactions (company_id, origin) WHERE origin IS NOT NULL;
CREATE INDEX transactions_company_status ON transactions (company_id, status, tx_date);

-- running counter of the internal numbers (per company and month)
CREATE TABLE tx_counters (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, key)
);

-- bank <-> sales / purchase
CREATE TABLE matches (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_tx_id    INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  other_tx_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('auto', 'manual')),
  diff          NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the list a person looks at: what the system found that is not right. Only a person closes one, and has to write a note.
CREATE TABLE exceptions (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  detail         TEXT,
  assignee_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved       BOOLEAN NOT NULL DEFAULT false,
  resolved_by    TEXT,
  resolved_at    TIMESTAMPTZ,
  resolve_note   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exceptions_one_open ON exceptions (transaction_id, type) WHERE NOT resolved;
CREATE INDEX exceptions_company_open ON exceptions (company_id, resolved);

-- the approvals: who approved which batch, the file that was made, and whether it was opened again
CREATE TABLE approvals (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month         TEXT,
  module        TEXT NOT NULL,
  tx_ids        INTEGER[] NOT NULL DEFAULT '{}',
  approved_by   TEXT NOT NULL,
  user_id       INTEGER,
  approved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  export_file   TEXT,
  exported_at   TIMESTAMPTZ,
  reopened      BOOLEAN NOT NULL DEFAULT false,
  reopened_by   TEXT,
  reopened_at   TIMESTAMPTZ,
  reopen_reason TEXT
);

SELECT enable_company_rls('imports');
SELECT enable_company_rls('transactions');
SELECT enable_company_rls('tx_counters');
SELECT enable_company_rls('matches');
SELECT enable_company_rls('exceptions');
SELECT enable_company_rls('approvals');

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 062', 'foundation', 'transactions', 'create', 'phase 2: standard transaction core (transactions, matches, exceptions, approvals)');
