-- Purchase bills: hard copy / soft copy received, and who paid out of pocket (to be reimbursed); who asked for the payment.
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS hardcopy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS softcopy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS paid_by TEXT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS pay_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS pay_requested_at TIMESTAMPTZ;
