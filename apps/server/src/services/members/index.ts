import { createHash, randomBytes } from "node:crypto";

import type { Prisma, Role } from "../../generated/prisma/client.js";
import type { Database } from "../../lib/db/index.js";
import type { Environment } from "../../lib/env/schema.js";

export class MemberConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberConflictError";
  }
}

export class MemberNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberNotFoundError";
  }
}

async function findOrgScope(
  db: Database | Prisma.TransactionClient,
  orgId: string,
) {
  return db.scope.findFirstOrThrow({
    where: { orgId, kind: "org" },
  });
}

export async function listMembers(db: Database, orgId: string) {
  const orgScope = await findOrgScope(db, orgId);
  return db.grant.findMany({
    where: {
      orgId,
      scopeId: orgScope.id,
      principal: { kind: "human", orgId },
    },
    include: { principal: true },
    orderBy: [{ principal: { displayName: "asc" } }, { principalId: "asc" }],
  });
}

export interface SetMemberRoleInput {
  orgId: string;
  actorPrincipalId: string;
  principalId: string;
  role: Role;
}

export async function setMemberRole(db: Database, input: SetMemberRoleInput) {
  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${input.orgId}, 0))
    `;

    const [orgScope, principal] = await Promise.all([
      findOrgScope(transaction, input.orgId),
      transaction.principal.findFirst({
        where: {
          id: input.principalId,
          orgId: input.orgId,
          kind: "human",
        },
      }),
    ]);
    if (!principal) {
      throw new MemberNotFoundError("Human principal not found");
    }

    const existing = await transaction.grant.findUnique({
      where: {
        orgId_principalId_scopeId: {
          orgId: input.orgId,
          principalId: principal.id,
          scopeId: orgScope.id,
        },
      },
    });
    if (existing?.role === "owner" && input.role !== "owner") {
      const owners = await transaction.grant.count({
        where: {
          orgId: input.orgId,
          scopeId: orgScope.id,
          role: "owner",
          principal: { kind: "human", orgId: input.orgId },
        },
      });
      if (owners <= 1) {
        throw new MemberConflictError(
          "The organization's last owner cannot be demoted",
        );
      }
    }

    const grant = await transaction.grant.upsert({
      where: {
        orgId_principalId_scopeId: {
          orgId: input.orgId,
          principalId: principal.id,
          scopeId: orgScope.id,
        },
      },
      create: {
        orgId: input.orgId,
        principalId: principal.id,
        scopeId: orgScope.id,
        role: input.role,
      },
      update: { role: input.role },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "grant.set_role",
        subject: grant.id,
        payload: {
          principalId: principal.id,
          scopeId: orgScope.id,
          previousRole: existing?.role ?? null,
          role: input.role,
        },
      },
    });

    return { grant, principal };
  });
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreateInviteInput {
  orgId: string;
  actorPrincipalId: string;
  role: Role;
  scopeId?: string;
  expiresAt?: Date;
}

export async function createInvite(
  db: Database,
  env: Environment,
  input: CreateInviteInput,
) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);

  const invite = await db.$transaction(async (transaction) => {
    const scope = input.scopeId
      ? await transaction.scope.findFirst({
          where: { id: input.scopeId, orgId: input.orgId },
        })
      : await findOrgScope(transaction, input.orgId);
    if (!scope) {
      throw new MemberNotFoundError("Invite scope not found");
    }

    const created = await transaction.invite.create({
      data: {
        orgId: input.orgId,
        role: input.role,
        scopeId: scope.id,
        tokenHash,
        expiresAt,
        createdById: input.actorPrincipalId,
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "invite.create",
        subject: created.id,
        payload: {
          role: input.role,
          scopeId: scope.id,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    return created;
  });

  const origin = env.TREMA_WEB_ORIGINS[0]!.replace(/\/$/, "");
  return { invite, link: `${origin}/join?token=${encodeURIComponent(token)}` };
}

export interface RedeemInviteInput {
  token: string;
  authId: string;
  displayName: string;
  email: string;
}

export async function redeemInvite(db: Database, input: RedeemInviteInput) {
  const tokenHash = hashInviteToken(input.token);

  return db.$transaction(async (transaction) => {
    const invite = await transaction.invite.findUnique({ where: { tokenHash } });
    const now = new Date();
    if (!invite || invite.redeemedAt || invite.expiresAt <= now) {
      throw new MemberConflictError(
        "Invite is invalid, expired, or already redeemed",
      );
    }

    const claimed = await transaction.invite.updateMany({
      where: {
        id: invite.id,
        orgId: invite.orgId,
        redeemedAt: null,
        expiresAt: { gt: now },
      },
      data: { redeemedAt: now },
    });
    if (claimed.count !== 1) {
      throw new MemberConflictError(
        "Invite is invalid, expired, or already redeemed",
      );
    }

    const existingPrincipal = await transaction.principal.findUnique({
      where: {
        orgId_authId: { orgId: invite.orgId, authId: input.authId },
      },
    });
    if (existingPrincipal?.kind === "agent") {
      throw new MemberConflictError("Only human principals may redeem invites");
    }
    const principal =
      existingPrincipal ??
      (await transaction.principal.create({
        data: {
          orgId: invite.orgId,
          kind: "human",
          authId: input.authId,
          displayName: input.displayName,
          email: input.email,
        },
      }));
    const grant = await transaction.grant.upsert({
      where: {
        orgId_principalId_scopeId: {
          orgId: invite.orgId,
          principalId: principal.id,
          scopeId: invite.scopeId,
        },
      },
      create: {
        orgId: invite.orgId,
        principalId: principal.id,
        scopeId: invite.scopeId,
        role: invite.role,
      },
      update: { role: invite.role },
    });
    await transaction.invite.update({
      where: { id: invite.id, orgId: invite.orgId },
      data: { redeemedById: principal.id },
    });
    await transaction.auditLog.create({
      data: {
        orgId: invite.orgId,
        actorPrincipalId: principal.id,
        action: "invite.redeem",
        subject: invite.id,
        payload: {
          scopeId: invite.scopeId,
          role: invite.role,
          principalId: principal.id,
        },
      },
    });

    return { invite: { ...invite, redeemedAt: now }, principal, grant };
  });
}
