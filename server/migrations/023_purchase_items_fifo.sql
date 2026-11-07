-- Purchase bills: each supplier's usual items ("what this supplier sells us") with the last price, and — for a company that also
-- uses Stock Count — the link from the supplier's item name to a Stock Count item, with the buying unit (a carton, a pack, a kg...).
-- Stock Count then values the closing stock with FIFO from these purchase records.

CREATE TABLE purchase_bukku_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier TEXT NOT NULL,                       -- the supplier's Legal Name (upper case, single spaces)
  alias TEXT NOT NULL,                          -- the item name as typed / as on the supplier's invoice (upper case)
  stock_item_id TEXT NOT NULL DEFAULT '',       -- Stock Count item id ('' = not linked)
  unit TEXT NOT NULL DEFAULT '',                -- what we buy it in (CTN, PKT, KG ...)
  per NUMERIC(14,4) NOT NULL DEFAULT 1 CHECK (per > 0),   -- how many of that buying unit make 1 Stock Count unit
  price NUMERIC(14,4),                          -- last unit price (per buying unit)
  last_date DATE,                               -- date of the bill that price came from
  account TEXT NOT NULL DEFAULT '',
  tax TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, supplier, alias)
);
CREATE INDEX idx_purchase_bukku_items_company ON purchase_bukku_items (company_id, supplier);

-- The first month whose closing stock is valued from the purchase records (FIFO). Empty = off (prices come from the item list).
ALTER TABLE stock_count_settings ADD COLUMN fifo_from TEXT NOT NULL DEFAULT '';
