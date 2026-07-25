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
];

// Enough env for the server's import-time env validation; nothing connects.
const env = {
  ...process.env,
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/smoke",
  TREMA_AUTH_SECRET: "smoke-secret-0123456789abcdef",
};

for (const [dir, specifier] of checks) {
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`],
    { cwd: new URL(dir, `file://${root}`), env, stdio: "inherit" },
  );
  console.log(`ok  ${specifier}  (from ${dir})`);
}
