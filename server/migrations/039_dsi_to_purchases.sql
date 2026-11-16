-- Uncle Koh's monthly sales invoices to its stores are the stores' purchases: a Sales Summary branch can send its invoices to the Purchases Bill
-- page of another company (as bills of the supplier UNCLE KOH NOODLE RESTAURANT), from where they are exported with Bukku's purchase bill template.
ALTER TABLE dsi_branches ADD COLUMN IF NOT EXISTS purchase_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
-- a bill made from a Sales Summary invoice remembers where it came from: dsi:<branch id>:<date>
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_bukku_bills_source ON purchase_bukku_bills (company_id, source) WHERE source IS NOT NULL;

-- Uncle Koh branches: ML -> Madam Lua, HP / TN -> UK Lua
UPDATE dsi_branches b SET purchase_company_id = t.id
FROM companies uk, companies t
WHERE b.company_id = uk.id AND regexp_replace(upper(uk.name), '\s+', ' ', 'g') = 'UNCLE KOH NOODLE RESTAURANT'
  AND b.purchase_company_id IS NULL
  AND ((b.code = 'ML' AND regexp_replace(upper(t.name), '\s+', ' ', 'g') = 'MADAM LUA WANTONMEE')
    OR (b.code IN ('HP', 'TN') AND regexp_replace(upper(t.name), '\s+', ' ', 'g') = 'UK LUA WANTONMEE ENTERPRISE'));

-- the two store companies use the Purchases Bill page, with Uncle Koh as a supplier (its Bukku Contact Code is added on that page; empty = matched by Legal Name)
INSERT INTO purchase_bukku_settings (company_id, enabled)
SELECT id, true FROM companies
WHERE regexp_replace(upper(name), '\s+', ' ', 'g') IN ('MADAM LUA WANTONMEE', 'UK LUA WANTONMEE ENTERPRISE')
ON CONFLICT (company_id) DO UPDATE SET enabled = true;

INSERT INTO purchase_bukku_contacts (company_id, name, code)
SELECT id, 'UNCLE KOH NOODLE RESTAURANT', '' FROM companies
WHERE regexp_replace(upper(name), '\s+', ' ', 'g') IN ('MADAM LUA WANTONMEE', 'UK LUA WANTONMEE ENTERPRISE')
ON CONFLICT (company_id, name) DO NOTHING;
