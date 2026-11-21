-- Phase 1 foundation (SPEC-system, section 3): company settings with effective dates, branches, account mappings, sources,
-- and one audit_log that can not be changed or deleted. Nothing existing is changed: these are new tables.

-- company_settings: every difference between companies is a row here (key, value, from which date). The newest row whose
-- effective_from is not after the date asked for is the one in force; the older rows stay as the history.
CREATE TABLE company_settings (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value          JSONB NOT NULL,
  effective_from DATE NOT NULL DEFAULT DATE '1970-01-01',
  note           TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, key, effective_from)
);
CREATE INDEX company_settings_lookup ON company_settings (company_id, key, effective_from DESC);

-- branches / outlets, one list for every module
CREATE TABLE branches (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  merchant_id TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

-- the original name (payment method, platform, expense ...) -> the Bukku account / contact code
CREATE TABLE account_mappings (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  source_name    TEXT NOT NULL,
  target_account TEXT,
  target_contact TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, source_name)
);

-- which data sources a company uses (pos / tng_mmsdo / grab / bank / manual ...)
CREATE TABLE sources (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  frequency   TEXT,
  owner_staff INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_type)
);

-- audit_log: who, when, which company, which module and record, what was done, before and after, why.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  who        TEXT NOT NULL,
  user_id    INTEGER,
  company_id INTEGER,
  module     TEXT NOT NULL,
  record     TEXT,
  action     TEXT NOT NULL,
  field      TEXT,
  before     TEXT,
  after      TEXT,
  reason     TEXT
);
CREATE INDEX audit_log_company ON audit_log (company_id, at DESC);
CREATE INDEX audit_log_module ON audit_log (module, at DESC);

-- no update, no delete, no truncate: a row stays as it was written
CREATE FUNCTION audit_log_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: rows can not be changed or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_readonly();

-- ---------------------------------------------------------------------------------------------------------------------
-- First rows: what index.html used to decide by company name, now as settings. The names are compared without dots,
-- commas, case and extra spaces, so "OWN LAUNDRY SDN. BHD." and "Own Laundry Sdn Bhd" are the same company.
-- sales_panel      which Sales page the company gets (own_laundry / didik_mulia / daily_sales)
-- merchant_report  which merchant report card (ol_tng)
-- eno_preselect    the Company E No. page starts on this company
-- short_name       the short name used in file names (seeded only where the page's own list matched, so no file name changes)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.norm_name(t TEXT) RETURNS TEXT AS $$
  SELECT btrim(regexp_replace(regexp_replace(upper(coalesce(t, '')), '[.,]', '', 'g'), '\s+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;

INSERT INTO company_settings (company_id, key, value, created_by, note)
SELECT c.id, s.key, to_jsonb(s.val), 'migration 057', 'moved out of index.html (company names in the page)'
FROM companies c
JOIN (VALUES
  ('OWN LAUNDRY SDN BHD',            'sales_panel',     'own_laundry'),
  ('OWN LAUNDRY SDN BHD',            'merchant_report', 'ol_tng'),
  ('DIDIK MULIA SDN BHD',            'sales_panel',     'didik_mulia'),
  ('MADAM LUA WANTONMEE',            'sales_panel',     'daily_sales'),
  ('UK LUA WANTONMEE ENTERPRISE',    'sales_panel',     'daily_sales'),
  ('UNCLE KOH NOODLE RESTAURANT',    'sales_panel',     'daily_sales')
) AS s(name, key, val) ON pg_temp.norm_name(c.name) = pg_temp.norm_name(s.name)
ON CONFLICT DO NOTHING;

-- short names: the same list the page had, matched the way the page matched it (case and spaces only, the dots stay),
-- so that no file name changes
CREATE FUNCTION pg_temp.norm_ws(t TEXT) RETURNS TEXT AS $$
  SELECT btrim(regexp_replace(upper(coalesce(t, '')), '\s+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;

INSERT INTO company_settings (company_id, key, value, created_by, note)
SELECT c.id, 'short_name', to_jsonb(s.val), 'migration 057', 'moved out of index.html (the master short-name list in the page)'
FROM companies c
JOIN (VALUES
  ('MINIFISH SDN BHD',                 'MF'),
  ('INVIRO CLEANING SDN BHD',          'INVIRO'),
  ('OWN LAUNDRY SDN BHD',              'OL'),
  ('OWN MARKET SDN BHD',               'OM'),
  ('DIDIK MULIA SDN BHD',              'DM'),
  ('WEALTHY CC HOUSE (M) SDN BHD',     'WCCHMSB'),
  ('SK AUTO DETAILING (M) SDN BHD',    'SKMSB'),
  ('SK AUTO DETAILING PERMAS SDN BHD', 'SKPSB')
) AS s(name, val) ON pg_temp.norm_ws(c.name) = pg_temp.norm_ws(s.name)
ON CONFLICT DO NOTHING;

-- the Company E No. page starts on the first company whose name begins with SK SPRAY PPF
INSERT INTO company_settings (company_id, key, value, created_by, note)
SELECT id, 'eno_preselect', 'true'::jsonb, 'migration 057', 'moved out of index.html (company names in the page)'
FROM companies WHERE pg_temp.norm_name(name) LIKE 'SK SPRAY PPF%' ORDER BY name LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 057', 'foundation', 'company_settings', 'create', 'phase 1: foundation tables and the first settings moved out of index.html');
