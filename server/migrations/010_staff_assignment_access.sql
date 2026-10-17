-- A CC CREST staff member's access is now set per assignment (per company): a level for each page
-- (0 No access, 1 Read Only, 2 Create, 3 Create & Update, 4 Full Access) and a named-approver flag.
-- Existing assignments keep exactly what they had before (Create & Update on every page, cannot approve),
-- and the column default matches so an assignment made by the previous release behaves the same way.

ALTER TABLE company_staff ADD COLUMN permissions JSONB NOT NULL
  DEFAULT '{"sales":3,"purchases":3,"bank":3,"claim":3,"petty":3,"merchant":3,"payroll":3}'::jsonb;
ALTER TABLE company_staff ADD COLUMN can_approve BOOLEAN NOT NULL DEFAULT false;

-- A staff-initiated assignment request carries the levels it asks for, so approving it applies exactly those.
ALTER TABLE assignment_requests ADD COLUMN requested_access JSONB NOT NULL DEFAULT '{}'::jsonb;
