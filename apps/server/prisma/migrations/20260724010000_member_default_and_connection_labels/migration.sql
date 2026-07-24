-- AlterTable
ALTER TABLE "ConnectorProviderSettings" ALTER COLUMN "memberEnabled" SET DEFAULT true;

-- AlterTable
ALTER TABLE "ConnectorOAuthState" ADD COLUMN "label" TEXT;
