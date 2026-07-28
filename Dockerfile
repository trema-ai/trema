# syntax=docker/dockerfile:1

# One image serves the API and the built web assets, which is the deployment
# shape the specs commit to. It runs every CLI command, including `migrate` and
# `doctor`: the Prisma CLI is a runtime dependency so migrations apply from
# this image with no network access and no extra tooling.

ARG NODE_VERSION=24.18.0

# The Prisma install downloads the schema engine that matches the detected
# libssl. Without the openssl binary, detection falls back to openssl-1.1.x,
# which must not diverge from what the runtime stage detects: `migrate` would
# try to download the matching engine at run time, which fails in a read-only
# install and can never work air-gapped. The build and runtime stages both
# descend from this one, so the two detections agree by construction rather
# than by two apt lines kept in step by hand.
FROM node:${NODE_VERSION}-slim AS osbase
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM osbase AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Manifests first, so a source-only change reuses the install layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/docs/package.json apps/docs/
COPY packages/connectors/package.json packages/connectors/
COPY packages/harness/package.json packages/harness/
COPY packages/models/package.json packages/models/
# Every workspace manifest is copied so `--frozen-lockfile` still agrees with
# the lockfile, but only the two projects the image ships get installed: the
# docs app pulls wrangler, workerd and miniflare, a quarter of a gigabyte that
# never reaches the image. The store cache is keyed by architecture so the two
# halves of a multi-arch build do not contend on one mount.
ARG TARGETARCH
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store \
    pnpm install --frozen-lockfile \
    --filter @trema/server... --filter @trema/web...

# Server sources only, so a web-only change reuses `prisma generate` and the
# server compile.
FROM deps AS server
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/
# The server build runs `prisma generate` first; its dependencies build with it.
RUN pnpm --filter @trema/server... build

# Pruning the production install and building the web assets both need the
# server build and nothing from each other, so the two stages below run
# concurrently instead of in sequence.

# `--legacy` keeps the workspace symlinked rather than injected: injected
# packages are copied, which would break the source-resolving dev loop.
# Peer checks are relaxed here only; the workspace install stays strict.
FROM server AS prod-deps
ARG TARGETARCH
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store \
    pnpm deploy --legacy --filter @trema/server --prod \
    --config.strict-peer-dependencies=false /prod/server

# The web build resolves @trema/* through the production condition, so it needs
# the packages above already built.
FROM server AS web
COPY apps/web/ apps/web/
RUN pnpm --filter @trema/web build

FROM osbase AS runtime
ENV NODE_ENV=production
# The Prisma CLI phones home unless told not to; air-gapped deployments would
# only see it as a hung request.
ENV CHECKPOINT_DISABLE=1
WORKDIR /srv/trema
COPY --from=prod-deps /prod/server ./
COPY --from=web /repo/apps/web/dist ./web
ENV TREMA_WEB_DIST=/srv/trema/web
# The CLI on PATH, so `docker exec <container> trema <command>` works.
RUN printf '#!/bin/sh\nexec node /srv/trema/dist/cli.js "$@"\n' > /usr/local/bin/trema \
    && chmod 755 /usr/local/bin/trema
USER node
EXPOSE 3000
CMD ["trema", "serve"]
