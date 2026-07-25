import { serve } from "@hono/node-server";

import { createApp } from "#server/app.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { configureLogger, log } from "#server/lib/logger/index.js";
import { initializeBootstrap } from "#server/services/bootstrap/index.js";
import { loadProviderCatalog } from "#server/services/connectors/index.js";

export interface ServeDependencies {
  env: Environment;
}

export async function serveTrema({ env }: ServeDependencies) {
  // Before anything else logs: every module writes through the ambient logger.
  configureLogger(env);
  const catalog = loadProviderCatalog();
  log.info("Starting server", {
    mode: env.TREMA_MODE,
    nodeEnv: env.NODE_ENV,
    connectorProviders: catalog.length,
  });
  const db = createPrismaClient(env.DATABASE_URL);
  await initializeBootstrap({ db, env });
  const auth = createAuth({ db, env });
  const app = createApp({ db, auth, env });
  const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, () =>
    log.info("Server listening", { url: `http://${env.HOST}:${env.PORT}` }),
  );

  server.on("error", (error) => {
    log.error("Server failed", { error });
    process.exitCode = 1;
    void db.$disconnect();
  });
  const shutdown = (signal: NodeJS.Signals): void => {
    log.info("Shutting down", { signal });
    server.close((error) => {
      void db.$disconnect().finally(() => {
        if (error) {
          log.error("Shutdown failed", { error });
          process.exitCode = 1;
        }
        log.info("Shutdown complete", { signal });
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { app, auth, db, server };
}
