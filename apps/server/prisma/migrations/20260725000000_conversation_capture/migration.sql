-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "locationRef" TEXT NOT NULL,
    "threadRef" TEXT NOT NULL,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "authorPrincipalId" TEXT,
    "authorExternalRef" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "surfaceMessageRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Prisma cannot express a generated column, so "tsv" is written by hand, the
-- same way "ItemSearchDoc" writes its own. A message has one field of prose,
-- so the vector carries no weights.
CREATE TABLE "MessageSearchDoc" (
    "messageId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce("text", ''))
    ) STORED,

    CONSTRAINT "MessageSearchDoc_pkey" PRIMARY KEY ("orgId","messageId")
);

-- CreateIndex
CREATE INDEX "Conversation_orgId_scopeId_idx" ON "Conversation"("orgId", "scopeId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_lastActivityAt_idx" ON "Conversation"("orgId", "lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_orgId_id_key" ON "Conversation"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_orgId_surface_locationRef_threadRef_key" ON "Conversation"("orgId", "surface", "locationRef", "threadRef");

-- CreateIndex
CREATE INDEX "Message_orgId_authorPrincipalId_idx" ON "Message"("orgId", "authorPrincipalId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_orgId_id_key" ON "Message"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_seq_key" ON "Message"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_surfaceMessageRef_key" ON "Message"("conversationId", "surfaceMessageRef");

-- CreateIndex
CREATE INDEX "MessageSearchDoc_tsv_idx" ON "MessageSearchDoc" USING GIN ("tsv");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_orgId_conversationId_fkey" FOREIGN KEY ("orgId", "conversationId") REFERENCES "Conversation"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_orgId_authorPrincipalId_fkey" FOREIGN KEY ("orgId", "authorPrincipalId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageSearchDoc" ADD CONSTRAINT "MessageSearchDoc_orgId_messageId_fkey" FOREIGN KEY ("orgId", "messageId") REFERENCES "Message"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

