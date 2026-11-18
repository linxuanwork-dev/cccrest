-- After the Owner has checked the bank, the payment of a purchase bill that was sent to Bukku through the API is recorded in Bukku
-- (a payment voucher linked to that bill). Switched on per company in the Control Panel, with the Bukku bank account that pays.
ALTER TABLE bukku_connections ADD COLUMN IF NOT EXISTS pay_auto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bukku_connections ADD COLUMN IF NOT EXISTS pay_account_id BIGINT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_pay_id BIGINT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_pay_no TEXT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_pay_error TEXT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_paid_at TIMESTAMPTZ;
