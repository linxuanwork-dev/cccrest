-- HR > Attendance (考勤): the staff roster, the daily clock entries, the manager approvals, advances and pay adjustments of a company
-- are kept as small JSON documents per company (like Tuition & Allowance and Stock Count). The Owner switches it on per company
-- in the Control Panel. Page level = the HR level ("payroll"): L2 enters the clock times, L3 (manager) approves, edits the roster and pay.

CREATE TABLE attendance_docs (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                 -- roster/YE_TUN, settings/lists, entries/YE_TUN_2026-11-03, approvals/..., advances/..., payadj/...
  coll TEXT NOT NULL,                 -- the part before the first '/'
  data JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, path)
);
CREATE INDEX idx_attendance_docs_coll ON attendance_docs (company_id, coll);

CREATE TABLE attendance_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
