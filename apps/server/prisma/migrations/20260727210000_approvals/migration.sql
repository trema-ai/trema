-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'denied', 'expired');

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "toolKey" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sensitivity" "Sensitivity" NOT NULL,
    "approverRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "allowRequesterApproval" BOOLEAN NOT NULL DEFAULT false,
    "requesterPrincipalId" TEXT,
    "requesterExternalRef" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nudgedAt" TIMESTAMP(3),
    "nudgeCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Approval_orgId_status_expiresAt_idx" ON "Approval"("orgId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "Approval_orgId_scopeId_status_idx" ON "Approval"("orgId", "scopeId", "status");

-- CreateIndex
CREATE INDEX "Approval_orgId_sessionId_idx" ON "Approval"("orgId", "sessionId");

-- CreateIndex
CREATE INDEX "Approval_orgId_requesterPrincipalId_idx" ON "Approval"("orgId", "requesterPrincipalId");

-- CreateIndex
CREATE INDEX "Approval_orgId_resolvedById_idx" ON "Approval"("orgId", "resolvedById");

-- CreateIndex
CREATE INDEX "Approval_orgId_sessionId_toolKey_argsHash_idx" ON "Approval"("orgId", "sessionId", "toolKey", "argsHash");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_orgId_id_key" ON "Approval"("orgId", "id");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_sessionId_fkey" FOREIGN KEY ("orgId", "sessionId") REFERENCES "ContextSession"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_requesterPrincipalId_fkey" FOREIGN KEY ("orgId", "requesterPrincipalId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_resolvedById_fkey" FOREIGN KEY ("orgId", "resolvedById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
