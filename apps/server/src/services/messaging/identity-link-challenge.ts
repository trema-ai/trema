import { createHash, randomBytes } from "node:crypto";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import {
  SLACK_PROVIDER_KEY,
  SlackInstallationNotFoundError,
  slackExternalUserRef,
} from "#server/services/messaging/slack.js";

/** Matches connector OAuth state lifetime — short enough for single-use recovery. */
export const IDENTITY_LINK_CHALLENGE_TTL_MS = 15 * 60 * 1_000;

export class IdentityLinkChallengeNotFoundError extends Error {
  constructor(message = "Identity link challenge is invalid, expired, or already redeemed") {
    super(message);
    this.name = "IdentityLinkChallengeNotFoundError";
  }
}

export type IdentityLinkChallengeConflictReason =
  | "identity_conflict"
  | "deactivated"
  | "not_a_member";

export class IdentityLinkChallengeConflictError extends Error {
  constructor(
    message: string,
    readonly reason: IdentityLinkChallengeConflictReason,
  ) {
    super(message);
    this.name = "IdentityLinkChallengeConflictError";
  }
}

export function hashIdentityLinkChallengeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseSlackExternalUserRef(externalUserId: string) {
  const separator = externalUserId.indexOf(":");
  if (separator <= 0 || separator === externalUserId.length - 1) return undefined;
  const workspaceId = externalUserId.slice(0, separator);
  const userId = externalUserId.slice(separator + 1);
  if (!/^[A-Z][A-Z0-9]{1,31}$/.test(workspaceId) || !/^[A-Z][A-Z0-9]{1,31}$/.test(userId)) {
    return undefined;
  }
  return { workspaceId, userId };
}

export function slackIdentityLinkUrl(env: Environment, token: string): string {
  const origin = env.TREMA_WEB_ORIGINS[0]!.replace(/\/$/, "");
  return `${origin}/link/slack?token=${encodeURIComponent(token)}`;
}

export interface MintSlackIdentityLinkChallengeInput {
  orgId: string;
  workspaceId: string;
  userId: string;
  now?: Date;
}

export async function mintSlackIdentityLinkChallenge(
  db: Database,
  env: Environment,
  input: MintSlackIdentityLinkChallengeInput,
) {
  const now = input.now ?? new Date();
  const externalUserId = slackExternalUserRef(input.workspaceId, input.userId);
  const [workspaceId, userId] = externalUserId.split(":") as [string, string];

  const workspace = await db.connectorConnection.findFirst({
    where: {
      orgId: input.orgId,
      providerKey: SLACK_PROVIDER_KEY,
      revokedAt: null,
      config: { path: ["team.id"], equals: workspaceId },
      owner: { kind: "agent", deactivatedAt: null },
    },
    select: { id: true },
  });
  if (!workspace) throw new SlackInstallationNotFoundError();

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashIdentityLinkChallengeToken(token);
  const expiresAt = new Date(now.getTime() + IDENTITY_LINK_CHALLENGE_TTL_MS);

  const challenge = await db.$transaction(async (transaction) => {
    await transaction.identityLinkChallenge.deleteMany({
      where: {
        orgId: input.orgId,
        surface: SLACK_PROVIDER_KEY,
        externalUserId,
        redeemedAt: null,
      },
    });
    return transaction.identityLinkChallenge.create({
      data: {
        orgId: input.orgId,
        surface: SLACK_PROVIDER_KEY,
        externalUserId,
        tokenHash,
        expiresAt,
      },
    });
  });

  log.info("Slack identity link challenge minted", {
    challengeId: challenge.id,
    orgId: input.orgId,
    workspaceId,
    userId,
  });

  return {
    challenge,
    token,
    link: slackIdentityLinkUrl(env, token),
    workspaceId,
    userId,
  };
}

async function findRedeemableChallenge(db: Database, token: string, now = new Date()) {
  const challenge = await db.identityLinkChallenge.findUnique({
    where: { tokenHash: hashIdentityLinkChallengeToken(token) },
    include: { org: { select: { id: true, name: true } } },
  });
  if (!challenge || challenge.redeemedAt !== null || challenge.expiresAt <= now) {
    return null;
  }
  return challenge;
}

export async function previewSlackIdentityLinkChallenge(db: Database, token: string) {
  const challenge = await findRedeemableChallenge(db, token);
  if (!challenge || challenge.surface !== SLACK_PROVIDER_KEY) {
    throw new IdentityLinkChallengeNotFoundError();
  }
  const parsed = parseSlackExternalUserRef(challenge.externalUserId);
  if (!parsed) throw new IdentityLinkChallengeNotFoundError();
  return {
    orgId: challenge.org.id,
    orgName: challenge.org.name,
    surface: challenge.surface,
    workspaceId: parsed.workspaceId,
    userId: parsed.userId,
    expiresAt: challenge.expiresAt,
  };
}

export interface RedeemSlackIdentityLinkChallengeInput {
  token: string;
  authId: string;
  now?: Date;
}

export async function redeemSlackIdentityLinkChallenge(
  db: Database,
  input: RedeemSlackIdentityLinkChallengeInput,
) {
  const tokenHash = hashIdentityLinkChallengeToken(input.token);
  const now = input.now ?? new Date();

  return db.$transaction(async (transaction) => {
    const challenge = await transaction.identityLinkChallenge.findUnique({
      where: { tokenHash },
    });
    if (
      !challenge ||
      challenge.surface !== SLACK_PROVIDER_KEY ||
      challenge.redeemedAt !== null ||
      challenge.expiresAt <= now
    ) {
      log.warn("Slack identity link challenge rejected", { reason: "invalid_or_expired" });
      throw new IdentityLinkChallengeNotFoundError();
    }

    const parsed = parseSlackExternalUserRef(challenge.externalUserId);
    if (!parsed) {
      log.warn("Slack identity link challenge rejected", {
        challengeId: challenge.id,
        reason: "malformed_external_user",
      });
      throw new IdentityLinkChallengeNotFoundError();
    }

    const principal = await transaction.principal.findUnique({
      where: {
        orgId_authId: { orgId: challenge.orgId, authId: input.authId },
      },
      select: { id: true, kind: true, deactivatedAt: true },
    });
    if (principal?.kind !== "human") {
      log.warn("Slack identity link challenge rejected", {
        challengeId: challenge.id,
        reason: "not_a_member",
      });
      throw new IdentityLinkChallengeConflictError(
        "You must be an active member of this organization to link this Slack account",
        "not_a_member",
      );
    }
    if (principal.deactivatedAt !== null) {
      log.warn("Slack identity link challenge rejected", {
        challengeId: challenge.id,
        principalId: principal.id,
        reason: "deactivated",
      });
      throw new IdentityLinkChallengeConflictError(
        "A deactivated member cannot link a Slack identity",
        "deactivated",
      );
    }

    const workspace = await transaction.connectorConnection.findFirst({
      where: {
        orgId: challenge.orgId,
        providerKey: SLACK_PROVIDER_KEY,
        revokedAt: null,
        config: { path: ["team.id"], equals: parsed.workspaceId },
        owner: { kind: "agent", deactivatedAt: null },
      },
      select: { id: true },
    });
    if (!workspace) {
      log.warn("Slack identity link challenge rejected", {
        challengeId: challenge.id,
        reason: "installation_missing",
      });
      throw new SlackInstallationNotFoundError();
    }

    const existing = await transaction.identityLink.findUnique({
      where: {
        orgId_surface_externalUserId: {
          orgId: challenge.orgId,
          surface: SLACK_PROVIDER_KEY,
          externalUserId: challenge.externalUserId,
        },
      },
    });
    if (existing && existing.principalId !== principal.id) {
      log.warn("Slack identity link challenge rejected", {
        challengeId: challenge.id,
        identityLinkId: existing.id,
        reason: "conflict",
      });
      throw new IdentityLinkChallengeConflictError(
        "This Slack account is already linked to another Trema member. Ask a Trema administrator to resolve the conflict.",
        "identity_conflict",
      );
    }

    const claimed = await transaction.identityLinkChallenge.updateMany({
      where: {
        id: challenge.id,
        orgId: challenge.orgId,
        redeemedAt: null,
        expiresAt: { gt: now },
      },
      data: { redeemedAt: now },
    });
    if (claimed.count !== 1) {
      log.warn("Slack identity link challenge rejected", {
        challengeId: challenge.id,
        reason: "replay",
      });
      throw new IdentityLinkChallengeNotFoundError();
    }

    const link =
      existing ??
      (await transaction.identityLink.create({
        data: {
          orgId: challenge.orgId,
          surface: SLACK_PROVIDER_KEY,
          externalUserId: challenge.externalUserId,
          principalId: principal.id,
        },
      }));

    await transaction.auditLog.create({
      data: {
        orgId: challenge.orgId,
        actorPrincipalId: principal.id,
        action: "messaging.slack.identity.self_link",
        subject: link.id,
        payload: {
          workspaceId: parsed.workspaceId,
          userId: parsed.userId,
          principalId: principal.id,
          challengeId: challenge.id,
        },
      },
    });

    log.info("Slack identity self-linked", {
      identityLinkId: link.id,
      principalId: principal.id,
      challengeId: challenge.id,
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
    });

    return {
      orgId: challenge.orgId,
      identityLinkId: link.id,
      principalId: principal.id,
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
    };
  });
}
