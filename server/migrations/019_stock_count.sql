-- Stock count (库存盘点): item master, monthly counts, month closing and change log, per company.
-- The page (server/assets/stockcount/app.html) keeps its data as small documents (groups/, items/, counts/, closing/,
-- settings/, log/), so they are stored the same way: one JSONB document per path.
-- The Owner switches the feature on per company in the Control Panel; it starts with MINIFISH SDN BHD.

CREATE TABLE stock_count_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rev BIGINT NOT NULL DEFAULT 0,                    -- goes up on every change, so open pages can see that something changed
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_count_docs (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                               -- e.g. items/i001, counts/2026-10/lines/i001, closing/2026-10
  coll TEXT NOT NULL,                               -- the path without its last segment
  data JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, path)
);
CREATE INDEX idx_stock_count_docs_coll ON stock_count_docs (company_id, coll);

INSERT INTO stock_count_settings (company_id, enabled)
SELECT id, true FROM companies WHERE name ILIKE 'MINIFISH%';
