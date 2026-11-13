-- Branches of one company that share one running number per day: IV-[YY][MM][DD]-[3DIGIT], 001, 002, ... in the order of the branches,
-- counting only the branches that have an invoice that day (no gaps). Off = the number is prefix + date + the branch's own suffix, as before.
ALTER TABLE dsi_branches ADD COLUMN IF NOT EXISTS invoice_seq boolean NOT NULL DEFAULT false;
