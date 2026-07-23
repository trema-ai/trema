# Agent rules

Workspace-wide context (what Trema is, specs, vocabulary, invariants) lives in
the parent workspace's `CLAUDE.md` and `wiki/`; these rules are repo-specific.

## Code layout

- Server infrastructure modules live under `src/lib/<module>/` with an
  `index.ts` entry (see `lib/env`, `lib/auth`, `lib/db`). Domain
  operations live under `src/services/<module>/` with the same shape
  (see `services/org`, `services/bootstrap`). oRPC procedures live in
  `src/rpc/` split per domain and call into services.
- Commits and PR titles use conventional commit format
  (`feat(web): …`, `fix(server): …`). PRs squash-merge, so the PR
  title becomes the commit message on `main`.
- No flat name-prefix files: when several files share a name prefix
  (`connector-catalog.tsx`, `connector-detail.tsx`, …), the prefix is a
  folder (`connectors/catalog.tsx`, `connectors/detail.tsx`, with the
  main screen at `index.tsx`). Hyphens are for compound names
  (`registration-dialog.tsx`), never for encoding hierarchy.

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
  mount at `/api/v1/*`, unless the endpoint is deliberately UI-only.
  The stance: anything the UI can do, a script can do through the same
  API — the CLI consumes the OpenAPI surface, so an RPC-only procedure
  silently breaks that parity.
- Route `path` values in `.route(...)` are relative to the handler mount.
  The `/api/v1` prefix lives on the mount and in the OpenAPI `servers`
  entry, so route paths stay unversioned (e.g. `/system/ping`).
- The generated OpenAPI document is served at `GET /api/v1/spec.json`
  and written to `apps/server/openapi.json` by `pnpm openapi`.
- The RPC transport stays unversioned at `/rpc`. It is the typed,
  first-party transport (clients import the `Router` type); the public,
  versioned contract is the REST surface under `/api/v1`.

## Local development

- `mise run dev` brings up the full dev stack: it creates
  `apps/server/.env` from the example on first run, starts the Postgres
  container, applies migrations, and runs the server and the web app in
  watch mode. The web app proxies `/api` and `/rpc` to the server, so
  develop against `http://localhost:5173`.
- The pieces are also individual tasks: `mise run db:up`,
  `mise run db:migrate`, `mise run dev:server`, `mise run dev:web`.
- Parallel worktrees just work: `scripts/dev-env.sh` (sourced by mise's
  `[env]`) assigns each worktree a stable slot that offsets every dev
  port (server `3000+slot`, web `5173+slot`, Postgres `5432+slot`) and
  gives linked worktrees their own compose project, so each one gets an
  isolated Postgres container and volume. The main checkout is slot 0
  (the default ports); linked worktrees hash their path into slots 1-99.
  `env:init` bakes the slot's ports into that worktree's
  `apps/server/.env`, so run `mise run dev` — not bare `pnpm dev` — the
  first time. If two worktrees ever hash to the same slot, pin one with
  `TREMA_DEV_SLOT_PIN=<n>` (delete the stale `apps/server/.env` after
  changing a slot).
- Docker resources outlive `git worktree remove`: run
  `mise run dev:clean` in a worktree before deleting it to remove its
  Postgres container, network, and data volume.

## Verification

Every change lands green on, from the repo root:

```sh
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

Integration tests run when `TEST_DATABASE_URL` points at a Postgres
database whose name ends in `_test` — they truncate tables between tests,
so the setup refuses any other name to protect dev data. `mise run test`
wires this up: it starts this worktree's Postgres and runs the suite
against a `trema_test` database on it, created on first use. Never point
`TEST_DATABASE_URL` at the dev database from `apps/server/.env`.
