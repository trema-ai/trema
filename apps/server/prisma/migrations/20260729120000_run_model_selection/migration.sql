-- A member's explicit model choice is pinned to the run it starts. Late input
-- keeps the same pair while it waits on the thread, so the next run can inherit
-- it. Both columns are nullable together: null means follow the turns default.
ALTER TABLE "AgentRun" ADD COLUMN "modelProviderName" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "modelModelId" TEXT;

ALTER TABLE "RunQueuedInput" ADD COLUMN "modelProviderName" TEXT;
ALTER TABLE "RunQueuedInput" ADD COLUMN "modelModelId" TEXT;
