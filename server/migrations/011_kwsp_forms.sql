-- KWSP & PERKESO employer registration forms (Services > HR). Each company can keep one or more saved
-- data sets (keyed by the company name used on the form); the 8 official PDFs are filled in the browser.

CREATE TABLE kwsp_forms (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- New HR page: switched on for every company that exists, and for new ones by default.
ALTER TABLE companies ALTER COLUMN enabled_features SET DEFAULT ARRAY[
  'panel-company-home','panel-sales','panel-bank','panel-purchases','panel-claim','panel-petty','panel-merchant','panel-payroll','panel-kwsp'
];

UPDATE companies SET enabled_features = array_append(enabled_features, 'panel-kwsp')
WHERE NOT ('panel-kwsp' = ANY(enabled_features));
