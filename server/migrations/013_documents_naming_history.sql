-- File naming (set in the Control Panel per feature, with a per-company prefix on the profile), numbering,
-- and a history of every document: when it was made, when it was changed and what changed.

ALTER TABLE companies ADD COLUMN file_prefix TEXT;
ALTER TABLE companies ADD COLUMN sst_no TEXT;

-- One naming pattern per feature, e.g. "{PREFIX}-EL-{YYYY}-{SEQ:3}". A feature with no row keeps its built-in name.
CREATE TABLE doc_settings (
  feature_key TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Running numbers per company and feature; "scope" is the year (or month) the pattern restarts in.
CREATE TABLE doc_sequences (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, feature_key, scope)
);

-- Every document event: generated / downloaded / created / updated (with what changed). User names are kept as they were.
CREATE TABLE document_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  doc_ref TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL CHECK (event IN ('generated','downloaded','created','updated','deleted')),
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_document_events_company ON document_events(company_id, created_at DESC);
