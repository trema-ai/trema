-- CreateTable
-- Prisma cannot express a generated column, so "tsv" and its GIN index are
-- written by hand. The title carries weight A and the body weight B, so a
-- term in the title outranks the same term in the body.
CREATE TABLE "ItemSearchDoc" (
    "itemId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("content", '')), 'B')
    ) STORED,

    CONSTRAINT "ItemSearchDoc_pkey" PRIMARY KEY ("orgId","itemId")
);

-- CreateIndex
CREATE INDEX "ItemSearchDoc_tsv_idx" ON "ItemSearchDoc" USING GIN ("tsv");

-- AddForeignKey
ALTER TABLE "ItemSearchDoc" ADD CONSTRAINT "ItemSearchDoc_orgId_itemId_fkey" FOREIGN KEY ("orgId", "itemId") REFERENCES "Item"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
