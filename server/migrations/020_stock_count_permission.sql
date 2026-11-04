-- Stock Count now has its own level on the permission lists (next to Sales, Purchases ...). Staff who were already assigned to a
-- company keep what they could do before: their Stock Count level starts at their Purchases level.
UPDATE company_staff
SET permissions = permissions || jsonb_build_object('stock', COALESCE(permissions->'purchases', '0'::jsonb))
WHERE NOT (permissions ? 'stock');
