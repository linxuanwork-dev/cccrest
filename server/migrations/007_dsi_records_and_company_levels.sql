-- Company users get a level (staff / manager), and every branch+month of daily sales becomes a
-- "record" with a pending/checked status. A branch can only have ONE record per month.

ALTER TABLE users ADD COLUMN company_level TEXT NOT NULL DEFAULT 'staff' CHECK (company_level IN ('staff','manager'));

CREATE TABLE dsi_records (
  id SERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES dsi_branches(id) ON DELETE CASCADE,
  year INTEGER NOT NULL CHECK (year BETWEEN 2025 AND 2035),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','checked')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  saved_at TIMESTAMPTZ,
  checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  UNIQUE (branch_id, year, month)
);
CREATE INDEX idx_dsi_records_branch ON dsi_records(branch_id);

-- Anything already keyed in (the sheet used to autosave) becomes a pending record so nothing is lost.
INSERT INTO dsi_records (branch_id, year, month, saved_at)
SELECT DISTINCT i.branch_id, EXTRACT(YEAR FROM d.entry_date)::int, EXTRACT(MONTH FROM d.entry_date)::int, now()
FROM (
  SELECT item_id, entry_date FROM dsi_quantities
  UNION
  SELECT item_id, entry_date FROM dsi_specials
) d
JOIN dsi_menu_items i ON i.id = d.item_id
WHERE EXTRACT(YEAR FROM d.entry_date) BETWEEN 2025 AND 2035
ON CONFLICT (branch_id, year, month) DO NOTHING;
