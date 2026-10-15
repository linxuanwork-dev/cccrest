-- History for Sales Summary: per record (created, saved with old -> new values, approved, unlocked) plus the
-- branch-wide menu / settings changes that apply to every month. Rows keep the user's name as it was at the time.

CREATE TABLE dsi_history (
  id SERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES dsi_branches(id) ON DELETE CASCADE,
  record_id INTEGER REFERENCES dsi_records(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('record','menu','settings')),
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dsi_history_record ON dsi_history(record_id, created_at DESC);
CREATE INDEX idx_dsi_history_branch ON dsi_history(branch_id, created_at DESC);

-- Records that already exist get a "Created" entry so their history isn't empty.
INSERT INTO dsi_history (branch_id, record_id, channel, action, user_id, user_name, created_at)
SELECT r.branch_id, r.id, 'record', 'created', r.created_by, COALESCE(u.display_name, 'System'), r.created_at
FROM dsi_records r
LEFT JOIN users u ON u.id = r.created_by;
