-- HR is one tick on the permission lists again: Payroll and KWSP & PERKESO both follow the 'payroll' level
-- (the separate 'kwsp' key added in 021 is dropped).
UPDATE company_staff SET permissions = permissions - 'kwsp' WHERE permissions ? 'kwsp';
UPDATE users SET permissions = permissions - 'kwsp' WHERE permissions ? 'kwsp';
