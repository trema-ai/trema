-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('queued', 'running', 'awaiting_approval', 'awaiting_input', 'completed', 'failed', 'cancelled', 'stale');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('message', 'api', 'schedule', 'retry', 'resume');

-- CreateEnum
CREATE TYPE "TurnStopReason" AS ENUM ('stop', 'toolUse', 'length', 'error', 'aborted', 'paused');

-- CreateEnum
CREATE TYPE "RunInputKind" AS ENUM ('steering', 'follow_up');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('proposed', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "ScheduleFiringOutcome" AS ENUM ('started', 'skipped_overlap', 'skipped_missed');

-- AlterTable
ALTER TABLE "ConnectorOAuthState" ALTER COLUMN "config" DROP DEFAULT;

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadRef" TEXT NOT NULL,
    "state" "RunState" NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "lastEventSeq" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "retryOfRunId" TEXT,
    "retryAttempt" INTEGER,
    "usage" JSONB,
    "error" TEXT,
    "runGrants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Turn" (
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "model" JSONB NOT NULL,
    "message" JSONB NOT NULL,
    "toolResults" JSONB NOT NULL,
    "pendingCallId" TEXT,
    "pendingElicitationId" TEXT,
    "stopReason" "TurnStopReason" NOT NULL,
    "usage" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Turn_pkey" PRIMARY KEY ("runId","index")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "v" INTEGER NOT NULL DEFAULT 1,
    "event" JSONB NOT NULL,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunQueuedInput" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "RunInputKind" NOT NULL,
    "runId" TEXT,
    "threadRef" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "author" JSONB NOT NULL,
    "position" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunQueuedInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunIntent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunIntent_pkey" PRIMARY KEY ("orgId","id")
);

-- CreateTable
CREATE TABLE "RunStop" (
    "runId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "by" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunStop_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "RunElicitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "event" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunElicitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "threadRef" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ScheduleStatus" NOT NULL DEFAULT 'proposed',
    "createdById" TEXT NOT NULL,
    "activatedById" TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "lastTickAt" TIMESTAMP(3),
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleFiring" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "tickAt" TIMESTAMP(3) NOT NULL,
    "outcome" "ScheduleFiringOutcome" NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleFiring_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_orgId_threadRef_createdAt_idx" ON "AgentRun"("orgId", "threadRef", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_orgId_state_idx" ON "AgentRun"("orgId", "state");

-- CreateIndex
CREATE INDEX "AgentRun_orgId_sessionId_idx" ON "AgentRun"("orgId", "sessionId");

-- CreateIndex
CREATE INDEX "AgentRun_retryOfRunId_idx" ON "AgentRun"("retryOfRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_orgId_id_key" ON "AgentRun"("orgId", "id");

-- CreateIndex
CREATE INDEX "Turn_orgId_runId_idx" ON "Turn"("orgId", "runId");

-- CreateIndex
CREATE INDEX "RunEvent_orgId_runId_seq_idx" ON "RunEvent"("orgId", "runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_seq_key" ON "RunEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX "RunQueuedInput_orgId_runId_position_idx" ON "RunQueuedInput"("orgId", "runId", "position");

-- CreateIndex
CREATE INDEX "RunQueuedInput_orgId_threadRef_position_idx" ON "RunQueuedInput"("orgId", "threadRef", "position");

-- CreateIndex
CREATE INDEX "RunIntent_orgId_createdAt_idx" ON "RunIntent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "RunStop_orgId_idx" ON "RunStop"("orgId");

-- CreateIndex
CREATE INDEX "RunElicitation_orgId_runId_idx" ON "RunElicitation"("orgId", "runId");

-- CreateIndex
CREATE INDEX "RunElicitation_orgId_expiresAt_idx" ON "RunElicitation"("orgId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunElicitation_orgId_id_key" ON "RunElicitation"("orgId", "id");

-- CreateIndex
CREATE INDEX "Schedule_orgId_status_idx" ON "Schedule"("orgId", "status");

-- CreateIndex
CREATE INDEX "Schedule_orgId_scopeId_idx" ON "Schedule"("orgId", "scopeId");

-- CreateIndex
CREATE INDEX "Schedule_orgId_createdById_idx" ON "Schedule"("orgId", "createdById");

-- CreateIndex
CREATE INDEX "Schedule_orgId_activatedById_idx" ON "Schedule"("orgId", "activatedById");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_orgId_id_key" ON "Schedule"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_orgId_threadRef_key" ON "Schedule"("orgId", "threadRef");

-- CreateIndex
CREATE INDEX "ScheduleFiring_orgId_scheduleId_tickAt_idx" ON "ScheduleFiring"("orgId", "scheduleId", "tickAt");

-- CreateIndex
CREATE INDEX "ScheduleFiring_runId_idx" ON "ScheduleFiring"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleFiring_orgId_scheduleId_tickAt_key" ON "ScheduleFiring"("orgId", "scheduleId", "tickAt");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_orgId_sessionId_fkey" FOREIGN KEY ("orgId", "sessionId") REFERENCES "ContextSession"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_retryOfRunId_fkey" FOREIGN KEY ("retryOfRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunQueuedInput" ADD CONSTRAINT "RunQueuedInput_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunQueuedInput" ADD CONSTRAINT "RunQueuedInput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunIntent" ADD CONSTRAINT "RunIntent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunStop" ADD CONSTRAINT "RunStop_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunStop" ADD CONSTRAINT "RunStop_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunElicitation" ADD CONSTRAINT "RunElicitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunElicitation" ADD CONSTRAINT "RunElicitation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_orgId_createdById_fkey" FOREIGN KEY ("orgId", "createdById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_orgId_activatedById_fkey" FOREIGN KEY ("orgId", "activatedById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleFiring" ADD CONSTRAINT "ScheduleFiring_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleFiring" ADD CONSTRAINT "ScheduleFiring_orgId_scheduleId_fkey" FOREIGN KEY ("orgId", "scheduleId") REFERENCES "Schedule"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleFiring" ADD CONSTRAINT "ScheduleFiring_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
