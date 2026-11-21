-- Phase 1, step 5: one audit trail. From now on every new record of activity_log, document_events and tax_audit is also written to audit_log
-- (by the programs), and the records that already exist are copied here once. The old tables are not touched: they stay as they are.
-- `source` says where a row came from ('activity_log:12' = row 12 of activity_log), so the two can always be compared.

ALTER TABLE audit_log ADD COLUMN source TEXT;
CREATE INDEX audit_log_source ON audit_log (source);

-- activity_log: who did what to which company (the target is usually the company name)
INSERT INTO audit_log (at, who, user_id, company_id, module, record, action, after, source)
SELECT a.created_at,
       COALESCE(NULLIF(u.display_name, ''), NULLIF(u.login_id, ''), 'system'),
       a.actor_user_id,
       (SELECT c.id FROM companies c WHERE c.name = a.target ORDER BY c.id LIMIT 1),
       'activity', left(a.target, 200), left(a.action, 40), left(a.details, 2000), 'activity_log:' || a.id
FROM activity_log a LEFT JOIN users u ON u.id = a.actor_user_id
ORDER BY a.id;

-- document_events: one row for every changed field (or one row when the event has no field list)
INSERT INTO audit_log (at, who, user_id, company_id, module, record, action, field, before, after, source)
SELECT e.created_at, COALESCE(NULLIF(e.user_name, ''), 'system'), e.user_id, e.company_id,
       left(e.doc_type, 60), left(e.doc_ref, 200), e.event,
       left(d ->> 'field', 120), left(d ->> 'from', 2000), left(d ->> 'to', 2000), 'document_events:' || e.id
FROM document_events e
LEFT JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(e.details) = 'array' AND jsonb_array_length(e.details) > 0 THEN e.details ELSE '[null]'::jsonb END
) AS d ON true
ORDER BY e.id;

-- tax_audit: the personal income tax change record (no company: the clients of the tax module are people)
INSERT INTO audit_log (at, who, user_id, company_id, module, record, action, field, before, after, reason, source)
SELECT t.at, COALESCE(NULLIF(t.user_name, ''), 'system'), t.user_id, NULL, 'tax', left(t.coll || '/' || t.doc_id, 200), t.action,
       left(c ->> 'path', 120), left(c ->> 'before', 2000), left(c ->> 'after', 2000), NULLIF(left(t.reason, 500), ''), 'tax_audit:' || t.id
FROM tax_audit t
LEFT JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(t.changes) = 'array' AND jsonb_array_length(t.changes) > 0 THEN t.changes ELSE '[null]'::jsonb END
) AS c ON true
ORDER BY t.id;

INSERT INTO audit_log (who, module, record, action, reason)
VALUES ('migration 060', 'foundation', 'audit_log', 'backfill', 'phase 1 step 5: activity_log, document_events and tax_audit copied into audit_log');
