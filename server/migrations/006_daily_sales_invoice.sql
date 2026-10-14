-- Daily Sales -> Bukku Sales Invoice (Madam Lua TU, UK Lua HP / TN, + any branch a Manager adds later)

CREATE TABLE dsi_branches (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  report_prefix TEXT NOT NULL,
  company_name TEXT NOT NULL,
  reg_no TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  contact_code TEXT NOT NULL DEFAULT '',
  legal_name TEXT NOT NULL DEFAULT '',
  invoice_prefix TEXT NOT NULL,
  invoice_suffix TEXT NOT NULL DEFAULT '-01',
  payment_term TEXT NOT NULL DEFAULT 'NET30',
  tags TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL DEFAULT '5000',
  include_zero BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE dsi_menu_items (
  id SERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES dsi_branches(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  product TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX idx_dsi_menu_branch ON dsi_menu_items(branch_id, sort_order);

-- Only rows with qty > 0 are stored; a blank/0 cell simply has no row.
CREATE TABLE dsi_quantities (
  item_id INTEGER NOT NULL REFERENCES dsi_menu_items(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (item_id, entry_date)
);

-- Per-day price overrides ("特价"); a row here beats the menu price for that item+day.
CREATE TABLE dsi_specials (
  item_id INTEGER NOT NULL REFERENCES dsi_menu_items(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (item_id, entry_date)
);

-- ---- Seed: ML-TU (Madam Lua) ----
INSERT INTO dsi_branches (company_id, code, report_prefix, company_name, reg_no, address, contact_code, legal_name, invoice_prefix, sort_order)
SELECT id, 'TU', 'ML-TU', 'MADAM LUA WANTONMEE', '202503159423 / LA0079636-X',
       'No.47, Jalan Utama 30, Taman Mutiara Rini, 81300 Skudai, Johor, Malaysia',
       'C-C0001', 'Cash Sales', 'TU-INV-', 1
FROM companies WHERE regexp_replace(upper(name), '\s+', ' ', 'g') = 'MADAM LUA WANTONMEE';

INSERT INTO dsi_menu_items (branch_id, sort_order, product, unit_price)
SELECT b.id, t.ord, t.product, t.price
FROM dsi_branches b
CROSS JOIN LATERAL unnest(
  ARRAY[
    'NOODLE (SMALL) 面（小）', 'NOODLE (MEDIUM) 面（中）', 'NOODLE (BIG) 面（大）',
    'NOODLE (MEE POK) (SMALL) 面薄 (小）', 'NOODLE (MEE POK) (MEDIUM) 面薄 (中）', 'NOODLE (MEE POK) (BIG) 面薄 (大）',
    '3 BIG NOODLE (KOSONG)', '3 BIG NOODLE', '2 1/2 NOODLE',
    'NOODLE (SMALL) 面（小）KOSONG', 'NOODLE (MEDIUM) 面（中）KOSONG', 'NOODLE (BIG) 面（大）KOSONG',
    'FISHBALL HO FAN (SMALL) 鱼圆果条 （小）', 'FISHBALL HO FAN (MEDIUM) 鱼圆果条 （中）', 'FISHBALL HO FAN (BIG) 鱼圆果条 （大）',
    'WONTON SOUP 云吞汤', 'DUMPLING SOUP 水饺汤', 'ADD CHAR SIU +叉烧', 'ADD WONTON +云吞 (5pcs)', 'ADD Dumpling +水饺 (1pcs)', 'DUMPLING NOODLE 水饺面'
  ]::text[],
  ARRAY[7.00, 8.00, 9.00, 7.00, 8.00, 9.00, 7.50, 10.00, 9.50, 4.50, 5.50, 6.50, 7.00, 8.00, 9.00, 7.00, 7.50, 2.50, 2.50, 1.50, 1.00]::numeric[]
) WITH ORDINALITY AS t(product, price, ord)
WHERE b.code = 'TU' AND b.report_prefix = 'ML-TU';

-- ---- Seed: UK-HP (UK Lua) ----
INSERT INTO dsi_branches (company_id, code, report_prefix, company_name, reg_no, address, contact_code, legal_name, invoice_prefix, sort_order)
SELECT id, 'HP', 'UK-HP', 'UK LUA WANTONMEE ENTERPRISE', '202303146646 / JM0986104-T',
       '106A, Jalan Pahlawan 2, Taman Ungku Tun Aminah, 81300 Skudai, Johor, Malaysia',
       'C-C0001', 'Cash Sales', 'HP-INV-', 1
FROM companies WHERE regexp_replace(upper(name), '\s+', ' ', 'g') = 'UK LUA WANTONMEE ENTERPRISE';

INSERT INTO dsi_menu_items (branch_id, sort_order, product, unit_price)
SELECT b.id, t.ord, t.product, t.price
FROM dsi_branches b
CROSS JOIN LATERAL unnest(
  ARRAY[
    'NOODLE (SMALL) 面（小）', 'NOODLE (BIG) 面（大）', 'NOODLE (MEE POK) 面薄', 'NOODLE (BIG) 面（大）KOSONG', 'NOODLE (SMALL) 面（小）KOSONG',
    '3 BIG NOODLE', 'WONTON SOUP 云吞汤', 'DUMPLING SOUP 水饺汤', 'ADD CHAR SIU +叉烧', 'ADD WONTON +云吞 (5pcs)',
    'ADD Dumpling +水饺 (1pcs)', '生面', 'ADD Dumpling +水饺 (3pcs)'
  ]::text[],
  ARRAY[7.50, 9.50, 7.50, 5.50, 4.50, 10.50, 7.50, 7.50, 2.50, 2.50, 1.75, 2.00, 5.00]::numeric[]
) WITH ORDINALITY AS t(product, price, ord)
WHERE b.code = 'HP' AND b.report_prefix = 'UK-HP';

-- ---- Seed: UK-TN (UK Lua) ----
INSERT INTO dsi_branches (company_id, code, report_prefix, company_name, reg_no, address, contact_code, legal_name, invoice_prefix, sort_order)
SELECT id, 'TN', 'UK-TN', 'UK LUA WANTONMEE ENTERPRISE', '202303146646 / JM0986104-T',
       '106A, Jalan Pahlawan 2, Taman Ungku Tun Aminah, 81300 Skudai, Johor, Malaysia',
       'C-C0001', 'Cash Sales', 'TN-INV-', 2
FROM companies WHERE regexp_replace(upper(name), '\s+', ' ', 'g') = 'UK LUA WANTONMEE ENTERPRISE';

INSERT INTO dsi_menu_items (branch_id, sort_order, product, unit_price)
SELECT b.id, t.ord, t.product, t.price
FROM dsi_branches b
CROSS JOIN LATERAL unnest(
  ARRAY['NOODLE (SMALL) 面（小）', 'NOODLE (MEE POK) 面薄', 'NOODLE (BIG) 面（大）']::text[],
  ARRAY[8.00, 8.00, 10.00]::numeric[]
) WITH ORDINALITY AS t(product, price, ord)
WHERE b.code = 'TN' AND b.report_prefix = 'UK-TN';
