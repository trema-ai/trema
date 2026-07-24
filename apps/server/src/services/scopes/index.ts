import type { Prisma, Scope, ScopeKind } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";

type ScopeDatabase = Database | Prisma.TransactionClient;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export class ScopeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeNotFoundError";
  }
}

export class ScopeNotRenameableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeNotRenameableError";
  }
}

export interface CreateSharedScopeInput {
  orgId: string;
  actorPrincipalId: string;
  name: string;
}

export async function ensurePersonalScope(
  db: ScopeDatabase,
  input: { orgId: string; principalId: string; displayName: string },
): Promise<Scope> {
  const existing = await db.scope.findFirst({
    where: {
      orgId: input.orgId,
      kind: "personal",
      ownerId: input.principalId,
    },
  });
  if (existing) return existing;

  try {
    return await db.scope.create({
      data: {
        orgId: input.orgId,
        kind: "personal",
        ownerId: input.principalId,
        name: input.displayName,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return db.scope.findFirstOrThrow({
      where: {
        orgId: input.orgId,
        kind: "personal",
        ownerId: input.principalId,
      },
    });
  }
}

export async function createSharedScope(db: Database, input: CreateSharedScopeInput) {
  const scope = await db.$transaction(async (transaction) => {
    const scope = await transaction.scope.create({
      data: { orgId: input.orgId, kind: "shared", name: input.name },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "scope.create",
        subject: scope.id,
        payload: { kind: scope.kind, name: scope.name },
      },
    });
    return scope;
  });
  log.info("Scope created", { scopeId: scope.id, kind: scope.kind });
  return scope;
}

export async function listScopes(db: Database, orgId: string, kind?: ScopeKind) {
  return db.scope.findMany({
    where: { orgId, ...(kind ? { kind } : {}) },
    select: { id: true, kind: true, name: true, ownerId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function getScope(db: Database, orgId: string, scopeId: string) {
  const scope = await db.scope.findFirst({
    where: { id: scopeId, orgId },
    select: { id: true, kind: true, name: true, ownerId: true },
  });
  if (!scope) {
    log.warn("Scope resolution failed", { scopeId });
    throw new ScopeNotFoundError("Scope not found");
  }
  return scope;
}

export async function getPersonalPolicy(db: Database, orgId: string) {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { personalScopesEnabled: true },
  });
  return { enabled: org.personalScopesEnabled };
}

export interface SetPersonalPolicyInput {
  orgId: string;
  actorPrincipalId: string;
  enabled: boolean;
}

export async function setPersonalPolicy(db: Database, input: SetPersonalPolicyInput) {
  return db.$transaction(async (transaction) => {
    const org = await transaction.org.update({
      where: { id: input.orgId },
      data: { personalScopesEnabled: input.enabled },
      select: { personalScopesEnabled: true },
    });
    if (org.personalScopesEnabled) {
      const humans = await transaction.principal.findMany({
        where: { orgId: input.orgId, kind: "human" },
        select: { id: true, displayName: true },
      });
      for (const principal of humans) {
        await ensurePersonalScope(transaction, {
          orgId: input.orgId,
          principalId: principal.id,
          displayName: principal.displayName,
        });
      }
    }
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "scope.personal_policy",
        subject: input.orgId,
        payload: { enabled: input.enabled },
      },
    });
    return { enabled: org.personalScopesEnabled };
  });
}

export interface RenameSharedScopeInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  name: string;
}

export async function renameSharedScope(db: Database, input: RenameSharedScopeInput) {
  const scope = await db.$transaction(async (transaction) => {
    const existing = await transaction.scope.findFirst({
      where: { id: input.scopeId, orgId: input.orgId },
    });
    if (!existing) {
      throw new ScopeNotFoundError("Scope not found");
    }
    if (existing.kind !== "shared") {
      throw new ScopeNotRenameableError("Only shared scopes can be renamed");
    }

    const scope = await transaction.scope.update({
      where: { orgId_id: { orgId: input.orgId, id: input.scopeId } },
      data: { name: input.name },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "scope.rename",
        subject: scope.id,
        payload: { previousName: existing.name, name: scope.name },
      },
    });
    return scope;
  });
  log.info("Scope renamed", { scopeId: scope.id });
  return scope;
}
