-- CreateTable
CREATE TABLE "Binding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "locationRef" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Binding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Binding_orgId_scopeId_idx" ON "Binding"("orgId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "Binding_orgId_surface_locationRef_key" ON "Binding"("orgId", "surface", "locationRef");

-- AddForeignKey
ALTER TABLE "Binding" ADD CONSTRAINT "Binding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Binding" ADD CONSTRAINT "Binding_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce exactly one personal scope per human in an organization. Prisma
-- does not model partial unique indexes, so this index is maintained in SQL.
CREATE UNIQUE INDEX "Scope_one_personal_per_owner" ON "Scope"("orgId", "ownerId") WHERE "kind" = 'personal';
