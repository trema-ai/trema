-- A Slack workspace may resolve to at most one active Trema organization.
-- The OAuth response field is hoisted into ConnectorConnection.config as
-- non-secret metadata; the bot and refresh tokens remain envelope-encrypted.
--
-- Older releases allowed the same workspace to be connected more than once.
-- Keep the most recently touched authorization active and revoke the rest so
-- existing deployments can apply the uniqueness constraint deterministically.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY ("config"->>'team.id')
      ORDER BY "updatedAt" DESC, "id" DESC
    ) AS position
  FROM "ConnectorConnection"
  WHERE "providerKey" = 'slack'
    AND "revokedAt" IS NULL
    AND "config" ? 'team.id'
    AND "config"->>'team.id' IS NOT NULL
)
UPDATE "ConnectorConnection" AS connection
SET
  "revokedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM ranked
WHERE connection."id" = ranked."id"
  AND ranked.position > 1;

CREATE UNIQUE INDEX "ConnectorConnection_one_active_slack_workspace"
ON "ConnectorConnection" (("config"->>'team.id'))
WHERE "providerKey" = 'slack'
  AND "revokedAt" IS NULL
  AND "config" ? 'team.id';
