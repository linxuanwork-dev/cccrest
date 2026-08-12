CREATE TABLE dm_customer_lookup (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch TEXT NOT NULL CHECK (branch IN ('TDA','TST','BBU')),
  name TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dm_lookup_company_branch ON dm_customer_lookup(company_id, branch);
