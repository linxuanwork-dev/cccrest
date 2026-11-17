-- Send purchase bills to Bukku through the API (switched on per company by the Owner in the Control Panel; as a draft or, when the Owner chooses, as a finished bill).
CREATE TABLE IF NOT EXISTS bukku_tags (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bukku_id   BIGINT  NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, bukku_id)
);
ALTER TABLE bukku_connections ADD COLUMN IF NOT EXISTS send_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bukku_connections ADD COLUMN IF NOT EXISTS send_status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS pay_mode TEXT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_txn_id BIGINT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_txn_no TEXT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_sent_at TIMESTAMPTZ;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_send_error TEXT;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS bukku_sent_status TEXT;
