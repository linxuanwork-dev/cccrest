-- Daily Sales quantities can be fractions (goods sold by the kg: 0.5 kg), up to 3 decimals.
ALTER TABLE dsi_quantities ALTER COLUMN qty TYPE NUMERIC(10,3);
