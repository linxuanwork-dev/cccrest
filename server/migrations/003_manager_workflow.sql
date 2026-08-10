ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','manager','staff','client'));

CREATE TABLE manager_staff (
  manager_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (manager_user_id, staff_id)
);

CREATE TABLE job_reminders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  sent_by_user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX idx_job_reminders_staff ON job_reminders(staff_id);
CREATE INDEX idx_job_reminders_company ON job_reminders(company_id);

ALTER TABLE companies ADD COLUMN enabled_features TEXT[] NOT NULL DEFAULT ARRAY[
  'panel-company-home','panel-sales','panel-bank','panel-purchases','panel-claim','panel-petty','panel-merchant'
];
