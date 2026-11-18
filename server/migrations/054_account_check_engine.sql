-- 账目检查: a check is made by the program rules (free, default) or by the AI (needs the AI key, paid per use)
ALTER TABLE ac_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'rules';
