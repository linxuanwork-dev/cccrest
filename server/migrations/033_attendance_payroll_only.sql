-- A company can use the HR Payroll page without the attendance (salaried staff: the days, overtime and unpaid leave are typed in each month).
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS payroll_only boolean NOT NULL DEFAULT false;
