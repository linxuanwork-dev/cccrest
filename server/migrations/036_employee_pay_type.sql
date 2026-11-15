-- Staff Information: how a person is employed (full time / part time / casual) and how the basic salary is quoted (per month / day / hour).
-- basic_salary (and every salary history amount) is the rate for that basis; Payroll multiplies a day or hour rate by the days / hours worked.
ALTER TABLE employees ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'FULLTIME' CHECK (employment_type IN ('FULLTIME','PARTTIME','CASUAL'));
ALTER TABLE employees ADD COLUMN pay_basis TEXT NOT NULL DEFAULT 'MONTH' CHECK (pay_basis IN ('MONTH','DAY','HOUR'));
