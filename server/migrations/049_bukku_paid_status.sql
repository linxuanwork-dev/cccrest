-- What Bukku says about a purchase bill of the system: paid or not (read through the API; nothing is written to Bukku).
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_paid BOOLEAN;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_balance NUMERIC(14,2);
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_checked_at TIMESTAMPTZ;
