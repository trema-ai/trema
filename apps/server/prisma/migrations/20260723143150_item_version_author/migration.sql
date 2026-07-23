-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "updatedById" TEXT;

-- AlterTable
ALTER TABLE "ItemVersion" ADD COLUMN     "authorId" TEXT;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_orgId_updatedById_fkey" FOREIGN KEY ("orgId", "updatedById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemVersion" ADD CONSTRAINT "ItemVersion_orgId_authorId_fkey" FOREIGN KEY ("orgId", "authorId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
