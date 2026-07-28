-- The Google wire protocol, now that `@trema/models` resolves it. One value per
-- protocol, never per vendor: the Gemini API and any gateway that answers its
-- shape are rows over this one.

-- AlterEnum
ALTER TYPE "ModelProtocol" ADD VALUE 'google';
