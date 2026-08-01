-- A Slack workspace may resolve to at most one active Trema organization.
-- The OAuth response field is hoisted into ConnectorConnection.config as
-- non-secret metadata; the bot and refresh tokens remain envelope-encrypted.
CREATE UNIQUE INDEX "ConnectorConnection_one_active_slack_workspace"
ON "ConnectorConnection" (("config"->>'team.id'))
WHERE "providerKey" = 'slack'
  AND "revokedAt" IS NULL
  AND "config" ? 'team.id';
