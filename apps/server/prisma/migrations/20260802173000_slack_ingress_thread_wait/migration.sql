ALTER TABLE "SlackIngressDelivery"
ADD COLUMN "threadKey" TEXT,
ADD COLUMN "awaitingThread" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "SlackIngressDelivery_threadKey_awaitingThread_completedAt_idx"
ON "SlackIngressDelivery"("threadKey", "awaitingThread", "completedAt");
