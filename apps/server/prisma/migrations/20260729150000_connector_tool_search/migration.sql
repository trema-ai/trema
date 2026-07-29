CREATE TABLE "ConnectorToolSearchDoc" (
    "orgId" TEXT NOT NULL,
    "installationItemId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('trema_multilingual', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('trema_multilingual', coalesce("content", '')), 'B')
    ) STORED,
    "embedding" vector,
    "embeddingModel" TEXT,

    CONSTRAINT "ConnectorToolSearchDoc_pkey"
        PRIMARY KEY ("orgId", "installationItemId", "toolName"),
    CONSTRAINT "ConnectorToolSearchDoc_installation_fkey"
        FOREIGN KEY ("orgId", "installationItemId")
        REFERENCES "Item"("orgId", "id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ConnectorToolSearchDoc_orgId_providerKey_idx"
    ON "ConnectorToolSearchDoc"("orgId", "providerKey");
CREATE INDEX "ConnectorToolSearchDoc_tsv_idx"
    ON "ConnectorToolSearchDoc" USING GIN ("tsv");
