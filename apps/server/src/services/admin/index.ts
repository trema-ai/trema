import type { Auth } from "#/lib/auth/index.js";
import type { Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";

export class AdminUserNotFoundError extends Error {
  constructor(email: string) {
    super(`No user found with email ${email}`);
    this.name = "AdminUserNotFoundError";
  }
}

export class AdminOrgResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminOrgResolutionError";
  }
}

export interface ResetPasswordDependencies {
  db: Database;
  auth: Auth;
  email: string;
  password: string;
}

export async function resetPassword({ db, auth, email, password }: ResetPasswordDependencies) {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (!found) {
    throw new AdminUserNotFoundError(email);
  }

  const passwordHash = await context.password.hash(password);
  const credential = found.accounts.find((account) => account.providerId === "credential");
  if (credential) {
    await context.internalAdapter.updatePassword(found.user.id, passwordHash);
  } else {
    await context.internalAdapter.createAccount({
      accountId: found.user.id,
      providerId: "credential",
      userId: found.user.id,
      password: passwordHash,
    });
  }

  const principals = await db.principal.findMany({
    where: { authId: found.user.id, kind: "human" },
    select: { id: true, orgId: true },
  });
  if (principals.length > 0) {
    await db.auditLog.createMany({
      data: principals.map((principal) => ({
        orgId: principal.orgId,
        actorPrincipalId: null,
        action: "admin.reset_password",
        subject: principal.id,
        payload: { actor: "host", userId: found.user.id },
      })),
    });
  }

  return { user: found.user, affectedOrgIds: principals.map(({ orgId }) => orgId) };
}

async function resolveOrg(db: Database, env: Environment, orgId?: string) {
  if (orgId) {
    const org = await db.org.findUnique({ where: { id: orgId } });
    if (!org) {
      throw new AdminOrgResolutionError(`Organization ${orgId} was not found`);
    }
    return org;
  }

  const orgs = await db.org.findMany({ take: 2, orderBy: { id: "asc" } });
  if (orgs.length === 0) {
    throw new AdminOrgResolutionError("No organization exists");
  }
  if (orgs.length > 1) {
    const detail =
      env.TREMA_MODE === "dedicated"
        ? "Dedicated mode requires one organization"
        : "Use --org <id>";
    throw new AdminOrgResolutionError(`Several organizations exist. ${detail}`);
  }
  return orgs[0]!;
}

export interface PromoteDependencies {
  db: Database;
  env: Environment;
  email: string;
  orgId?: string;
}

export async function promote({ db, env, email, orgId }: PromoteDependencies) {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new AdminUserNotFoundError(email);
  }
  const org = await resolveOrg(db, env, orgId);

  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${org.id}, 0))
    `;
    const orgScope = await transaction.scope.findFirstOrThrow({
      where: { orgId: org.id, kind: "org" },
    });
    const principal = await transaction.principal.upsert({
      where: { orgId_authId: { orgId: org.id, authId: user.id } },
      create: {
        orgId: org.id,
        kind: "human",
        authId: user.id,
        displayName: user.name,
        email: user.email,
      },
      update: {
        kind: "human",
        displayName: user.name,
        email: user.email,
      },
    });
    const grant = await transaction.grant.upsert({
      where: {
        orgId_principalId_scopeId: {
          orgId: org.id,
          principalId: principal.id,
          scopeId: orgScope.id,
        },
      },
      create: {
        orgId: org.id,
        principalId: principal.id,
        scopeId: orgScope.id,
        role: "owner",
      },
      update: { role: "owner" },
    });
    await transaction.auditLog.create({
      data: {
        orgId: org.id,
        actorPrincipalId: null,
        action: "admin.promote",
        subject: principal.id,
        payload: { actor: "host", userId: user.id, role: "owner" },
      },
    });
    return { org, principal, grant };
  });
}
