CREATE TABLE "SurfaceRealization" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "locationRef" TEXT NOT NULL,
    "threadRef" TEXT NOT NULL DEFAULT '',
    "renderedThroughSeq" INTEGER NOT NULL DEFAULT 0,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "presentation" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "retryAttempt" INTEGER NOT NULL DEFAULT 0,
    "terminalFailure" BOOLEAN NOT NULL DEFAULT false,
    "nextRetryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurfaceRealization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurfaceRealization_runId_surface_locationRef_threadRef_key"
ON "SurfaceRealization"("runId", "surface", "locationRef", "threadRef");

CREATE INDEX "SurfaceRealization_orgId_runId_idx"
ON "SurfaceRealization"("orgId", "runId");

CREATE INDEX "SurfaceRealization_leaseUntil_idx"
ON "SurfaceRealization"("leaseUntil");

CREATE INDEX "SurfaceRealization_nextRetryAt_idx"
ON "SurfaceRealization"("nextRetryAt");

ALTER TABLE "SurfaceRealization"
ADD CONSTRAINT "SurfaceRealization_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Org"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SurfaceRealization"
ADD CONSTRAINT "SurfaceRealization_orgId_runId_fkey"
FOREIGN KEY ("orgId", "runId") REFERENCES "AgentRun"("orgId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
