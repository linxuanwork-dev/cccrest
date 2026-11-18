-- 个人所得税 Form B / BE (Owner only): small JSON documents like the other pages: taxrules/<YA> (tax rules of a year), taxclients/<id> (client + assets),
-- taxreturns/<client id>_<YA> (the return). The tax rules of YA2025 / YA2026 are put in from server/assets/taxb/rules the first time the page is opened.
CREATE TABLE tax_docs (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (coll, id)
);
