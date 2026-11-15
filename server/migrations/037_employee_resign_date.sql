-- Staff Information: the last working day of a person who resigned. Payroll pays the month of leaving by the calendar days worked
-- (Employment Act s.18A) and suggests the pay for the unused annual leave.
ALTER TABLE employees ADD COLUMN resign_date DATE;
