import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    return;
  }

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
