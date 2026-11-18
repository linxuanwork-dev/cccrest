-- Inbox: files a small program on the office computer picks up from a watched folder and uploads (a token per company / computer),
-- to be read and checked in the Purchases Bill page.
CREATE TABLE IF NOT EXISTS inbox_tokens (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS inbox_files (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  data          BYTEA NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'purchase',
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done', 'dismissed')),
  bill_no       TEXT,
  uploaded_via  INTEGER REFERENCES inbox_tokens(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at    TIMESTAMPTZ,
  UNIQUE (company_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_inbox_files_company ON inbox_files (company_id, status, created_at);
