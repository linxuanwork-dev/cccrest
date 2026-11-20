-- 个人所得税: every new / changed / approved / reopened / filed / deleted document is written here (who, when, what changed, why). Nobody can switch it off or delete it.
CREATE TABLE tax_audit (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL DEFAULT '',
  coll TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- create | update | delete | approve | reopen | file
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ path, before, after }]
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_tax_audit_doc ON tax_audit (coll, doc_id, at DESC);
