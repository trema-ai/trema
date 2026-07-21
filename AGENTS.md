# Agent rules

Workspace-wide context (what Trema is, specs, vocabulary, invariants) lives in
the parent workspace's `CLAUDE.md` and `wiki/`; these rules are repo-specific.

## Code layout

- Server infrastructure modules live under `src/lib/<module>/` with an
  `index.ts` entry (see `lib/env`, `lib/auth`, `lib/db`). Domain
  operations live under `src/services/<module>/` with the same shape
  (see `services/org`, `services/bootstrap`). oRPC procedures live in
  `src/rpc/` split per domain and call into services.

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
  develop against `http://127.0.0.1:5173`.
- The pieces are also individual tasks: `mise run db:up`,
  `mise run db:migrate`, `mise run dev:server`, `mise run dev:web`.

## Verification

Every change lands green on, from the repo root:

```sh
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

Integration tests run when `TEST_DATABASE_URL` points at a Postgres
database (see `compose.yaml`).
