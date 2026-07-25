import type { Database } from "#/lib/db/index.js";

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;

export interface ListAuditEntriesInput {
  orgId: string;
  action?: string;
  actionPrefix?: string;
  actorPrincipalId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export async function listAuditEntries(db: Database, input: ListAuditEntriesInput) {
  const limit = input.limit ?? AUDIT_PAGE_SIZE;
  const rows = await db.auditLog.findMany({
    where: {
      orgId: input.orgId,
      ...(input.action ? { action: input.action } : {}),
      ...(input.actionPrefix ? { action: { startsWith: input.actionPrefix } } : {}),
      ...(input.actorPrincipalId ? { actorPrincipalId: input.actorPrincipalId } : {}),
      ...(input.from || input.to
        ? {
            createdAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
    },
    include: {
      actor: { select: { id: true, displayName: true, kind: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const entries = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (entries.at(-1)?.id ?? null) : null;
  return { entries, nextCursor };
}

export async function listAuditActions(db: Database, orgId: string) {
  const groups = await db.auditLog.groupBy({
    by: ["action"],
    where: { orgId },
    orderBy: { action: "asc" },
  });
  return groups.map(({ action }) => action);
}
