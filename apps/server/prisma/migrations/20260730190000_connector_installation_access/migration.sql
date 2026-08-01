-- Existing installations preserve their current scope-wide reach.
-- BEGIN connector access backfill
UPDATE "Item"
SET "body" = jsonb_set("body", '{access}', '{"kind":"scope"}'::jsonb)
WHERE "kind" = 'connector'
  AND "status" <> 'archived'
  AND NOT jsonb_exists("body", 'access');
-- END connector access backfill

-- BEGIN active agent conflict check
-- A duplicate active agent has no safe automatic winner because session and
-- credential attribution may refer to either row. Report every conflict and
-- require an operator to deactivate the obsolete principal explicitly.
DO $migration$
DECLARE
  conflicts jsonb;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'orgId', grouped."orgId",
      'agentPrincipalIds', grouped."agentPrincipalIds"
    )
    ORDER BY grouped."orgId"
  )
  INTO conflicts
  FROM (
    SELECT
      "orgId",
      jsonb_agg("id" ORDER BY "id") AS "agentPrincipalIds"
    FROM "Principal"
    WHERE "kind" = 'agent'
      AND "deactivatedAt" IS NULL
    GROUP BY "orgId"
    HAVING count(*) > 1
  ) AS grouped;

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'active_agent_conflicts',
      DETAIL = conflicts::text,
      HINT = 'Deactivate every obsolete agent principal, then rerun the migration.';
  END IF;
END
$migration$;
-- END active agent conflict check
