-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('read', 'write', 'destructive');

-- CreateEnum
CREATE TYPE "PolicyAction" AS ENUM ('allow', 'require_approval', 'deny');

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "sensitivity" "Sensitivity" NOT NULL,
    "action" "PolicyAction" NOT NULL,
    "approverRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "allowRequesterApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Policy_orgId_scopeId_sensitivity_key" ON "Policy"("orgId", "scopeId", "sensitivity");

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
