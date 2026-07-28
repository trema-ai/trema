#!/usr/bin/env bash
# Verify that the built image resolves and runs what it ships.
#
# The image is the only place production module resolution is exercised. Dev
# tooling (tsx, vitest, vite, tsc) resolves the "development" condition to
# package sources, so a broken dist mapping in a package.json "imports" or
# "exports" field appears nowhere else in CI. The image checks it in a pruned
# production install: no devDependencies, no package sources, and workspace
# packages copied rather than symlinked.
#
# Usage: scripts/verify-image.sh [image-tag]
set -euo pipefail

image="${1:-trema:ci}"

# A fixture that satisfies apps/server/src/lib/env/schema.ts, so a failure here
# always means a resolution problem. TREMA_AUTH_SECRET has a 32-character
# minimum, and TREMA_MODE is pinned because the schema defaults it to
# "dedicated", which additionally requires a credential master key.
docker run --rm \
  --env DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/verify" \
  --env TREMA_AUTH_SECRET="verify-secret-0123456789abcdef0123" \
  --env TREMA_MODE="hosted" \
  "$image" node --input-type=module -e '
    // Entry points. cli.js reaches server.js and worker.js and guards its own
    // execution; lib/env/index.js validates env at import time, which also
    // keeps the fixture above honest.
    const entries = [
      "./dist/cli.js",
      "./dist/server.js",
      "./dist/worker.js",
      "./dist/lib/env/index.js",
    ];
    // Workspace packages by bare specifier, which exercises each exports field
    // through node_modules. "./testing" is a subpath nothing in production
    // imports, so this is the only check of its dist mapping.
    const packages = [
      "@trema/harness",
      "@trema/harness/testing",
      "@trema/connectors",
      "@trema/models",
    ];
    for (const specifier of [...entries, ...packages]) {
      await import(specifier);
      console.log(`ok  ${specifier}`);
    }
  '

# No package sources in the image, so nothing can resolve the "development"
# condition by accident: it would fail loudly instead of silently working.
docker run --rm --entrypoint sh "$image" -c '
  set -eu
  test ! -d /srv/trema/src
  test -z "$(find /srv/trema/node_modules/@trema -name "*.ts" -print -quit)"
'
echo "ok  no package sources shipped"

# The image serves the web build itself, so the assets must be in it.
docker run --rm --entrypoint sh "$image" -c 'test -f /srv/trema/web/index.html'
echo "ok  web assets"

# `migrate` and `doctor` shell out to the Prisma CLI, which must survive the
# pruned production install as a runtime dependency. Run both against a
# throwaway postgres to prove the image applies the checked-in migrations.
network="verify-image-net-$$"
postgres="verify-image-pg-$$"
cleanup() {
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run --detach --name "$postgres" --network "$network" \
  --env POSTGRES_DB=verify \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --health-cmd "pg_isready -U postgres -d verify" \
  --health-interval 1s \
  --health-retries 60 \
  pgvector/pgvector:pg16 >/dev/null

# Fail fast rather than hang: docker marks the container unhealthy after the
# health retries run out, and the loop is bounded in case it never gets there.
for attempt in $(seq 1 120); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$postgres")"
  [ "$health" = "healthy" ] && break
  if [ "$health" = "unhealthy" ]; then
    echo "postgres went unhealthy while waiting" >&2
    exit 1
  fi
  if [ "$attempt" -eq 120 ]; then
    echo "postgres not healthy after ${attempt}s" >&2
    exit 1
  fi
  sleep 1
done

for command in migrate doctor; do
  docker run --rm --network "$network" \
    --env DATABASE_URL="postgresql://postgres:postgres@${postgres}:5432/verify" \
    --env TREMA_AUTH_SECRET="verify-secret-0123456789abcdef0123" \
    --env TREMA_MODE="hosted" \
    "$image" node dist/cli.js "$command"
  echo "ok  trema $command"
done
