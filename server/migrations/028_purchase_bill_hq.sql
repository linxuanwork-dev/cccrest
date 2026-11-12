-- A purchase bill made from a QC GROUP (HQ) bill PDF keeps what was read from the PDF, so that after the bill is exported to Bukku
-- the matching Sales Invoice (to the students / clients on the HQ bill) can be made from it.
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS hq jsonb;
