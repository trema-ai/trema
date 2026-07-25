CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
-- "embedding" declares no dimension: the dimension comes from whichever model
-- wrote the vector, and "embeddingModel" records which one that was. Prisma
-- cannot express either column, so both are written by hand. No vector index
-- is created; every query is already narrowed to one organization's active
-- items in a few scopes.
ALTER TABLE "ItemSearchDoc" ADD COLUMN "embedding" vector;
ALTER TABLE "ItemSearchDoc" ADD COLUMN "embeddingModel" TEXT;

-- CreateTable
CREATE TABLE "EmbeddingSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiKeyCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmbeddingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingSettings_orgId_key" ON "EmbeddingSettings"("orgId");

-- AddForeignKey
ALTER TABLE "EmbeddingSettings" ADD CONSTRAINT "EmbeddingSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
