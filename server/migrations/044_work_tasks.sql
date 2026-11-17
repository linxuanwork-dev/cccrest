-- Work list (Workflow): tasks for the CC CREST team (staff / managers), ticked off by the person, checked by the Owner,
-- and monthly bills (rent, utilities, instalments...) that make a "collect the bill" and a "pay the bill" task every month.
CREATE TABLE IF NOT EXISTS work_recurring (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  note                 TEXT,
  due_day              SMALLINT NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  needs_collect        BOOLEAN NOT NULL DEFAULT true,
  collect_days_before  SMALLINT NOT NULL DEFAULT 5 CHECK (collect_days_before BETWEEN 0 AND 28),
  collect_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pay_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_tasks (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  note              TEXT,
  kind              TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'collect', 'pay')),
  assignee_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date          DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done', 'checked')),
  done_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_at           TIMESTAMPTZ,
  checked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at        TIMESTAMPTZ,
  recurring_id      INTEGER REFERENCES work_recurring(id) ON DELETE SET NULL,
  period            TEXT,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_tasks_recurring ON work_tasks (recurring_id, period, kind) WHERE recurring_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_tasks_assignee ON work_tasks (assignee_user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_work_tasks_due ON work_tasks (due_date);
