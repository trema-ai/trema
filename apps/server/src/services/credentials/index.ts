import { createHash, randomBytes } from "node:crypto";

import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";

export const SERVICE_CREDENTIAL_PREFIX = "trema_sc_";

export class ServiceCredentialAuthenticationError extends Error {
  constructor() {
    super("Invalid service credential");
    this.name = "ServiceCredentialAuthenticationError";
  }
}

export class ServiceCredentialNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceCredentialNotFoundError";
  }
}

export class ServiceCredentialAlreadyRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceCredentialAlreadyRevokedError";
  }
}

export function isServiceCredentialToken(token: string): boolean {
  return (
    token.startsWith(SERVICE_CREDENTIAL_PREFIX) && token.length > SERVICE_CREDENTIAL_PREFIX.length
  );
}

export function hashServiceCredentialToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreateServiceCredentialInput {
  orgId: string;
  actorPrincipalId: string;
  name: string;
}

export async function createServiceCredential(db: Database, input: CreateServiceCredentialInput) {
  const secret = `${SERVICE_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashServiceCredentialToken(secret);

  const credential = await db.$transaction(async (transaction) => {
    const agentPrincipal = await transaction.principal.findFirst({
      where: { orgId: input.orgId, kind: "agent" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!agentPrincipal) {
      throw new ServiceCredentialNotFoundError("Organization has no agent principal");
    }

    const created = await transaction.serviceCredential.create({
      data: {
        orgId: input.orgId,
        principalId: agentPrincipal.id,
        name: input.name,
        tokenHash,
        createdById: input.actorPrincipalId,
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "service_credential.create",
        subject: created.id,
        payload: {
          name: created.name,
          principalId: created.principalId,
        },
      },
    });
    log.info("Service credential issued", {
      credentialId: created.id,
      targetPrincipalId: created.principalId,
    });
    return created;
  });

  return { credential, secret };
}

export async function listServiceCredentials(db: Database, orgId: string) {
  return db.serviceCredential.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      principalId: true,
      createdAt: true,
      revokedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export interface RevokeServiceCredentialInput {
  orgId: string;
  actorPrincipalId: string;
  credentialId: string;
}

export async function revokeServiceCredential(db: Database, input: RevokeServiceCredentialInput) {
  return db.$transaction(async (transaction) => {
    const credential = await transaction.serviceCredential.findFirst({
      where: { id: input.credentialId, orgId: input.orgId },
    });
    if (!credential) {
      throw new ServiceCredentialNotFoundError("Service credential not found");
    }
    if (credential.revokedAt) {
      throw new ServiceCredentialAlreadyRevokedError("Service credential is already revoked");
    }

    const revokedAt = new Date();
    const claimed = await transaction.serviceCredential.updateMany({
      where: { id: credential.id, orgId: input.orgId, revokedAt: null },
      data: { revokedAt },
    });
    if (claimed.count !== 1) {
      throw new ServiceCredentialAlreadyRevokedError("Service credential is already revoked");
    }
    const revoked = await transaction.serviceCredential.findUniqueOrThrow({
      where: { id: credential.id, orgId: input.orgId },
      select: {
        id: true,
        name: true,
        principalId: true,
        createdAt: true,
        revokedAt: true,
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "service_credential.revoke",
        subject: revoked.id,
        payload: {
          name: revoked.name,
          principalId: revoked.principalId,
          revokedAt: revokedAt.toISOString(),
        },
      },
    });
    log.info("Service credential revoked", { credentialId: revoked.id });
    return revoked;
  });
}

export async function resolveServiceCredential(db: Database, token: string) {
  if (!isServiceCredentialToken(token)) {
    throw new ServiceCredentialAuthenticationError();
  }

  const credential = await db.serviceCredential.findUnique({
    where: { tokenHash: hashServiceCredentialToken(token) },
    include: { org: true, principal: true },
  });
  if (!credential || credential.revokedAt) {
    throw new ServiceCredentialAuthenticationError();
  }

  return credential;
}
