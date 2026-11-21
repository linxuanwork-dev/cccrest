-- Phase 2: bank matching (SPEC-system section 4 supplement). A bank line is a standard transaction (type 'bank') that is money IN or money OUT;
-- it is matched to the documents it pays (many documents for one payment, one document paid in several parts), or given another meaning
-- (direct expense, other income, director, internal transfer, suspense). The payer name that was matched once is remembered (payer_aliases).

ALTER TABLE transactions ADD COLUMN direction    TEXT CHECK (direction IN ('in', 'out'));
ALTER TABLE transactions ADD COLUMN bank_account TEXT;
UPDATE transactions SET direction = 'in' WHERE type = 'bank' AND direction IS NULL;

-- matches: how much of the bank line is applied to the other document; a match is never deleted, only voided (with who, when, why)
ALTER TABLE matches ADD COLUMN applied     NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN fee         NUMERIC(14,2) NOT NULL DEFAULT 0;   -- the bank charge taken from the same bank line (on the first match of a payment)
ALTER TABLE matches ADD COLUMN note        TEXT;
ALTER TABLE matches ADD COLUMN suggested   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN voided      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN voided_by   TEXT;
ALTER TABLE matches ADD COLUMN voided_at   TIMESTAMPTZ;
ALTER TABLE matches ADD COLUMN void_reason TEXT;
CREATE INDEX matches_bank ON matches (company_id, bank_tx_id) WHERE NOT voided;
CREATE INDEX matches_other ON matches (company_id, other_tx_id) WHERE NOT voided;

-- the payer name on the bank line -> the supplier / customer it really is (remembered after a person matched it once)
CREATE TABLE payer_aliases (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  side          TEXT NOT NULL CHECK (side IN ('in', 'out')),
  alias         TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  contact_code  TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, side, alias)
);
SELECT enable_company_rls('payer_aliases');

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 063', 'foundation', 'bank matching', 'create', 'phase 2: bank lines (money in / out), matches with amounts, payer aliases');
