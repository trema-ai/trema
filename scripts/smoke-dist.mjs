// Import every package's built output under plain Node, with no dev
// conditions. Dev tooling (tsx, vitest, vite) always resolves the
// "development" condition to package sources, so a broken dist mapping in
// package.json "imports"/"exports" only surfaces in production resolution.
// This script is that check. Run it after `pnpm build`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep this a URL and resolve against it. Interpolating a path into a
// "file://" string breaks when the checkout path contains "#" or "?", which
// silently resolves the cwd to the wrong directory.
const repoRoot = new URL("../", import.meta.url);

// [cwd, specifier] — each import runs from inside a package that declares the
// dependency, so resolution goes through node_modules like production does.
// models transitively exercises harness; the server graph exercises
// connectors and every "#server/*" internal mapping.
const checks = [
  ["packages/harness", "@trema/harness"],
  ["packages/harness", "@trema/harness/testing"],
  ["packages/connectors", "@trema/connectors"],
  ["packages/models", "@trema/models"],
  ["apps/server", "./dist/server.js"],
  // A second entry with its own import graph; the CLI runs it.
  ["apps/server", "./dist/worker.js"],
  // Validates env at import time, so it also keeps the fixture below honest.
  ["apps/server", "./dist/lib/env/index.js"],
];

// A fixture that satisfies apps/server/src/lib/env/schema.ts, so that a
// failure here always means a resolution problem and never a bad fixture.
// Nothing connects. TREMA_AUTH_SECRET has a 32-character minimum, and
// TREMA_MODE is pinned to "hosted" because the schema defaults it to
// "dedicated", which additionally requires a credential master key.
//
// The parent environment is NOT inherited. One stray TREMA_* variable (an
// incomplete Google or OIDC pair, a malformed origin list) fails schema
// validation and reads as a resolution failure. DOTENV_CONFIG_PATH points at
// a file that does not exist for the same reason: a developer's local
// apps/server/.env must not change the result either.
const env = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  DOTENV_CONFIG_PATH: fileURLToPath(new URL("scripts/.env.absent", repoRoot)),
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/smoke",
  TREMA_AUTH_SECRET: "smoke-secret-0123456789abcdef0123",
  TREMA_MODE: "hosted",
};

for (const [dir, specifier] of checks) {
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`],
    { cwd: fileURLToPath(new URL(dir, repoRoot)), env, stdio: "inherit" },
  );
  console.log(`ok  ${specifier}  (from ${dir})`);
}
