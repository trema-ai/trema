import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { type Logger, log } from "#server/lib/logger/index.js";

const BOOTSTRAP_TOKEN_ID = "bootstrap";
const BOOTSTRAP_ADVISORY_LOCK = 8_451_772_003;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export class BootstrapConflictError extends Error {
  constructor() {
    super("Organization bootstrap is no longer available");
    this.name = "BootstrapConflictError";
  }
}

export function hashBootstrapToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyBootstrapToken(token: string, persistedHash: string): boolean {
  const candidate = Buffer.from(hashBootstrapToken(token), "hex");
  const validPersistedHash = SHA256_HEX.test(persistedHash);
  const expected = validPersistedHash
    ? Buffer.from(persistedHash, "hex")
    : Buffer.alloc(candidate.length);

  return timingSafeEqual(candidate, expected) && validPersistedHash;
}

export async function takeBootstrapLock(transaction: Prisma.TransactionClient): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK})`;
  log.debug("Bootstrap lock acquired");
}

export async function requireNoOrganizations(transaction: Prisma.TransactionClient): Promise<void> {
  if ((await transaction.org.count()) !== 0) {
    log.warn("Bootstrap rejected", { reason: "organization_exists" });
    throw new BootstrapConflictError();
  }
}

export interface InitializeBootstrapDependencies {
  db: Database;
  env: Environment;
  logger?: Logger;
  generateToken?: () => string;
}

export interface InitializeBootstrapResult {
  generatedToken?: string;
}

export interface MintBootstrapTokenDependencies {
  db: Database;
  generateToken?: () => string;
}

export async function mintBootstrapToken({
  db,
  generateToken = () => randomBytes(32).toString("base64url"),
}: MintBootstrapTokenDependencies): Promise<string> {
  return db.$transaction(async (transaction) => {
    await takeBootstrapLock(transaction);
    await requireNoOrganizations(transaction);

    const token = generateToken();
    await transaction.bootstrapToken.upsert({
      where: { id: BOOTSTRAP_TOKEN_ID },
      create: { id: BOOTSTRAP_TOKEN_ID, tokenHash: hashBootstrapToken(token) },
      update: { tokenHash: hashBootstrapToken(token) },
    });
    log.info("Bootstrap token minted");
    return token;
  });
}

export async function initializeBootstrap({
  db,
  env,
  logger = log,
  generateToken = () => randomBytes(32).toString("base64url"),
}: InitializeBootstrapDependencies): Promise<InitializeBootstrapResult> {
  if (env.TREMA_MODE !== "dedicated" || (await db.org.count()) !== 0) {
    return {};
  }

  const generatedToken = await db.$transaction(async (transaction) => {
    await takeBootstrapLock(transaction);

    if ((await transaction.org.count()) !== 0) {
      return undefined;
    }

    if (env.TREMA_BOOTSTRAP_TOKEN) {
      await transaction.bootstrapToken.upsert({
        where: { id: BOOTSTRAP_TOKEN_ID },
        create: {
          id: BOOTSTRAP_TOKEN_ID,
          tokenHash: hashBootstrapToken(env.TREMA_BOOTSTRAP_TOKEN),
        },
        update: {
          tokenHash: hashBootstrapToken(env.TREMA_BOOTSTRAP_TOKEN),
        },
      });
      log.info("Bootstrap token stored from configuration");
      return undefined;
    }

    const existing = await transaction.bootstrapToken.findUnique({
      where: { id: BOOTSTRAP_TOKEN_ID },
    });
    if (existing) {
      log.info("Bootstrap token kept");
      return undefined;
    }

    const token = generateToken();
    await transaction.bootstrapToken.create({
      data: {
        id: BOOTSTRAP_TOKEN_ID,
        tokenHash: hashBootstrapToken(token),
      },
    });
    return token;
  });

  if (generatedToken) {
    // The only time the token is readable: it is stored as a hash.
    logger.info("Bootstrap token generated", { bootstrapToken: generatedToken });
  }

  return generatedToken ? { generatedToken } : {};
}

export async function getBootstrapTokenHash(db: Database): Promise<string | null> {
  const token = await db.bootstrapToken.findUnique({
    where: { id: BOOTSTRAP_TOKEN_ID },
  });
  return token?.tokenHash ?? null;
}
