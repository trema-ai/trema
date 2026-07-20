# Agent rules

Workspace-wide context (what Trema is, specs, vocabulary, invariants) lives in
the parent workspace's `CLAUDE.md` and `wiki/`; these rules are repo-specific.

## Code layout

- Server modules live under `src/lib/<module>/` with an `index.ts` entry
  (see `lib/env`, `lib/auth`, `lib/db`); oRPC procedures live in
  `src/rpc/` split per domain.

## Tests

- Integration tests and their helpers (global setup, fixtures) live in a
  `tests/` folder at the package root (e.g. `apps/server/tests/`). No
  filename suffix — placement is the distinction. Tests that need a
  database must skip cleanly (`describe.skip`) when `TEST_DATABASE_URL`
  is unset — the no-database local run stays green.
- Unit tests live in a `tests/` folder next to the file under test
  (e.g. `src/lib/env/tests/schema.test.ts` for `src/lib/env/schema.ts`).
  Never place a test file directly beside a source file.

## API surface

- Every oRPC procedure declares OpenAPI route metadata
  (`.route({ method, path })`) and is served through the `OpenAPIHandler`
  mount at `/api/*`, unless the endpoint is deliberately UI-only.
  The stance: anything the UI can do, a script can do through the same
  API — the CLI consumes the OpenAPI surface, so an RPC-only procedure
  silently breaks that parity.

## Verification

Every change lands green on, from the repo root:

```sh
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

Integration tests run when `TEST_DATABASE_URL` points at a Postgres
database (see `compose.yaml`).
