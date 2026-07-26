-- The embedding endpoint moves into the model provider registry: a provider row
-- plus an `embed` role default. Nothing is deployed, so the settings table is
-- dropped outright rather than migrated through an expand-and-contract window.

-- DropForeignKey
ALTER TABLE "EmbeddingSettings" DROP CONSTRAINT "EmbeddingSettings_orgId_fkey";

-- DropTable
DROP TABLE "EmbeddingSettings";
