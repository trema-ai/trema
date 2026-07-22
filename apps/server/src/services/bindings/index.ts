import type { Scope } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { isKnownSurface } from "#/services/surfaces/index.js";

export class BindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingConflictError";
  }
}

export class BindingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingNotFoundError";
  }
}

export class BindingTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingTargetError";
  }
}

export class UnknownSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownSurfaceError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export interface CreateBindingInput {
  orgId: string;
  actorPrincipalId: string;
  surface: string;
  locationRef: string;
  scopeId: string;
}

async function existingBindingMessage(
  db: Database,
  input: Pick<CreateBindingInput, "orgId" | "surface" | "locationRef">,
) {
  const existing = await db.binding.findUnique({
    where: {
      orgId_surface_locationRef: {
        orgId: input.orgId,
        surface: input.surface,
        locationRef: input.locationRef,
      },
    },
  });
  return existing
    ? `Location ${input.surface}:${input.locationRef} is already bound by binding ${existing.id}`
    : `Location ${input.surface}:${input.locationRef} is already bound`;
}

export async function createBinding(db: Database, input: CreateBindingInput) {
  if (!isKnownSurface(input.surface)) {
    throw new UnknownSurfaceError(`Unknown surface: ${input.surface}`);
  }

  const target = await db.scope.findFirst({
    where: { id: input.scopeId, orgId: input.orgId },
  });
  if (!target) {
    throw new BindingNotFoundError("Binding target scope not found");
  }
  if (target.kind === "personal") {
    throw new BindingTargetError("Personal scopes cannot be explicit binding targets");
  }

  const existing = await db.binding.findUnique({
    where: {
      orgId_surface_locationRef: {
        orgId: input.orgId,
        surface: input.surface,
        locationRef: input.locationRef,
      },
    },
  });
  if (existing) {
    throw new BindingConflictError(await existingBindingMessage(db, input));
  }

  try {
    return await db.$transaction(async (transaction) => {
      const binding = await transaction.binding.create({
        data: {
          orgId: input.orgId,
          surface: input.surface,
          locationRef: input.locationRef,
          scopeId: input.scopeId,
        },
      });
      await transaction.auditLog.create({
        data: {
          orgId: input.orgId,
          actorPrincipalId: input.actorPrincipalId,
          action: "binding.create",
          subject: binding.id,
          payload: {
            surface: binding.surface,
            locationRef: binding.locationRef,
            scopeId: binding.scopeId,
          },
        },
      });
      return binding;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BindingConflictError(await existingBindingMessage(db, input));
    }
    throw error;
  }
}

export interface ListBindingsInput {
  orgId: string;
  surface?: string;
  scopeId?: string;
}

export async function listBindings(db: Database, input: ListBindingsInput) {
  return db.binding.findMany({
    where: {
      orgId: input.orgId,
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export interface DeleteBindingInput {
  orgId: string;
  actorPrincipalId: string;
  bindingId: string;
}

export async function deleteBinding(db: Database, input: DeleteBindingInput) {
  return db.$transaction(async (transaction) => {
    const binding = await transaction.binding.findFirst({
      where: { id: input.bindingId, orgId: input.orgId },
    });
    if (!binding) {
      throw new BindingNotFoundError("Binding not found");
    }
    await transaction.binding.delete({
      where: { id: binding.id },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "binding.delete",
        subject: binding.id,
        payload: {
          surface: binding.surface,
          locationRef: binding.locationRef,
          scopeId: binding.scopeId,
        },
      },
    });
    return binding;
  });
}

export interface ResolveLocationInput {
  orgId: string;
  surface: string;
  locationRef: string;
  dm?: { externalUserId: string };
}

export type ResolveLocationResult =
  | { kind: "scope"; scope: Scope }
  | { kind: "unlinked"; surface: string; externalUserId: string }
  | { kind: "unbound" };

async function getOrCreatePersonalScope(
  db: Database,
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

export async function resolveLocation(
  db: Database,
  input: ResolveLocationInput,
): Promise<ResolveLocationResult> {
  const binding = await db.binding.findUnique({
    where: {
      orgId_surface_locationRef: {
        orgId: input.orgId,
        surface: input.surface,
        locationRef: input.locationRef,
      },
    },
    include: { scope: true },
  });
  if (binding) {
    return { kind: "scope", scope: binding.scope };
  }
  if (!input.dm) {
    return { kind: "unbound" };
  }

  const identity = await db.identityLink.findUnique({
    where: {
      orgId_surface_externalUserId: {
        orgId: input.orgId,
        surface: input.surface,
        externalUserId: input.dm.externalUserId,
      },
    },
    include: { principal: true },
  });
  if (identity?.principal.kind !== "human") {
    return {
      kind: "unlinked",
      surface: input.surface,
      externalUserId: input.dm.externalUserId,
    };
  }

  const scope = await getOrCreatePersonalScope(db, {
    orgId: input.orgId,
    principalId: identity.principal.id,
    displayName: identity.principal.displayName,
  });
  return { kind: "scope", scope };
}
