-- Phase 1, step 4: the statutory payroll rules (EPF, SOCSO, EIS, pay lines) as versions with an effective date.
-- A new version is first a draft; the Owner approves it; an approved version can never be changed or deleted (the old ones stay for ever).
-- The first versions (the rules the program had until now, in force from the beginning) are written by the server the first time it starts.

CREATE TABLE statutory_rules (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('epf', 'socso', 'eis', 'pay')),
  effective_from DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  data           JSONB NOT NULL,
  note           TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ
);
-- one approved version per kind and date
CREATE UNIQUE INDEX statutory_rules_one_approved ON statutory_rules (kind, effective_from) WHERE status = 'approved';

CREATE FUNCTION statutory_rules_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'an approved statutory rule can not be changed or deleted: add a new version with a later effective date';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER statutory_rules_lock BEFORE UPDATE OR DELETE ON statutory_rules FOR EACH ROW EXECUTE FUNCTION statutory_rules_locked();

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 059', 'foundation', 'statutory_rules', 'create', 'phase 1 step 4: statutory payroll rules as versions with effective dates');
