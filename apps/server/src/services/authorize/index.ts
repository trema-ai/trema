import type { Principal, Role } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";

export const capabilities = [
  "read",
  "write_items",
  "install_skills",
  "manage_connectors",
  "manage_scopes",
  "edit_policies",
  "manage_members",
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
  manage_members: {
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

export async function authorize(
  principal: AuthorizePrincipal,
  capability: Capability,
  scopeId: string,
  db: Database,
): Promise<boolean> {
  if (principal.kind === "agent") {
    return false;
  }

  const scope = await db.scope.findFirst({
    where: { id: scopeId, orgId: principal.orgId },
    select: { id: true, kind: true, ownerId: true },
  });
  if (!scope) {
    return false;
  }

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
    if (!orgScope) {
      return false;
    }
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

  return effectiveRoles.some((role) => roleAllowsCapability(role, capability));
}
