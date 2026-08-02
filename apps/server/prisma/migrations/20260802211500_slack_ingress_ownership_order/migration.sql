ALTER TABLE "SlackIngressDelivery"
ADD COLUMN "ownsThread" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "SlackIngressDelivery_threadKey_ownsThread_nativeOrder_idx"
ON "SlackIngressDelivery"("threadKey", "ownsThread", "nativeOrder");
