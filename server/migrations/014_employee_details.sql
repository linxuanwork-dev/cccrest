-- Employee master (HR > Payroll): the details the KWSP / SOCSO forms, employment letters and payroll all need,
-- plus the IC images (stored as files per employee).

ALTER TABLE employees ADD COLUMN id_type TEXT NOT NULL DEFAULT 'B' CHECK (id_type IN ('B','L','T','P','PR','SSN','passport'));
ALTER TABLE employees ADD COLUMN dob DATE;
ALTER TABLE employees ADD COLUMN gender TEXT CHECK (gender IN ('L','P'));
ALTER TABLE employees ADD COLUMN race TEXT;                 -- KWSP / PERKESO race code 01..06
ALTER TABLE employees ADD COLUMN nationality TEXT;
ALTER TABLE employees ADD COLUMN address TEXT;
ALTER TABLE employees ADD COLUMN start_date DATE;
ALTER TABLE employees ADD COLUMN tin_no TEXT;
ALTER TABLE employees ADD COLUMN tax_resident TEXT NOT NULL DEFAULT 'resident' CHECK (tax_resident IN ('resident','non_resident'));
ALTER TABLE employees ADD COLUMN marital_status TEXT CHECK (marital_status IN ('single','married_spouse_not_working','married_working_spouse','widow_divorced'));
ALTER TABLE employees ADD COLUMN children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0);
ALTER TABLE employees ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE employee_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'ic',
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_documents_employee ON employee_documents(employee_id);
