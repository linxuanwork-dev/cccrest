-- Purchase bills that are typed directly in Bukku are read into the system too (read only), when the Owner switches it on per company.
ALTER TABLE bukku_connections ADD COLUMN IF NOT EXISTS pull_enabled BOOLEAN NOT NULL DEFAULT false;
