-- CreateEnum
CREATE TYPE "ItemKind" AS ENUM ('memory', 'skill', 'instruction', 'connector', 'conversation');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('proposed', 'active', 'archived');

-- CreateEnum
CREATE TYPE "ItemDisclosure" AS ENUM ('standing', 'retrieved');

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "kind" "ItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "status" "ItemStatus" NOT NULL,
    "disclosure" "ItemDisclosure" NOT NULL,
    "createdById" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemVersion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Item_orgId_scopeId_idx" ON "Item"("orgId", "scopeId");

-- CreateIndex
CREATE INDEX "Item_orgId_kind_status_idx" ON "Item"("orgId", "kind", "status");

-- CreateIndex
CREATE INDEX "Item_orgId_createdById_idx" ON "Item"("orgId", "createdById");

-- CreateIndex
CREATE INDEX "Item_orgId_confirmedById_idx" ON "Item"("orgId", "confirmedById");

-- CreateIndex
CREATE UNIQUE INDEX "Item_orgId_id_key" ON "Item"("orgId", "id");

-- CreateIndex
CREATE INDEX "ItemVersion_orgId_itemId_idx" ON "ItemVersion"("orgId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemVersion_itemId_version_key" ON "ItemVersion"("itemId", "version");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_orgId_createdById_fkey" FOREIGN KEY ("orgId", "createdById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_orgId_confirmedById_fkey" FOREIGN KEY ("orgId", "confirmedById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemVersion" ADD CONSTRAINT "ItemVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemVersion" ADD CONSTRAINT "ItemVersion_orgId_itemId_fkey" FOREIGN KEY ("orgId", "itemId") REFERENCES "Item"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
