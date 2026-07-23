-- DropForeignKey
ALTER TABLE "ConnectorCredential" DROP CONSTRAINT "ConnectorCredential_orgId_fkey";
ALTER TABLE "ConnectorCredential" DROP CONSTRAINT "ConnectorCredential_orgId_installationItemId_fkey";
ALTER TABLE "ConnectorCredential" DROP CONSTRAINT "ConnectorCredential_orgId_principalId_fkey";
ALTER TABLE "ConnectorOAuthState" DROP CONSTRAINT "ConnectorOAuthState_orgId_installationItemId_fkey";

-- DropTable
DROP TABLE "ConnectorCredential";

-- AlterTable
ALTER TABLE "ConnectorOAuthState"
DROP COLUMN "installationItemId",
ADD COLUMN "connectionId" TEXT,
ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "ConnectorConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "providerScopes" TEXT[] NOT NULL DEFAULT '{}',
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastRefreshSuccess" TIMESTAMP(3),
    "lastRefreshFailure" TIMESTAMP(3),
    "refreshAttempts" INTEGER NOT NULL DEFAULT 0,
    "refreshExhausted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorProviderSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "memberEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorProviderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectorConnection_orgId_providerKey_idx" ON "ConnectorConnection"("orgId", "providerKey");
CREATE INDEX "ConnectorConnection_orgId_principalId_idx" ON "ConnectorConnection"("orgId", "principalId");
CREATE INDEX "ConnectorOAuthState_connectionId_idx" ON "ConnectorOAuthState"("connectionId");
CREATE UNIQUE INDEX "ConnectorProviderSettings_orgId_providerKey_key" ON "ConnectorProviderSettings"("orgId", "providerKey");
CREATE INDEX "ConnectorProviderSettings_orgId_idx" ON "ConnectorProviderSettings"("orgId");

-- AddForeignKey
ALTER TABLE "ConnectorConnection" ADD CONSTRAINT "ConnectorConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorConnection" ADD CONSTRAINT "ConnectorConnection_orgId_principalId_fkey" FOREIGN KEY ("orgId", "principalId") REFERENCES "Principal"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorOAuthState" ADD CONSTRAINT "ConnectorOAuthState_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ConnectorConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConnectorProviderSettings" ADD CONSTRAINT "ConnectorProviderSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
