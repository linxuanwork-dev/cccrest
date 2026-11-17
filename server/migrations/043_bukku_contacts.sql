-- Copy of the company's Bukku contacts (read through the Bukku API; nothing is written to Bukku).
CREATE TABLE IF NOT EXISTS bukku_contacts (
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bukku_key     TEXT    NOT NULL,
  legal_name    TEXT    NOT NULL DEFAULT '',
  other_name    TEXT,
  contact_code  TEXT    NOT NULL DEFAULT '',
  reg_no        TEXT,
  types         TEXT[]  NOT NULL DEFAULT '{}',
  email         TEXT,
  phone_no      TEXT,
  is_archived   BOOLEAN NOT NULL DEFAULT false,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, bukku_key)
);
CREATE INDEX IF NOT EXISTS idx_bukku_contacts_company ON bukku_contacts (company_id, legal_name);
