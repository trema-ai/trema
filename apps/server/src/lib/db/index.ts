import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#/generated/prisma/client.js";
import { log } from "#/lib/logger/index.js";

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  // The URL carries the password; only the target is safe to log.
  const { host, pathname } = new URL(databaseUrl);
  log.debug("Database client created", { host, database: pathname.slice(1) });

  return new PrismaClient({ adapter });
}

export type Database = PrismaClient;
