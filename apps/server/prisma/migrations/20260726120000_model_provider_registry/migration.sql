-- CreateEnum
CREATE TYPE "ModelProtocol" AS ENUM ('openai_compatible');

-- CreateEnum
CREATE TYPE "ModelCredentialMode" AS ENUM ('api_key', 'none');

-- CreateEnum
CREATE TYPE "ModelRole" AS ENUM ('turns', 'utility', 'embed');

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "protocol" "ModelProtocol" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "headersJson" JSONB,
    "credentialMode" "ModelCredentialMode" NOT NULL DEFAULT 'api_key',
    "credentialCiphertext" TEXT,
    "catalogJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelDefault" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" "ModelRole" NOT NULL,
    "chainJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelProvider_orgId_idx" ON "ModelProvider"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProvider_orgId_name_key" ON "ModelProvider"("orgId", "name");

-- CreateIndex
CREATE INDEX "ModelDefault_orgId_idx" ON "ModelDefault"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelDefault_orgId_role_key" ON "ModelDefault"("orgId", "role");

-- AddForeignKey
ALTER TABLE "ModelProvider" ADD CONSTRAINT "ModelProvider_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelDefault" ADD CONSTRAINT "ModelDefault_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
