-- CreateEnum
CREATE TYPE "ClientRegistrationSource" AS ENUM ('platform', 'customer', 'dynamic');

-- CreateTable
CREATE TABLE "ClientRegistration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "source" "ClientRegistrationSource" NOT NULL,
    "clientId" TEXT,
    "clientSecretCiphertext" TEXT,
    "sharedRef" TEXT,
    "adminConsentGranted" BOOLEAN,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorCredential" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "installationItemId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastRefreshSuccess" TIMESTAMP(3),
    "lastRefreshFailure" TIMESTAMP(3),
    "refreshAttempts" INTEGER NOT NULL DEFAULT 0,
    "refreshExhausted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorOAuthState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "installationItemId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "returnTo" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientRegistration_orgId_providerKey_source_key" ON "ClientRegistration"("orgId", "providerKey", "source");

-- CreateIndex
CREATE UNIQUE INDEX "ClientRegistration_orgId_id_key" ON "ClientRegistration"("orgId", "id");

-- CreateIndex
CREATE INDEX "ClientRegistration_orgId_idx" ON "ClientRegistration"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorCredential_installationItemId_principalId_key" ON "ConnectorCredential"("installationItemId", "principalId");

-- CreateIndex
CREATE INDEX "ConnectorCredential_orgId_installationItemId_idx" ON "ConnectorCredential"("orgId", "installationItemId");

-- CreateIndex
CREATE INDEX "ConnectorCredential_orgId_principalId_idx" ON "ConnectorCredential"("orgId", "principalId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorOAuthState_stateHash_key" ON "ConnectorOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "ConnectorOAuthState_orgId_registrationId_idx" ON "ConnectorOAuthState"("orgId", "registrationId");

-- CreateIndex
CREATE INDEX "ConnectorOAuthState_orgId_installationItemId_idx" ON "ConnectorOAuthState"("orgId", "installationItemId");

-- CreateIndex
CREATE INDEX "ConnectorOAuthState_orgId_principalId_idx" ON "ConnectorOAuthState"("orgId", "principalId");

-- CreateIndex
CREATE INDEX "ConnectorOAuthState_expiresAt_idx" ON "ConnectorOAuthState"("expiresAt");

-- AddForeignKey
ALTER TABLE "ClientRegistration" ADD CONSTRAINT "ClientRegistration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_orgId_installationItemId_fkey" FOREIGN KEY ("orgId", "installationItemId") REFERENCES "Item"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_orgId_principalId_fkey" FOREIGN KEY ("orgId", "principalId") REFERENCES "Principal"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorOAuthState" ADD CONSTRAINT "ConnectorOAuthState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorOAuthState" ADD CONSTRAINT "ConnectorOAuthState_orgId_registrationId_fkey" FOREIGN KEY ("orgId", "registrationId") REFERENCES "ClientRegistration"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorOAuthState" ADD CONSTRAINT "ConnectorOAuthState_orgId_installationItemId_fkey" FOREIGN KEY ("orgId", "installationItemId") REFERENCES "Item"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorOAuthState" ADD CONSTRAINT "ConnectorOAuthState_orgId_principalId_fkey" FOREIGN KEY ("orgId", "principalId") REFERENCES "Principal"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
