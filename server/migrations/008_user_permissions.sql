-- Bukku-style permissions for company users: a type (user / administrator), a level per page
-- (1 Read Only, 2 Create, 3 Create & Update, 4 Full Access) and a named-approver flag.
-- The old two-value company_level column is left in place (now unused) so the previous release keeps
-- working while this one deploys; it can be dropped in a later migration.

ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'user' CHECK (user_type IN ('user','administrator'));
ALTER TABLE users ADD COLUMN permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN can_approve BOOLEAN NOT NULL DEFAULT false;

-- Carry existing company users over: a "manager" becomes an Administrator, a "staff" user gets
-- Create & Update (L3) on every page.
UPDATE users SET user_type = 'administrator' WHERE role = 'client' AND company_level = 'manager';
UPDATE users
SET permissions = '{"sales":3,"purchases":3,"bank":3,"claim":3,"petty":3,"merchant":3,"payroll":3}'::jsonb
WHERE role = 'client' AND company_level = 'staff';
