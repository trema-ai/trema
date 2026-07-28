-- The OpenAI Responses wire protocol, now that `@trema/models` resolves it. One
-- value per protocol, never per vendor: Azure OpenAI's v1 surface is the reason
-- it lands, and plain OpenAI stays a row over the OpenAI-compatible value.

-- AlterEnum
ALTER TYPE "ModelProtocol" ADD VALUE 'openai_responses';
