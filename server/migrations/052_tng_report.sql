-- TNG / DuitNow QR Daily Settlement Report: the Owner switches it on per company (Control Panel); the original MMSDO monthly reports are kept
-- (uploaded by hand or by the folder watcher), one report per outlet is made from them (PDF + Excel), with the outlet settings and the
-- Prepared / Checked / Approved names kept for re-making the PDF.

CREATE TABLE tng_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "branch settings": how an outlet name in the TNG file is shown on the report
CREATE TABLE tng_outlets (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  outlet_key TEXT NOT NULL,            -- the Shop/Outlet Name (+ Location) in the file, trimmed and lower case
  original_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  short_code TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  reg_no TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, outlet_key)
);

CREATE TABLE tng_files (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  data BYTEA NOT NULL,
  report_ref TEXT NOT NULL DEFAULT '',   -- Report Reference in the file
  period TEXT NOT NULL DEFAULT '',       -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'new',    -- new (came from the folder, not looked at yet) | done
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,   -- [{ key, name, count, net }] per outlet, the file total
  sign JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { <outlet key>: { preparedBy, preparedDate, checkedBy, checkedDate, approvedBy, approvedDate } }
  uploaded_via INTEGER REFERENCES inbox_tokens(id) ON DELETE SET NULL,   -- the folder watcher token
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_at TIMESTAMPTZ
);
CREATE INDEX idx_tng_files_company ON tng_files (company_id, period DESC, created_at DESC);
CREATE INDEX idx_tng_files_ref ON tng_files (company_id, report_ref);
