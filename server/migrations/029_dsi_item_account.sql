-- Sales Summary menu items can have their own Bukku Income account (e.g. Uncle Koh: goods 5101, packing 5102, ...);
-- empty = the branch's Account Code is used, as before.
ALTER TABLE dsi_menu_items ADD COLUMN IF NOT EXISTS account_code TEXT NOT NULL DEFAULT '';
