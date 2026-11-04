-- Dashboard, Documents & History, Company Profile and KWSP & PERKESO (HR) are now pages on the permission lists, so the
-- Owner can hide them from company users. Staff already assigned to a company keep what they could do before:
-- the first three start at L3 (they were open to every assigned staff member), KWSP & PERKESO follows their Payroll level.
UPDATE company_staff
SET permissions = permissions
  || CASE WHEN permissions ? 'home'    THEN '{}'::jsonb ELSE '{"home":3}'::jsonb END
  || CASE WHEN permissions ? 'docs'    THEN '{}'::jsonb ELSE '{"docs":3}'::jsonb END
  || CASE WHEN permissions ? 'profile' THEN '{}'::jsonb ELSE '{"profile":3}'::jsonb END
  || CASE WHEN permissions ? 'kwsp'    THEN '{}'::jsonb ELSE jsonb_build_object('kwsp', COALESCE(permissions->'payroll', '0'::jsonb)) END;
