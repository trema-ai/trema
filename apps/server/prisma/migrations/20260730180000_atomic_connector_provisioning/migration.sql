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

-- Keep the most recently touched installation when old application behavior
-- managed to create duplicates. The partial expression index then makes the
-- one-provider-per-scope invariant concurrency-safe for every scope kind.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "orgId", "scopeId", ("body"->>'catalogKey')
      ORDER BY "updatedAt" DESC, "id" DESC
    ) AS position
  FROM "Item"
  WHERE "kind" = 'connector'
    AND "status" <> 'archived'
    AND "body" ? 'catalogKey'
)
UPDATE "Item"
SET "status" = 'archived'
FROM ranked
WHERE "Item"."id" = ranked."id"
  AND ranked.position > 1;

CREATE UNIQUE INDEX "Item_one_active_connector_per_scope_provider"
  ON "Item"("orgId", "scopeId", ("body"->>'catalogKey'))
  WHERE "kind" = 'connector'
    AND "status" <> 'archived'
    AND "body" ? 'catalogKey';
