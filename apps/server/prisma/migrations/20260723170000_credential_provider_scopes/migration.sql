-- AlterTable
ALTER TABLE "ConnectorCredential" ADD COLUMN     "providerScopes" TEXT[] NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ConnectorOAuthState" ADD COLUMN     "providerScopes" TEXT[] NOT NULL DEFAULT '{}';
