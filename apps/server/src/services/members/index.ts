import { createHash, randomBytes } from "node:crypto";

import type { Prisma, Role } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";
import { log } from "#/lib/logger/index.js";
import { ensurePersonalScope } from "#/services/scopes/index.js";

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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

async function findOrgScope(db: Database | Prisma.TransactionClient, orgId: string) {
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

export async function listInvites(db: Database, orgId: string) {
  return db.invite.findMany({
    where: {
      orgId,
      redeemedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { createdBy: true, scope: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
    if (existing?.role === "owner" && input.role !== "owner" && principal.deactivatedAt === null) {
      const owners = await transaction.grant.count({
        where: {
          orgId: input.orgId,
          scopeId: orgScope.id,
          role: "owner",
          principal: { kind: "human", orgId: input.orgId, deactivatedAt: null },
        },
      });
      if (owners <= 1) {
        log.warn("Member role change rejected", {
          targetPrincipalId: principal.id,
          reason: "last_owner",
        });
        throw new MemberConflictError("The organization's last owner cannot be demoted");
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
    log.info("Member role changed", { targetPrincipalId: principal.id, role: input.role });

    return { grant, principal };
  });
}

export interface RevokeInviteInput {
  orgId: string;
  actorPrincipalId: string;
  inviteId: string;
}

export async function revokeInvite(db: Database, input: RevokeInviteInput) {
  return db.$transaction(async (transaction) => {
    const invite = await transaction.invite.findFirst({
      where: { id: input.inviteId, orgId: input.orgId },
    });
    if (!invite) {
      throw new MemberNotFoundError("Invite not found");
    }
    if (invite.redeemedAt) {
      log.warn("Invite revoke rejected", { inviteId: invite.id, reason: "already_redeemed" });
      throw new MemberConflictError("Invite is already redeemed");
    }
    if (invite.revokedAt) {
      log.warn("Invite revoke rejected", { inviteId: invite.id, reason: "already_revoked" });
      throw new MemberConflictError("Invite is already revoked");
    }

    const revokedAt = new Date();
    const claimed = await transaction.invite.updateMany({
      where: {
        id: invite.id,
        orgId: input.orgId,
        redeemedAt: null,
        revokedAt: null,
      },
      data: { revokedAt },
    });
    if (claimed.count !== 1) {
      log.warn("Invite revoke rejected", { inviteId: invite.id, reason: "conflict" });
      throw new MemberConflictError("Invite is already redeemed or revoked");
    }
    const revoked = await transaction.invite.findUniqueOrThrow({
      where: { id: invite.id, orgId: input.orgId },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "invite.revoke",
        subject: revoked.id,
        payload: {
          role: revoked.role,
          scopeId: revoked.scopeId,
          revokedAt: revokedAt.toISOString(),
        },
      },
    });
    log.info("Invite revoked", { inviteId: revoked.id });
    return revoked;
  });
}

export interface DeactivateMemberInput {
  orgId: string;
  actorPrincipalId: string;
  principalId: string;
}

export async function deactivateMember(db: Database, input: DeactivateMemberInput) {
  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${input.orgId}, 0))
    `;

    const [orgScope, principal] = await Promise.all([
      findOrgScope(transaction, input.orgId),
      transaction.principal.findFirst({
        where: { id: input.principalId, orgId: input.orgId, kind: "human" },
      }),
    ]);
    if (!principal) {
      throw new MemberNotFoundError("Human principal not found");
    }
    if (principal.deactivatedAt) {
      log.warn("Member deactivate rejected", {
        targetPrincipalId: principal.id,
        reason: "already_deactivated",
      });
      throw new MemberConflictError("Member is already deactivated");
    }

    const orgGrant = await transaction.grant.findUnique({
      where: {
        orgId_principalId_scopeId: {
          orgId: input.orgId,
          principalId: principal.id,
          scopeId: orgScope.id,
        },
      },
    });
    if (orgGrant?.role === "owner") {
      const otherActiveOwners = await transaction.grant.count({
        where: {
          orgId: input.orgId,
          scopeId: orgScope.id,
          role: "owner",
          principalId: { not: principal.id },
          principal: { kind: "human", orgId: input.orgId, deactivatedAt: null },
        },
      });
      if (otherActiveOwners === 0) {
        log.warn("Member deactivate rejected", {
          targetPrincipalId: principal.id,
          reason: "last_owner",
        });
        throw new MemberConflictError("The organization's last owner cannot be deactivated");
      }
    }

    const deactivatedAt = new Date();
    const [deactivated, revokedCredentials, deletedIdentityLinks] = await Promise.all([
      transaction.principal.update({
        where: { id: principal.id, orgId: input.orgId },
        data: { deactivatedAt },
      }),
      transaction.serviceCredential.updateMany({
        where: { orgId: input.orgId, principalId: principal.id, revokedAt: null },
        data: { revokedAt: deactivatedAt },
      }),
      transaction.identityLink.deleteMany({
        where: { orgId: input.orgId, principalId: principal.id },
      }),
    ]);
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "principal.deactivate",
        subject: principal.id,
        payload: {
          deactivatedAt: deactivatedAt.toISOString(),
          revokedCredentialCount: revokedCredentials.count,
          deletedIdentityLinkCount: deletedIdentityLinks.count,
        },
      },
    });
    log.info("Member deactivated", { targetPrincipalId: principal.id });
    return deactivated;
  });
}

export interface ReactivateMemberInput {
  orgId: string;
  actorPrincipalId: string;
  principalId: string;
}

export async function reactivateMember(db: Database, input: ReactivateMemberInput) {
  return db.$transaction(async (transaction) => {
    const principal = await transaction.principal.findFirst({
      where: { id: input.principalId, orgId: input.orgId, kind: "human" },
    });
    if (!principal) {
      throw new MemberNotFoundError("Human principal not found");
    }
    if (!principal.deactivatedAt) {
      log.warn("Member reactivate rejected", {
        targetPrincipalId: principal.id,
        reason: "not_deactivated",
      });
      throw new MemberConflictError("Member is not deactivated");
    }

    const claimed = await transaction.principal.updateMany({
      where: { id: principal.id, orgId: input.orgId, deactivatedAt: { not: null } },
      data: { deactivatedAt: null },
    });
    if (claimed.count !== 1) {
      log.warn("Member reactivate rejected", {
        targetPrincipalId: principal.id,
        reason: "not_deactivated",
      });
      throw new MemberConflictError("Member is not deactivated");
    }
    const reactivated = await transaction.principal.findUniqueOrThrow({
      where: { id: principal.id, orgId: input.orgId },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "principal.reactivate",
        subject: principal.id,
        payload: { previousDeactivatedAt: principal.deactivatedAt.toISOString() },
      },
    });
    log.info("Member reactivated", { targetPrincipalId: principal.id });
    return reactivated;
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

export async function createInvite(db: Database, env: Environment, input: CreateInviteInput) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS);

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
    log.info("Member invited", { inviteId: created.id, role: input.role, scopeId: scope.id });
    return created;
  });

  const origin = env.TREMA_WEB_ORIGINS[0]!.replace(/\/$/, "");
  return { invite, link: `${origin}/join?token=${encodeURIComponent(token)}` };
}

export async function previewInvite(db: Database, token: string) {
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { org: true, createdBy: true },
  });
  if (!invite || invite.redeemedAt || invite.revokedAt || invite.expiresAt <= new Date()) {
    throw new MemberNotFoundError("Invite is invalid, expired, or already redeemed");
  }
  return { orgName: invite.org.name, invitedBy: invite.createdBy.displayName };
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
    if (!invite || invite.redeemedAt || invite.revokedAt || invite.expiresAt <= now) {
      log.warn("Invite redemption rejected", { reason: "invalid_or_expired" });
      throw new MemberConflictError("Invite is invalid, expired, or already redeemed");
    }

    const claimed = await transaction.invite.updateMany({
      where: {
        id: invite.id,
        orgId: invite.orgId,
        redeemedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { redeemedAt: now },
    });
    if (claimed.count !== 1) {
      log.warn("Invite redemption rejected", { inviteId: invite.id, reason: "conflict" });
      throw new MemberConflictError("Invite is invalid, expired, or already redeemed");
    }

    const existingPrincipal = await transaction.principal.findUnique({
      where: {
        orgId_authId: { orgId: invite.orgId, authId: input.authId },
      },
    });
    if (existingPrincipal?.kind === "agent") {
      log.warn("Invite redemption rejected", { inviteId: invite.id, reason: "not_human" });
      throw new MemberConflictError("Only human principals may redeem invites");
    }
    if (existingPrincipal?.deactivatedAt) {
      log.warn("Invite redemption rejected", { inviteId: invite.id, reason: "deactivated" });
      throw new MemberConflictError("A deactivated member cannot redeem an invite");
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
    const org = await transaction.org.findUniqueOrThrow({
      where: { id: invite.orgId },
      select: { personalScopesEnabled: true },
    });
    if (org.personalScopesEnabled) {
      await ensurePersonalScope(transaction, {
        orgId: invite.orgId,
        principalId: principal.id,
        displayName: principal.displayName,
      });
    }
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
    log.info("Invite accepted", {
      orgId: invite.orgId,
      inviteId: invite.id,
      targetPrincipalId: principal.id,
      role: invite.role,
    });

    return { invite: { ...invite, redeemedAt: now }, principal, grant };
  });
}
