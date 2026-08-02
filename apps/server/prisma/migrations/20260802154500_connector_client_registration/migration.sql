-- Keep each OAuth connection tied to the client registration that minted it.
ALTER TABLE "ConnectorConnection"
ADD COLUMN "clientRegistrationId" TEXT;

-- BEGIN connector client registration backfill
-- Existing OAuth connections are unambiguous when the organization has one
-- registration for that provider. Ambiguous or registration-less connections
-- must reauthorize rather than silently switching to a different app.
UPDATE "ConnectorConnection" AS connection
SET "clientRegistrationId" = registration.id
FROM (
  SELECT MIN(id) AS id, "orgId", "providerKey"
  FROM "ClientRegistration"
  GROUP BY "orgId", "providerKey"
  HAVING COUNT(*) = 1
) AS registration
WHERE connection."orgId" = registration."orgId"
  AND connection."providerKey" = registration."providerKey"
  AND connection."authMode" IN ('oauth2_code', 'mcp_oauth');

UPDATE "ConnectorConnection"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "authMode" IN ('oauth2_code', 'mcp_oauth')
  AND "revokedAt" IS NULL
  AND "clientRegistrationId" IS NULL;
-- END connector client registration backfill

CREATE INDEX "ConnectorConnection_orgId_clientRegistrationId_idx"
ON "ConnectorConnection"("orgId", "clientRegistrationId");

ALTER TABLE "ConnectorConnection"
ADD CONSTRAINT "ConnectorConnection_orgId_clientRegistrationId_fkey"
FOREIGN KEY ("orgId", "clientRegistrationId")
REFERENCES "ClientRegistration"("orgId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
