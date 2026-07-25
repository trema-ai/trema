# syntax=docker/dockerfile:1

# One image serves the API and the built web assets, which is the deployment
# shape the specs commit to. It runs the "serve" and "worker" commands.
#
# The `migrate` and `doctor` commands do not work in this image: both shell out
# to the Prisma CLI, which is a devDependency and is pruned from the runtime
# stage. Apply migrations from a separate job or the build stage.

ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-slim AS base
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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The server build runs `prisma generate` first; its dependencies build with it.
RUN pnpm --filter @trema/server... build
# The web build resolves @trema/* through the production condition, so it needs
# the packages above already built.
RUN pnpm --filter @trema/web build
# `--legacy` keeps the workspace symlinked rather than injected: injected
# packages are copied, which would break the source-resolving dev loop.
# Peer checks are relaxed here only; the workspace install stays strict.
RUN pnpm deploy --legacy --filter @trema/server --prod \
    --config.strict-peer-dependencies=false /prod/server

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/trema
COPY --from=build /prod/server ./
COPY --from=build /repo/apps/web/dist ./web
ENV TREMA_WEB_DIST=/srv/trema/web
USER node
EXPOSE 3000
CMD ["node", "dist/cli.js", "serve"]
