-- Bukku API connection per company (Owner sets it in the Control Panel) and the company's Bukku chart of accounts.
-- The access token is stored encrypted (AES-256-GCM) and is never sent back to the browser.
CREATE TABLE IF NOT EXISTS bukku_connections (
  company_id    INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  subdomain     TEXT NOT NULL,
  token_enc     TEXT NOT NULL,
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  updated_by    INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bukku_accounts (
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bukku_id    BIGINT  NOT NULL,
  code        TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL DEFAULT '',
  type        TEXT,
  parent_id   BIGINT,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, bukku_id)
);
CREATE INDEX IF NOT EXISTS idx_bukku_accounts_company ON bukku_accounts (company_id, code);
