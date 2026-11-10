-- DIDIK MULIA: the HQ bills (QC GROUP) are recorded as purchase bills and exported to Bukku from the Purchases Bill page.
-- Switch the Purchases Bill feature on for DIDIK MULIA and add the supplier QC GROUP with its Bukku contact code.
INSERT INTO purchase_bukku_settings (company_id, enabled)
SELECT id, true FROM companies WHERE name ILIKE 'DIDIK MULIA%'
ON CONFLICT (company_id) DO UPDATE SET enabled = true;

INSERT INTO purchase_bukku_contacts (company_id, name, code)
SELECT id, 'QC GROUP SDN BHD', 'C-Q0001' FROM companies WHERE name ILIKE 'DIDIK MULIA%'
ON CONFLICT (company_id, name) DO NOTHING;
