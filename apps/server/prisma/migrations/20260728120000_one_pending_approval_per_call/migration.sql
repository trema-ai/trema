-- One call waits on one decision: asking twice for the same call in the same
-- session while the first ask is still pending is one decision for a person,
-- not two. The service reads the pending row before it writes, but two
-- concurrent asks both read nothing, so the guarantee lives here. Prisma does
-- not model partial unique indexes, so this index is maintained in SQL.
CREATE UNIQUE INDEX "Approval_one_pending_per_session_call" ON "Approval"("orgId", "sessionId", "toolKey", "argsHash") WHERE "status" = 'pending';
