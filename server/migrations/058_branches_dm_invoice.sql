-- Phase 1, step 3: branches, the Registration & Modul invoice rules (accounts, numbering, item text, prices) of Didik Mulia
-- move out of the programs into branches / account_mappings / company_settings. The values are exactly the ones the programs had.

ALTER TABLE branches ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- the customer code list had the three branch codes fixed by a CHECK: a new branch could not be saved. The branches list decides now.
ALTER TABLE dm_customer_lookup DROP CONSTRAINT IF EXISTS dm_customer_lookup_branch_check;

-- The company that has the Didik Mulia Sales panel (setting sales_panel = didik_mulia, from migration 057).
-- Order as the Tuition page lists them: BBU, TST, TDA. BBU is also found from the address on an HQ bill.
INSERT INTO branches (company_id, code, name, sort_order, extra)
SELECT s.company_id, b.code, b.code, b.sort_order, b.extra::jsonb
FROM company_settings s
CROSS JOIN (VALUES
  ('BBU', 1, '{"addressMatch":["BANDAR BARU UDA"]}'),
  ('TST', 2, '{}'),
  ('TDA', 3, '{}')
) AS b(code, sort_order, extra)
WHERE s.key = 'sales_panel' AND s.value = '"didik_mulia"'::jsonb
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO account_mappings (company_id, kind, source_name, target_account, note)
SELECT s.company_id, 'dm_invoice', m.source_name, m.account, 'moved out of dmInvoiceRules.js'
FROM company_settings s
CROSS JOIN (VALUES ('registration', '5000-01'), ('module', '5000-03')) AS m(source_name, account)
WHERE s.key = 'sales_panel' AND s.value = '"didik_mulia"'::jsonb
ON CONFLICT (company_id, kind, source_name) DO NOTHING;

-- numbering and item text: {BRANCH} {YY} {YYYY} {MM} are filled in; [3DIGIT] is written as it is so that Bukku runs the number
INSERT INTO company_settings (company_id, key, value, created_by, note)
SELECT s.company_id, 'dm_invoice', $json$
{"invoicePattern":{"registration":"IV-{BRANCH}-R{YY}{MM}-[3DIGIT]","module":"IV-{BRANCH}-M{YY}{MM}-[3DIGIT]"},
 "itemDescription":{"registration":"{BRANCH}-REGISTRATION","module":"{BRANCH}-MODUL {YYYY}_{MM}"},
 "prices":{"module":80,"registrationMale":200,"registrationFemale":210}}
$json$::jsonb, 'migration 058', 'moved out of dmInvoiceRules.js'
FROM company_settings s
WHERE s.key = 'sales_panel' AND s.value = '"didik_mulia"'::jsonb
ON CONFLICT DO NOTHING;

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 058', 'foundation', 'branches / dm_invoice', 'create', 'phase 1 step 3: Didik Mulia branches and Registration & Modul invoice rules moved out of the programs');
