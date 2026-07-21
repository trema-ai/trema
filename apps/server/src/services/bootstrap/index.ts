import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma } from "../../generated/prisma/client.js";
import type { Database } from "../../lib/db/index.js";
import type { Environment } from "../../lib/env/schema.js";

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

export async function takeBootstrapLock(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK})`;
}

export async function requireNoOrganizations(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  if ((await transaction.org.count()) !== 0) {
    throw new BootstrapConflictError();
  }
}

export interface InitializeBootstrapDependencies {
  db: Database;
  env: Environment;
  log?: (message: string) => void;
  generateToken?: () => string;
}

export interface InitializeBootstrapResult {
  generatedToken?: string;
}

export async function initializeBootstrap({
  db,
  env,
  log = console.info,
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
      return undefined;
    }

    const existing = await transaction.bootstrapToken.findUnique({
      where: { id: BOOTSTRAP_TOKEN_ID },
    });
    if (existing) {
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
    log(`Bootstrap token: ${generatedToken}`);
  }

  return generatedToken ? { generatedToken } : {};
}

export async function getBootstrapTokenHash(db: Database): Promise<string | null> {
  const token = await db.bootstrapToken.findUnique({
    where: { id: BOOTSTRAP_TOKEN_ID },
  });
  return token?.tokenHash ?? null;
}
