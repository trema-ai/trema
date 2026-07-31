-- Existing installations preserve their current scope-wide reach.
UPDATE "Item"
SET "body" = jsonb_set("body", '{access}', '{"kind":"scope"}'::jsonb)
WHERE "kind" = 'connector'
  AND NOT jsonb_exists("body", 'access');
