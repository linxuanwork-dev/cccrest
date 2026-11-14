-- Salary history of an employee: every change of the basic salary is kept with the date it starts and the reason.
-- employees.basic_salary stays the current salary; Payroll uses the salary that applies to the month it is run for
-- (a change applies to the whole month its date falls in).
CREATE TABLE employee_salary_history (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  amount NUMERIC NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_salary_history_employee ON employee_salary_history (employee_id, effective_date);
