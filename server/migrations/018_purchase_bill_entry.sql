-- Bukku Purchase Bill entry (quick grid / multi-line form / bill list with duplicate checks / Bukku export), per company.
-- Replaces the simplified "entries" table of migration 017 (it never held real data).

DROP TABLE IF EXISTS purchase_bukku_entries;

-- The company's supplier list (Bukku Legal Name + Contact Code + default account + default tags)
ALTER TABLE purchase_bukku_contacts ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE purchase_bukku_contacts ADD COLUMN tags TEXT NOT NULL DEFAULT '';

CREATE TABLE purchase_bukku_bills (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  no TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  bill_date DATE,
  tags TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  lines JSONB NOT NULL,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported')),
  dup_ack BOOLEAN NOT NULL DEFAULT false,
  imported BOOLEAN NOT NULL DEFAULT false,
  exported_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_purchase_bukku_bills_company ON purchase_bukku_bills (company_id, bill_date);
