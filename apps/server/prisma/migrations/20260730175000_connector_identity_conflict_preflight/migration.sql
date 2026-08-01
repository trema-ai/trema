-- This preflight sorts before the migrations that add the connector and agent
-- uniqueness indexes. It intentionally performs no writes, so a conflict
-- failure leaves application data unchanged and is safe to mark rolled back.
--
-- After resolving every reported conflict, run:
--   prisma migrate resolve --rolled-back 20260730175000_connector_identity_conflict_preflight
-- Then rerun `trema migrate` or `prisma migrate deploy`.

-- BEGIN connector identity conflict preflight
DO $migration$
DECLARE
  installation_conflicts jsonb;
  agent_conflicts jsonb;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'orgId', grouped."orgId",
      'scopeId', grouped."scopeId",
      'providerKey', grouped."providerKey",
      'installationItemIds', grouped."installationItemIds"
    )
    ORDER BY grouped."orgId", grouped."scopeId", grouped."providerKey"
  )
  INTO installation_conflicts
  FROM (
    SELECT
      "orgId",
      "scopeId",
      "body"->>'catalogKey' AS "providerKey",
      jsonb_agg("id" ORDER BY "id") AS "installationItemIds"
    FROM "Item"
    WHERE "kind" = 'connector'
      AND "status" <> 'archived'
      AND "body" ? 'catalogKey'
    GROUP BY "orgId", "scopeId", "body"->>'catalogKey'
    HAVING count(*) > 1
  ) AS grouped;

  SELECT jsonb_agg(
    jsonb_build_object(
      'orgId', grouped."orgId",
      'agentPrincipalIds', grouped."agentPrincipalIds"
    )
    ORDER BY grouped."orgId"
  )
  INTO agent_conflicts
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

  IF installation_conflicts IS NOT NULL OR agent_conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'connector_identity_conflicts',
      DETAIL = jsonb_build_object(
        'installations', coalesce(installation_conflicts, '[]'::jsonb),
        'agents', coalesce(agent_conflicts, '[]'::jsonb)
      )::text,
      HINT = 'Resolve every listed conflict, mark this preflight migration rolled back, and rerun migration deployment.';
  END IF;
END
$migration$;
-- END connector identity conflict preflight
