-- CreateEnum
CREATE TYPE "SessionMode" AS ENUM ('service', 'delegated');

-- CreateTable
CREATE TABLE "ContextSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "locationRef" TEXT NOT NULL,
    "threadRef" TEXT,
    "mode" "SessionMode" NOT NULL,
    "scopeChain" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actingPrincipalId" TEXT NOT NULL,
    "requesterPrincipalId" TEXT,
    "requesterExternalRef" TEXT,
    "standing" JSONB NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContextSession_tokenHash_key" ON "ContextSession"("tokenHash");

-- CreateIndex
CREATE INDEX "ContextSession_orgId_scopeId_idx" ON "ContextSession"("orgId", "scopeId");

-- CreateIndex
CREATE INDEX "ContextSession_orgId_actingPrincipalId_idx" ON "ContextSession"("orgId", "actingPrincipalId");

-- CreateIndex
CREATE INDEX "ContextSession_orgId_requesterPrincipalId_idx" ON "ContextSession"("orgId", "requesterPrincipalId");

-- CreateIndex
CREATE INDEX "ContextSession_orgId_expiresAt_idx" ON "ContextSession"("orgId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContextSession_orgId_id_key" ON "ContextSession"("orgId", "id");

-- AddForeignKey
ALTER TABLE "ContextSession" ADD CONSTRAINT "ContextSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSession" ADD CONSTRAINT "ContextSession_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSession" ADD CONSTRAINT "ContextSession_orgId_actingPrincipalId_fkey" FOREIGN KEY ("orgId", "actingPrincipalId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSession" ADD CONSTRAINT "ContextSession_orgId_requesterPrincipalId_fkey" FOREIGN KEY ("orgId", "requesterPrincipalId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
