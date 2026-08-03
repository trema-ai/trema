-- Bind a message idempotency claim to the original caller-controlled routing
-- values. A changed retry cannot replace a partially routed opening input.
ALTER TABLE "RunIntent" ADD COLUMN "requestHash" TEXT;
