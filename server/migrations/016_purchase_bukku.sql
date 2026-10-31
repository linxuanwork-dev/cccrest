-- Purchases -> Bukku import file: set up per company in the Control Panel (Owner), used from the company's Purchases Bill page.
-- The feature is switched on company by company; it starts with SK SPRAY PPF.

CREATE TABLE purchase_bukku_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  account TEXT NOT NULL DEFAULT '6000',
  item_description TEXT NOT NULL DEFAULT 'Purchases',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supplier / employee name -> Bukku Contact Code (the company's own list)
CREATE TABLE purchase_bukku_contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  UNIQUE (company_id, name)
);

INSERT INTO purchase_bukku_settings (company_id, enabled)
SELECT id, true FROM companies WHERE name ILIKE 'SK SPRAY PPF%';
