-- SKBBK (the non-employment injury scheme, employee share, from 1 June 2026) is optional for a Malaysian employee: some opted out (submitted by 31 August),
-- new members can choose not to join. A standing choice per employee: Payroll does not deduct it for the ones who opted out.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS skbbk_opt_out boolean NOT NULL DEFAULT false;
