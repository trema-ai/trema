-- Keep each OAuth connection tied to the client registration that minted it.
ALTER TABLE "ConnectorConnection"
ADD COLUMN "clientRegistrationId" TEXT;

-- Existing Slack connections are unambiguous when the organization has one
-- Slack registration. Ambiguous installations must reauthorize rather than
-- silently switching to a different app's signing secret.
UPDATE "ConnectorConnection" AS connection
SET "clientRegistrationId" = registration.id
FROM (
  SELECT MIN(id) AS id, "orgId"
  FROM "ClientRegistration"
  WHERE "providerKey" = 'slack'
  GROUP BY "orgId"
  HAVING COUNT(*) = 1
) AS registration
WHERE connection."providerKey" = 'slack'
  AND connection."orgId" = registration."orgId";

UPDATE "ConnectorConnection"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "providerKey" = 'slack'
  AND "revokedAt" IS NULL
  AND "clientRegistrationId" IS NULL;

CREATE INDEX "ConnectorConnection_orgId_clientRegistrationId_idx"
ON "ConnectorConnection"("orgId", "clientRegistrationId");

ALTER TABLE "ConnectorConnection"
ADD CONSTRAINT "ConnectorConnection_orgId_clientRegistrationId_fkey"
FOREIGN KEY ("orgId", "clientRegistrationId")
REFERENCES "ClientRegistration"("orgId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
