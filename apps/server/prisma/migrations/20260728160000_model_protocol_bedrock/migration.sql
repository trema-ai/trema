-- The AWS Bedrock wire protocol, now that `@trema/models` resolves it, and the
-- SigV4 credential mode that lands with it: a Bedrock call authenticates by
-- signing, so there is no key header for the modes above it to reuse.
--
-- The settings column is what a signature needs and an address cannot carry.
-- A signature names a region whatever host answers the call, so a VPC endpoint
-- or a gateway leaves nothing to read off the base URL; the region is not a
-- secret either, and has to be read back, so it cannot ride the write-only
-- credential. Each protocol declares the shape it takes and the rest refuse a
-- value, which is why one nullable column serves them all.

-- AlterEnum
ALTER TYPE "ModelProtocol" ADD VALUE 'bedrock';

-- AlterEnum
ALTER TYPE "ModelCredentialMode" ADD VALUE 'aws_sigv4';

-- AlterTable
ALTER TABLE "ModelProvider" ADD COLUMN "settingsJson" JSONB;
