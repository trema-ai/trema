import type { Principal, Prisma, Role } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";

export const capabilities = [
  "read",
  "write_items",
  "install_skills",
  "manage_connectors",
  "manage_scopes",
  "edit_policies",
  "manage_schedules",
  "manage_members",
  "manage_models",
  "manage_capabilities",
  "read_audit",
  "manage_org",
] as const;

export type Capability = (typeof capabilities)[number];

export const roles = ["owner", "admin", "member", "viewer"] as const;

const capabilityRoleTable: Record<Capability, Record<Role, boolean>> = {
  read: { owner: true, admin: true, member: true, viewer: true },
  write_items: { owner: true, admin: true, member: true, viewer: false },
  // The per-scope toggle is not represented in the schema yet; default-on applies.
  install_skills: { owner: true, admin: true, member: true, viewer: false },
  manage_connectors: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  manage_scopes: { owner: true, admin: true, member: false, viewer: false },
  edit_policies: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  // An active schedule is standing authority to act with the scope's connector
  // credentials unattended, so it takes an approver-grade role.
  manage_schedules: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  manage_members: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  manage_models: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  manage_capabilities: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  read_audit: {
    owner: true,
    admin: true,
    member: false,
    viewer: false,
  },
  manage_org: { owner: true, admin: false, member: false, viewer: false },
};

export function roleAllowsCapability(role: Role, capability: Capability): boolean {
  return capabilityRoleTable[capability][role];
}

export type AuthorizePrincipal = Pick<Principal, "id" | "orgId" | "kind">;

/**
 * The roles a principal effectively holds at one scope: its own grants, the
 * org-scope grants that inherit into a shared scope, and the personal-scope
 * special case.
 *
 * A personal scope's owner holds `admin` there and nothing above it: org
 * settings and billing are the organization's question, not something owning a
 * personal scope answers. Org roles deliberately do not reach the other way
 * either — an org owner is not an owner of someone's personal scope.
 *
 * An agent principal holds no control-plane role at all, by construction.
 */
export async function effectiveRolesAtScope(
  principal: AuthorizePrincipal,
  scopeId: string,
  db: Database | Prisma.TransactionClient,
): Promise<Role[]> {
  if (principal.kind === "agent") return [];

  const scope = await db.scope.findFirst({
    where: { id: scopeId, orgId: principal.orgId },
    select: { id: true, kind: true, ownerId: true },
  });
  if (!scope) return [];

  const effectiveRoles: Role[] = [];
  if (scope.kind === "personal" && scope.ownerId === principal.id) {
    effectiveRoles.push("admin");
  }

  // Personal content does not inherit org roles; direct grants still apply.
  const scopeIds = [scope.id];
  if (scope.kind !== "personal" && scope.kind !== "org") {
    const orgScope = await db.scope.findFirst({
      where: { orgId: principal.orgId, kind: "org" },
      select: { id: true },
    });
    if (!orgScope) return effectiveRoles;
    scopeIds.push(orgScope.id);
  }

  const grants = await db.grant.findMany({
    where: {
      orgId: principal.orgId,
      principalId: principal.id,
      scopeId: { in: scopeIds },
    },
    select: { role: true },
  });
  effectiveRoles.push(...grants.map(({ role }) => role));

  return effectiveRoles;
}

export async function authorize(
  principal: AuthorizePrincipal,
  capability: Capability,
  scopeId: string,
  db: Database | Prisma.TransactionClient,
): Promise<boolean> {
  if (principal.kind === "agent") {
    log.debug("Authorization denied", { capability, reason: "agent_principal" });
    return false;
  }

  const effectiveRoles = await effectiveRolesAtScope(principal, scopeId, db);
  if (effectiveRoles.length === 0) {
    log.debug("Authorization denied", { capability, scopeId, reason: "no_effective_role" });
    return false;
  }

  return effectiveRoles.some((role) => roleAllowsCapability(role, capability));
}
