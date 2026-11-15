-- Employer's E number (LHDN), printed on Form EA; kept on the company profile so it is not typed again in the EA settings.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS employer_e_no TEXT;
