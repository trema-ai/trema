-- OAuth state is deliberately short-lived. States minted by the previous
-- shape carry no installation intent, so invalidate them instead of guessing
-- a target scope.
DELETE FROM "ConnectorOAuthState";

ALTER TABLE "ConnectorOAuthState"
  ADD COLUMN "scopeId" TEXT NOT NULL;

CREATE INDEX "ConnectorOAuthState_orgId_scopeId_idx"
  ON "ConnectorOAuthState"("orgId", "scopeId");

ALTER TABLE "ConnectorOAuthState"
  ADD CONSTRAINT "ConnectorOAuthState_orgId_scopeId_fkey"
  FOREIGN KEY ("orgId", "scopeId")
  REFERENCES "Scope"("orgId", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- BEGIN connector installation conflict check
-- Stop with structured conflict details instead of silently choosing which
-- installation survives. An operator must resolve each listed scope/provider
-- conflict and rerun the migration.
DO $migration$
DECLARE
  conflicts jsonb;
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
  INTO conflicts
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

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'connector_installation_conflicts',
      DETAIL = conflicts::text,
      HINT = 'Archive or merge every listed duplicate installation, then rerun the migration.';
  END IF;
END
$migration$;
-- END connector installation conflict check

CREATE UNIQUE INDEX "Item_one_active_connector_per_scope_provider"
  ON "Item"("orgId", "scopeId", ("body"->>'catalogKey'))
  WHERE "kind" = 'connector'
    AND "status" <> 'archived'
    AND "body" ? 'catalogKey';
