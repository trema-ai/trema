ALTER TABLE "SlackIngressDelivery"
ADD COLUMN "opensThread" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "SlackIngressDelivery_threadKey_awaitingThread_completedAt_idx";

CREATE INDEX "SlackIngressDelivery_threadKey_opensThread_awaitingThread_completedAt_idx"
ON "SlackIngressDelivery"("threadKey", "opensThread", "awaitingThread", "completedAt");
