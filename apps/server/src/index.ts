import "dotenv/config";

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createPrismaClient } from "./db.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const db = createPrismaClient();
const app = createApp({ db });
const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  () => {
    console.info(`Server listening on http://${host}:${port}`);
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
