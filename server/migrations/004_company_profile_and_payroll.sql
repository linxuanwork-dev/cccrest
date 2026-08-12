ALTER TABLE companies ADD COLUMN registration_no TEXT;
ALTER TABLE companies ADD COLUMN address TEXT;
ALTER TABLE companies ADD COLUMN letterhead_data_url TEXT;

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ic_no TEXT,
  position TEXT,
  bank_name TEXT,
  bank_account TEXT,
  epf_no TEXT,
  socso_no TEXT,
  basic_salary NUMERIC NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payroll_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_month TEXT NOT NULL,
  basic_salary NUMERIC NOT NULL DEFAULT 0,
  allowances NUMERIC NOT NULL DEFAULT 0,
  epf_employee NUMERIC NOT NULL DEFAULT 0,
  epf_employer NUMERIC NOT NULL DEFAULT 0,
  socso_employee NUMERIC NOT NULL DEFAULT 0,
  socso_employer NUMERIC NOT NULL DEFAULT 0,
  eis_employee NUMERIC NOT NULL DEFAULT 0,
  eis_employer NUMERIC NOT NULL DEFAULT 0,
  pcb NUMERIC NOT NULL DEFAULT 0,
  net_pay NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Paid')),
  payment_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_company_period ON payroll_entries(company_id, period_month);

ALTER TABLE companies ALTER COLUMN enabled_features SET DEFAULT ARRAY[
  'panel-company-home','panel-sales','panel-bank','panel-purchases','panel-claim','panel-petty','panel-merchant','panel-payroll'
];

UPDATE companies SET enabled_features = array_append(enabled_features, 'panel-payroll')
WHERE NOT ('panel-payroll' = ANY(enabled_features));
