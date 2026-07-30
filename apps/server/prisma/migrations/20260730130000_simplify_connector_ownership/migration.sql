-- Remove provider-level authorization policy from connector persistence.
DROP TABLE "ConnectorProviderSettings";

-- Name connection fields for the credential fact they carry.
ALTER TABLE "ConnectorConnection"
  RENAME COLUMN "principalId" TO "ownerPrincipalId";
ALTER TABLE "ConnectorConnection"
  RENAME COLUMN "mode" TO "authMode";
ALTER TABLE "ConnectorConnection"
  RENAME CONSTRAINT "ConnectorConnection_orgId_principalId_fkey"
  TO "ConnectorConnection_orgId_ownerPrincipalId_fkey";
ALTER INDEX "ConnectorConnection_orgId_principalId_idx"
  RENAME TO "ConnectorConnection_orgId_ownerPrincipalId_idx";

-- OAuth state keeps credential ownership separate from the human who started
-- the flow. Existing in-flight states use their prior owner as the initiator.
ALTER TABLE "ConnectorOAuthState"
  RENAME COLUMN "principalId" TO "ownerPrincipalId";
ALTER TABLE "ConnectorOAuthState"
  ADD COLUMN "initiatedByPrincipalId" TEXT;
UPDATE "ConnectorOAuthState"
SET "initiatedByPrincipalId" = "ownerPrincipalId";
ALTER TABLE "ConnectorOAuthState"
  ALTER COLUMN "initiatedByPrincipalId" SET NOT NULL;
ALTER TABLE "ConnectorOAuthState"
  RENAME CONSTRAINT "ConnectorOAuthState_orgId_principalId_fkey"
  TO "ConnectorOAuthState_orgId_ownerPrincipalId_fkey";
ALTER INDEX "ConnectorOAuthState_orgId_principalId_idx"
  RENAME TO "ConnectorOAuthState_orgId_ownerPrincipalId_idx";
CREATE INDEX "ConnectorOAuthState_orgId_initiatedByPrincipalId_idx"
  ON "ConnectorOAuthState"("orgId", "initiatedByPrincipalId");
ALTER TABLE "ConnectorOAuthState"
  ADD CONSTRAINT "ConnectorOAuthState_orgId_initiatedByPrincipalId_fkey"
  FOREIGN KEY ("orgId", "initiatedByPrincipalId")
  REFERENCES "Principal"("orgId", "id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
