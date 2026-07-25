import type { Scope } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { ensurePersonalScope } from "#server/services/scopes/index.js";
import { isKnownSurface } from "#server/services/surfaces/index.js";

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
    log.warn("Unknown binding surface", { surface: input.surface });
    throw new UnknownSurfaceError(`Unknown surface: ${input.surface}`);
  }

  const target = await db.scope.findFirst({
    where: { id: input.scopeId, orgId: input.orgId },
  });
  if (!target) {
    log.warn("Binding target scope not found", { scopeId: input.scopeId });
    throw new BindingNotFoundError("Binding target scope not found");
  }
  if (target.kind === "personal") {
    log.warn("Invalid binding target", { scopeId: input.scopeId, kind: target.kind });
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
    log.warn("Binding conflict", { surface: input.surface, bindingId: existing.id });
    throw new BindingConflictError(await existingBindingMessage(db, input));
  }

  try {
    const binding = await db.$transaction(async (transaction) => {
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
    log.info("Binding created", {
      bindingId: binding.id,
      surface: binding.surface,
      scopeId: binding.scopeId,
    });
    return binding;
  } catch (error) {
    if (isUniqueViolation(error)) {
      log.warn("Binding conflict", { surface: input.surface });
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
  const binding = await db.$transaction(async (transaction) => {
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
  log.info("Binding removed", { bindingId: binding.id, surface: binding.surface });
  return binding;
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
  | { kind: "personal_disabled" }
  | { kind: "unbound" };

async function personalScopesEnabled(db: Database, orgId: string): Promise<boolean> {
  const org = await db.org.findUnique({
    where: { id: orgId },
    select: { personalScopesEnabled: true },
  });
  return org?.personalScopesEnabled ?? false;
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
    // Off means off: an existing DM binding stops resolving too. Nothing
    // is destroyed; re-enabling restores it.
    if (binding.scope.kind === "personal" && !(await personalScopesEnabled(db, input.orgId))) {
      return { kind: "personal_disabled" };
    }
    return { kind: "scope", scope: binding.scope };
  }
  if (!input.dm) {
    return { kind: "unbound" };
  }
  if (!(await personalScopesEnabled(db, input.orgId))) {
    return { kind: "personal_disabled" };
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

  const scope = await ensurePersonalScope(db, {
    orgId: input.orgId,
    principalId: identity.principal.id,
    displayName: identity.principal.displayName,
  });
  // The DM binding persists so admins can see where personal scopes are
  // reachable; a concurrent first DM loses the unique race harmlessly.
  try {
    await db.binding.create({
      data: {
        orgId: input.orgId,
        surface: input.surface,
        locationRef: input.locationRef,
        scopeId: scope.id,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return { kind: "scope", scope };
}
