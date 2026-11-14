-- Daily Sales Reconciliation (每日营业对账 → Bukku) of a restaurant company: the uploaded reports of each month (already read into daily figures), the
-- manager's check notes, the month closings, the Bukku settings and the change log are kept as small JSON documents per company (like Attendance).
-- The Owner switches it on per company in the Control Panel; page level = the Sales Summary level ("sales"): L2 uploads reports, L3 (manager) checks,
-- closes the month, changes the settings and exports the Bukku files.

CREATE TABLE sales_recon_docs (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                 -- src/2026-10_pos, adj/2026-10, closing/2026-10, settings/bukku, log/2026-11-14_5
  coll TEXT NOT NULL,                 -- the part before the first '/'
  data JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, path)
);
CREATE INDEX idx_sales_recon_docs_coll ON sales_recon_docs (company_id, coll);

CREATE TABLE sales_recon_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
