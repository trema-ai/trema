-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Principal" ADD COLUMN     "deactivatedAt" TIMESTAMP(3);
