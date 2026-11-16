-- Company Profile: contact person (printed on the e-Invoice information sheet next to the contact no.)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_person TEXT;
