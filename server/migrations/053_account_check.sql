-- 账目检查 (account check, Owner only): the books of a company are read from Bukku for a period, written into the review prompt and sent to Claude;
-- the answer (issues) is kept per run, with what the Owner decided for each issue. Nothing is written to Bukku.

CREATE TABLE ac_config (
  key TEXT PRIMARY KEY,                 -- api_key_enc (encrypted), model, prompt (empty = the built-in prompt)
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ac_clients (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  sst_registered BOOLEAN NOT NULL DEFAULT false,
  sst_rate NUMERIC NOT NULL DEFAULT 0,
  fy_end TEXT NOT NULL DEFAULT '',
  nature TEXT NOT NULL DEFAULT '',
  materiality NUMERIC NOT NULL DEFAULT 0,
  tolerance NUMERIC NOT NULL DEFAULT 0.05,
  staff TEXT NOT NULL DEFAULT '',
  prepayments TEXT NOT NULL DEFAULT '',   -- one item per line: item | total | months | start month | account
  accruals TEXT NOT NULL DEFAULT '',      -- one item per line
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ac_whitelist (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ac_whitelist_company ON ac_whitelist (company_id);

CREATE TABLE ac_runs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  mode TEXT NOT NULL DEFAULT 'first',     -- first | recheck
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | fetching | analysing | done | failed
  progress TEXT NOT NULL DEFAULT '',
  staff TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prev_run_id INTEGER REFERENCES ac_runs(id) ON DELETE SET NULL,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,       -- what was read (counts), notes
  result JSONB,                                    -- the JSON answer
  decisions JSONB NOT NULL DEFAULT '{}'::jsonb,    -- { "<issue id>": { decision, note, at } }
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_ac_runs_company ON ac_runs (company_id, created_at DESC);
