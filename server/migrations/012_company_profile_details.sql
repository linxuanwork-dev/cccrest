-- Company profile (Bukku-style): legal name, registration type / old registration no., TIN, MSIC, contact, several
-- addresses, a logo, and what was read from the SSM documents. The letterhead image already lives in
-- letterhead_data_url (migration 004); without one, letters get a letterhead built from name + registration no. + address.

ALTER TABLE companies ADD COLUMN legal_name TEXT;
ALTER TABLE companies ADD COLUMN reg_type TEXT NOT NULL DEFAULT 'BRN' CHECK (reg_type IN ('BRN','NRIC','Passport','Army'));
ALTER TABLE companies ADD COLUMN old_registration_no TEXT;
ALTER TABLE companies ADD COLUMN tin TEXT;
ALTER TABLE companies ADD COLUMN msic_code TEXT;
ALTER TABLE companies ADD COLUMN msic_description TEXT;
ALTER TABLE companies ADD COLUMN tourism_tax_no TEXT;
ALTER TABLE companies ADD COLUMN contact_no TEXT;
ALTER TABLE companies ADD COLUMN email TEXT;
ALTER TABLE companies ADD COLUMN website TEXT;
ALTER TABLE companies ADD COLUMN addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE companies ADD COLUMN logo_data_url TEXT;
ALTER TABLE companies ADD COLUMN ssm_data JSONB;

-- The single address text that already exists becomes "Address 1".
UPDATE companies
   SET addresses = jsonb_build_array(jsonb_build_object('name', 'Address 1', 'street', address, 'city', '', 'postcode', '', 'country', 'Malaysia', 'state', ''))
 WHERE address IS NOT NULL AND btrim(address) <> '';
