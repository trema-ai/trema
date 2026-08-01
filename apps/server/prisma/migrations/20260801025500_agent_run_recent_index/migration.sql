-- Support the run console's organization-wide recent ordering and cursor scan.
CREATE INDEX "AgentRun_orgId_createdAt_id_idx"
ON "AgentRun"("orgId", "createdAt", "id");
