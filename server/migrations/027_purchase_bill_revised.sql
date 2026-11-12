-- A bill that was already exported to Bukku and then changed by a manager goes back to "not exported" and is marked as revised:
-- the next Bukku file says so in its Description, and the mark is cleared once it has been exported again.
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS revised boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_bukku_bills ADD COLUMN IF NOT EXISTS revised_at timestamptz;
