-- The compound FK's SET NULL could never fire: SET NULL on a multi-column
-- foreign key nulls every referencing column, and "orgId" is NOT NULL, so any
-- delete reaching a ContextSession with runs raised a not-null violation —
-- including the Org delete cascade. NO ACTION checks at end of statement: an
-- org delete that cascades away both runs and sessions succeeds, while a
-- delete that would leave a surviving run without its session is refused.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_orgId_sessionId_fkey";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_orgId_sessionId_fkey" FOREIGN KEY ("orgId", "sessionId") REFERENCES "ContextSession"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
