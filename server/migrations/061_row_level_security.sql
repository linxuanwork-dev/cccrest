-- Phase 1, step 6: row-level security (SPEC-system, instruction 1): the database itself keeps one company's rows away from another company.
--
-- HOW IT WORKS. The program connects as the owner of the tables (a superuser), and the owner is never held back by row-level security, so
-- NOTHING CHANGES until the program asks for it: with RLS_MODE=enforce the program switches the connection of a request to the role cccrest_app
-- (SET ROLE) and tells the database which companies the person may use (app.company_ids). From then on every statement of that request, even one
-- that forgets the company_id filter, only sees and changes the rows of those companies. With RLS_MODE unset (the default) none of this is used.
--
-- Tables with a NOT NULL company_id get the policy. Left out on purpose: users, company_staff, assignment_requests (who may use which company: managed
-- by the Owner, and a person asks for a company they do not have yet), audit_log, work_tasks, work_recurring (company_id may be empty = the firm's own),
-- and the tables that have no company_id of their own (they are reached through a parent row).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cccrest_app') THEN
    CREATE ROLE cccrest_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
-- a superuser can switch to any role; a plain owner needs to be a member
GRANT cccrest_app TO CURRENT_USER;

-- the one rule: the row's company is one of the companies of the request (or the request is trusted: app.bypass = on)
CREATE OR REPLACE FUNCTION app_rls_allows(cid INTEGER) RETURNS BOOLEAN AS $$
  SELECT current_setting('app.bypass', true) = 'on'
      OR (cid IS NOT NULL AND cid = ANY (string_to_array(NULLIF(current_setting('app.company_ids', true), ''), ',')::int[]))
$$ LANGUAGE sql STABLE;

-- enable_company_rls('table'): the policy for one table. Run it for every new table that has a company_id (tools/check-rls.js lists the ones missing).
CREATE OR REPLACE FUNCTION enable_company_rls(tbl TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', tbl);
  EXECUTE format('CREATE POLICY company_isolation ON %I TO cccrest_app USING (app_rls_allows(company_id)) WITH CHECK (app_rls_allows(company_id))', tbl);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE r RECORD; sch TEXT := current_schema();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO cccrest_app', sch);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO cccrest_app', sch);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO cccrest_app', sch);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cccrest_app', sch);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO cccrest_app', sch);
  FOR r IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = sch AND c.column_name = 'company_id' AND c.is_nullable = 'NO' AND c.data_type = 'integer'
       AND c.table_name NOT IN ('users', 'audit_log', 'work_tasks', 'work_recurring', 'company_staff', 'assignment_requests')
  LOOP
    PERFORM enable_company_rls(r.table_name);
  END LOOP;
END $$;

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 061', 'foundation', 'row level security', 'create', 'phase 1 step 6: role cccrest_app, the company policy on every table with a company_id (not used until RLS_MODE=enforce)');
