-- Persist verified Slack deliveries before acknowledging the webhook so a
-- restarted server can recover accepted work.
CREATE TABLE "SlackIngressDelivery" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "SlackIngressDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SlackIngressDelivery_completedAt_receivedAt_idx"
ON "SlackIngressDelivery"("completedAt", "receivedAt");

CREATE INDEX "SlackIngressDelivery_leaseUntil_idx"
ON "SlackIngressDelivery"("leaseUntil");
