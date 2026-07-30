-- Every organization has at most one active agent. The partial index keeps
-- historical, deactivated agent rows possible while making live resolution
-- unambiguous.
CREATE UNIQUE INDEX "Principal_one_active_agent_per_org"
ON "Principal"("orgId")
WHERE "kind" = 'agent' AND "deactivatedAt" IS NULL;

-- Rename the attribution column before backfilling it so the migration states
-- the new meaning directly. Historical personal sessions deliberately stop
-- pointing at their former human actor.
ALTER TABLE "ContextSession"
DROP CONSTRAINT "ContextSession_orgId_actingPrincipalId_fkey";

DROP INDEX "ContextSession_orgId_actingPrincipalId_idx";

ALTER TABLE "ContextSession"
RENAME COLUMN "actingPrincipalId" TO "agentPrincipalId";

UPDATE "ContextSession" AS session
SET "agentPrincipalId" = agent.id
FROM "Principal" AS agent
WHERE agent."orgId" = session."orgId"
  AND agent."kind" = 'agent'
  AND agent."deactivatedAt" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ContextSession" AS session
    LEFT JOIN "Principal" AS agent
      ON agent.id = session."agentPrincipalId"
      AND agent."orgId" = session."orgId"
      AND agent."kind" = 'agent'
      AND agent."deactivatedAt" IS NULL
    WHERE agent.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Every context session must resolve to its organization''s active agent principal';
  END IF;
END
$$;

CREATE INDEX "ContextSession_orgId_agentPrincipalId_idx"
ON "ContextSession"("orgId", "agentPrincipalId");

ALTER TABLE "ContextSession"
ADD CONSTRAINT "ContextSession_orgId_agentPrincipalId_fkey"
FOREIGN KEY ("orgId", "agentPrincipalId")
REFERENCES "Principal"("orgId", "id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "ContextSession"
DROP COLUMN "mode";

DROP TYPE "SessionMode";
