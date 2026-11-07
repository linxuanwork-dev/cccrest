-- Tuition fee reconciliation & MT Allowance (学费对账 & Allowance) for a tuition centre company: students, packages, monthly teacher rosters,
-- bank statements and their matching are kept as small JSON documents per company (like Stock Count). The Owner switches it on per
-- company in the Control Panel; only CC CREST people (admin / manager / assigned staff with the "Tuition & Allowance" level) can use it.

CREATE TABLE tuition_docs (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                 -- students/BBU, settings/packages, rosters/BBU_2026-10, bank/AFFIN_2026-10 ...
  coll TEXT NOT NULL,                 -- the part before the first '/'
  data JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, path)
);
CREATE INDEX idx_tuition_docs_coll ON tuition_docs (company_id, coll);

CREATE TABLE tuition_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rev INTEGER NOT NULL DEFAULT 0,     -- goes up with every write, so the page can ask "anything new?" cheaply
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tuition_settings (company_id, enabled, rev)
SELECT id, true, 1 FROM companies WHERE name ILIKE 'DIDIK MULIA%'
ON CONFLICT (company_id) DO NOTHING;
