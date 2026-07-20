import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createPrismaClient } from "./db.js";
import { env } from "./lib/env/index.js";

const db = createPrismaClient(env.DATABASE_URL);
const app = createApp({ db });
const server = serve(
  {
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  },
  () => {
    console.info(`Server listening on http://${env.HOST}:${env.PORT}`);
  },
);

server.on("error", (error) => {
  console.error("Server failed", error);
  process.exitCode = 1;
  void db.$disconnect();
});

function shutdown(signal: NodeJS.Signals): void {
  console.info(`${signal} received, shutting down`);

  server.close((error) => {
    void db.$disconnect().finally(() => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export { app };
