import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import type { Database } from "./db.js";
import { router } from "./router.js";

export interface AppDependencies {
  db: Database;
}

export function createApp({ db }: AppDependencies): Hono {
  const app = new Hono();
  const rpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });

  app.get("/health", (context) => {
    return context.json({ ok: true });
  });

  app.get("/ready", async (context) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return context.json({ ok: true });
    } catch (error) {
      console.error(error);
      return context.json({ ok: false }, 503);
    }
  });

  app.use("/rpc/*", async (context, next) => {
    const { matched, response } = await rpcHandler.handle(context.req.raw, {
      prefix: "/rpc",
      context: {
        db,
        headers: context.req.raw.headers,
      },
    });

    if (matched) {
      return context.newResponse(response.body, response);
    }

    await next();
  });

  app.notFound((context) => {
    return context.json({ error: "Not found" }, 404);
  });

  return app;
}
