// Import every package's built output under plain Node, with no dev
// conditions. Dev tooling (tsx, vitest, vite) always resolves the
// "development" condition to package sources, so a broken dist mapping in
// package.json "imports"/"exports" only surfaces in production resolution.
// This script is that check. Run it after `pnpm build`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

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
  // Validates env at import time, so it also keeps the fixture below honest.
  ["apps/server", "./dist/lib/env/index.js"],
];

// A fixture that satisfies apps/server/src/lib/env/schema.ts, so that a
// failure here always means a resolution problem and never a bad fixture.
// Nothing connects. TREMA_AUTH_SECRET has a 32-character minimum, and
// TREMA_MODE is pinned to "hosted" because the schema defaults it to
// "dedicated", which additionally requires a credential master key.
const env = {
  ...process.env,
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/smoke",
  TREMA_AUTH_SECRET: "smoke-secret-0123456789abcdef0123",
  TREMA_MODE: "hosted",
};

for (const [dir, specifier] of checks) {
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`],
    { cwd: new URL(dir, `file://${root}`), env, stdio: "inherit" },
  );
  console.log(`ok  ${specifier}  (from ${dir})`);
}
