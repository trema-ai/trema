-- The Anthropic wire protocol, now that `@trema/models` resolves it. One value
-- per protocol, never per vendor: the Anthropic API, the Claude subscription,
-- and any Anthropic-compatible gateway are all rows over this one.

-- AlterEnum
ALTER TYPE "ModelProtocol" ADD VALUE 'anthropic';
