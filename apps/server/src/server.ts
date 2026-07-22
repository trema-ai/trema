import { serve } from "@hono/node-server";

import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";
import { initializeBootstrap } from "#/services/bootstrap/index.js";
import { loadProviderCatalog } from "#/services/connectors/index.js";

export interface ServeDependencies {
  env: Environment;
}

export async function serveTrema({ env }: ServeDependencies) {
  loadProviderCatalog();
  const db = createPrismaClient(env.DATABASE_URL);
  await initializeBootstrap({ db, env });
  const auth = createAuth({ db, env });
  const app = createApp({ db, auth, env });
  const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, () =>
    console.info(`Server listening on http://${env.HOST}:${env.PORT}`),
  );

  server.on("error", (error) => {
    console.error("Server failed", error);
    process.exitCode = 1;
    void db.$disconnect();
  });
  const shutdown = (signal: NodeJS.Signals): void => {
    console.info(`${signal} received, shutting down`);
    server.close((error) => {
      void db.$disconnect().finally(() => {
        if (error) {
          console.error(error);
          process.exitCode = 1;
        }
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { app, auth, db, server };
}
