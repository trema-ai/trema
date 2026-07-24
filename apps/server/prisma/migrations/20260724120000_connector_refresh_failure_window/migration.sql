-- The failure budget needs both the most recent failure (for cooldown) and
-- the beginning of the current consecutive-failure window (for exhaustion).
ALTER TABLE "ConnectorConnection"
ADD COLUMN "refreshFailureStartedAt" TIMESTAMP(3);
