-- Approval modes replace sensitivity classes (wiki specs/context/07-permissions.md).
-- Policies become per-scope/per-connector mode ceilings; approvals record the
-- mode they paused under; thread/standing consent lands as ToolGrant rows.

CREATE TYPE "ApprovalMode" AS ENUM ('ask', 'delegated', 'full');

-- Class-keyed policy rows have no meaning under mode ceilings. The table
-- restarts empty and every scope resolves the built-in defaults until an
-- admin writes a ceiling.
DELETE FROM "Policy";
ALTER TABLE "Policy"
  DROP COLUMN "sensitivity",
  DROP COLUMN "action",
  ADD COLUMN "connectorKey" TEXT,
  ADD COLUMN "maxMode" "ApprovalMode" NOT NULL,
  ALTER COLUMN "allowRequesterApproval" SET DEFAULT true;
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_orgId_id_key" UNIQUE ("orgId", "id");
-- At most one row per (scope, connector) and one scope-wide row. Partial
-- uniques, because Prisma cannot express them and NULL connectorKey rows would
-- otherwise multiply.
CREATE UNIQUE INDEX "Policy_org_scope_connector_key"
  ON "Policy" ("orgId", "scopeId", "connectorKey")
  WHERE "connectorKey" IS NOT NULL;
CREATE UNIQUE INDEX "Policy_org_scope_default_key"
  ON "Policy" ("orgId", "scopeId")
  WHERE "connectorKey" IS NULL;
CREATE INDEX "Policy_orgId_scopeId_idx" ON "Policy" ("orgId", "scopeId");

-- Recorded approvals carry the mode they paused under. Every pre-mode row
-- paused because policy gated its class — `ask` is the honest mapping.
ALTER TABLE "Approval" ADD COLUMN "mode" "ApprovalMode" NOT NULL DEFAULT 'ask';
ALTER TABLE "Approval" ALTER COLUMN "mode" DROP DEFAULT;
ALTER TABLE "Approval"
  DROP COLUMN "sensitivity",
  ADD COLUMN "escalationReason" TEXT;

ALTER TABLE "ContextSession" ADD COLUMN "approvalMode" "ApprovalMode" NOT NULL DEFAULT 'ask';

CREATE TABLE "ToolGrant" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "toolKey" TEXT NOT NULL,
  "sessionId" TEXT,
  "requesterPrincipalId" TEXT,
  "sourceApprovalId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "ToolGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ToolGrant_orgId_id_key" ON "ToolGrant" ("orgId", "id");
CREATE INDEX "ToolGrant_orgId_sessionId_toolKey_idx" ON "ToolGrant" ("orgId", "sessionId", "toolKey");
CREATE INDEX "ToolGrant_orgId_scopeId_toolKey_idx" ON "ToolGrant" ("orgId", "scopeId", "toolKey");

ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_orgId_scopeId_fkey"
  FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope" ("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_orgId_sessionId_fkey"
  FOREIGN KEY ("orgId", "sessionId") REFERENCES "ContextSession" ("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_orgId_requesterPrincipalId_fkey"
  FOREIGN KEY ("orgId", "requesterPrincipalId") REFERENCES "Principal" ("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_orgId_sourceApprovalId_fkey"
  FOREIGN KEY ("orgId", "sourceApprovalId") REFERENCES "Approval" ("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_orgId_createdById_fkey"
  FOREIGN KEY ("orgId", "createdById") REFERENCES "Principal" ("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TYPE "Sensitivity";
DROP TYPE "PolicyAction";
