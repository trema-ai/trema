#!/usr/bin/env node
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient, type Database } from "#/lib/db/index.js";
import { type Environment, parseEnv } from "#/lib/env/schema.js";
import { serveTrema } from "#/server.js";
import { promote, resetPassword } from "#/services/admin/index.js";
import { mintBootstrapToken } from "#/services/bootstrap/index.js";

const USAGE = `Usage: trema [command]

Commands:
  serve
  admin reset-password <email> --password <password>
  admin promote <email> [--org <id>]
  bootstrap-token
  migrate
  doctor`;

const serverDirectory = fileURLToPath(new URL("../", import.meta.url));
const prismaExecutable = fileURLToPath(new URL("../node_modules/.bin/prisma", import.meta.url));

export interface ProcessResult {
  status: number | null;
  error?: Error;
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => ProcessResult;

const runProcess: ProcessRunner = (executable, args, options) =>
  spawnSync(executable, args, options) as SpawnSyncReturns<Buffer>;

export interface MigrateDependencies {
  env: Environment;
  cwd?: string;
  prisma?: string;
  run?: ProcessRunner;
}

export function migrate({
  env,
  cwd = serverDirectory,
  prisma = prismaExecutable,
  run = runProcess,
}: MigrateDependencies): void {
  const result = run(prisma, ["migrate", "deploy", "--config", "prisma.config.ts"], {
    cwd,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Migration failed with exit code ${result.status}`);
  console.info("Migrations applied");
}

export interface DoctorDependencies {
  db: Database;
  env: Environment;
  cwd?: string;
  prisma?: string;
  run?: ProcessRunner;
  log?: (message: string) => void;
}

export async function doctor({
  db,
  env,
  cwd = serverDirectory,
  prisma = prismaExecutable,
  run = runProcess,
  log = console.info,
}: DoctorDependencies): Promise<void> {
  log("Environment: valid");
  await db.$queryRaw`SELECT 1`;
  log("Database: reachable");
  const result = run(prisma, ["migrate", "status", "--config", "prisma.config.ts"], {
    cwd,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Migrations: pending or migration status failed");
  log("Migrations: applied");
  log(`Organizations: ${await db.org.count()}`);
}

function requirePositionals(values: string[], count: number): void {
  if (values.length !== count) throw new Error(USAGE);
}

export async function runCli(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const command = argv[0] ?? "serve";
  const knownCommand = ["serve", "admin", "bootstrap-token", "migrate", "doctor"].includes(command);
  const knownAdminCommand =
    command !== "admin" || argv[1] === "reset-password" || argv[1] === "promote";
  if (!knownCommand || !knownAdminCommand) throw new Error(USAGE);

  if (command === "serve") {
    if (argv.length > 1) throw new Error(USAGE);
    await serveTrema({ env: parseEnv(environment) });
    return;
  }

  const env = parseEnv(environment);
  if (command === "migrate") {
    requirePositionals(argv, 1);
    migrate({ env });
    return;
  }

  const db = createPrismaClient(env.DATABASE_URL);
  try {
    if (command === "bootstrap-token") {
      requirePositionals(argv, 1);
      const token = await mintBootstrapToken({ db });
      process.stdout.write(`${token}\n`);
      console.error("Bootstrap token hash stored for the empty deployment");
      return;
    }
    if (command === "doctor") {
      requirePositionals(argv, 1);
      await doctor({ db, env });
      return;
    }
    if (command === "admin" && argv[1] === "reset-password") {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: true,
        strict: true,
        options: { password: { type: "string" } },
      });
      requirePositionals(parsed.positionals, 1);
      if (!parsed.values.password) throw new Error("--password is required");
      const auth = createAuth({ db, env });
      const result = await resetPassword({
        db,
        auth,
        email: parsed.positionals[0]!,
        password: parsed.values.password,
      });
      console.info(`Password reset for ${result.user.email}`);
      return;
    }
    if (command === "admin" && argv[1] === "promote") {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: true,
        strict: true,
        options: { org: { type: "string" } },
      });
      requirePositionals(parsed.positionals, 1);
      const result = await promote({
        db,
        env,
        email: parsed.positionals[0]!,
        ...(parsed.values.org ? { orgId: parsed.values.org } : {}),
      });
      console.info(`Promoted ${result.principal.email} to owner of ${result.org.name}`);
      return;
    }
    throw new Error(USAGE);
  } finally {
    await db.$disconnect();
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
