-- Purchases -> Bukku: the bills staff key in are kept in the system (month filter, edit / delete, export of ticked bills).
CREATE TABLE purchase_bukku_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('bill', 'claim')),
  contact_code TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  employee_code TEXT,
  employee_name TEXT,
  bill_no TEXT NOT NULL,
  bill_date DATE NOT NULL,
  lines JSONB NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, entry_type, contact_code, bill_no)
);
CREATE INDEX idx_purchase_bukku_entries_date ON purchase_bukku_entries (company_id, bill_date);
