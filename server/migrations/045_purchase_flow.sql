-- Purchase bill flow: approved -> in Bukku (ticked by a person) -> pay at the bank (a task in the work list, checked by the Owner).
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS no_original BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS in_bukku_at TIMESTAMPTZ;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS in_bukku_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS pay_due DATE;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS purchase_bill_id INTEGER REFERENCES purchase_bukku_bills(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_tasks_purchase_pay ON work_tasks (purchase_bill_id) WHERE purchase_bill_id IS NOT NULL AND kind = 'pay';
