import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createPrismaClient } from "../src/lib/db/index.js";

// The integration suites TRUNCATE tables between tests, so the target database
// is disposable by definition. Requiring the `_test` suffix keeps a mistyped
// TEST_DATABASE_URL from wiping a dev database that happens to be reachable.
function assertTestDatabase(url: string): string {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/i.test(databaseName) || !databaseName.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must point at a dedicated database whose name ends in "_test" ` +
        `(got "${databaseName}"). Integration tests truncate tables and would destroy dev data.`,
    );
  }
  return databaseName;
}

async function ensureDatabaseExists(url: string, databaseName: string): Promise<void> {
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = "/postgres";
  const db = createPrismaClient(maintenanceUrl.toString());
  try {
    const existing = await db.$queryRaw<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname = ${databaseName}`;
    if (existing.length === 0) {
      await db.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await db.$disconnect();
  }
}

export default async function setup(): Promise<void> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    return;
  }

  const databaseName = assertTestDatabase(testDatabaseUrl);
  await ensureDatabaseExists(testDatabaseUrl, databaseName);

  const serverDirectory = fileURLToPath(new URL("../", import.meta.url));
  const prisma = fileURLToPath(new URL("../node_modules/.bin/prisma", import.meta.url));

  execFileSync(prisma, ["migrate", "deploy", "--config", "prisma.config.ts"], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
    },
    stdio: "inherit",
  });
}
