-- A scope holds at most one active instruction: the instruction is the
-- scope's system-prompt addendum, edited in place and versioned rather than
-- accumulated. Prisma does not model partial unique indexes, so this index
-- is maintained in SQL.
CREATE UNIQUE INDEX "Item_one_active_instruction_per_scope" ON "Item"("orgId", "scopeId") WHERE "kind" = 'instruction' AND "status" = 'active';
