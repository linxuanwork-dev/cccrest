-- MT Claim form (DIDIK MULIA): every MT (teacher) has a login of their own and fills the monthly claim form (students, package, class dates,
-- fee done / not yet, fast-track products). The forms themselves are kept as 'claims/...' documents in tuition_docs; this table holds the logins.
CREATE TABLE tuition_mt_users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  mt TEXT NOT NULL,                       -- the MT name as in the MT list, e.g. MT NABILA
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, branch, mt)
);
CREATE UNIQUE INDEX uq_tuition_mt_username ON tuition_mt_users (lower(username));
