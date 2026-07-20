import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Auth } from "./lib/auth/index.js";
import type { Database } from "./lib/db/index.js";
import { router } from "./router.js";

export interface AppDependencies {
  db: Database;
  auth: Auth;
  webOrigins: string[];
}

export function createApp({ db, auth, webOrigins }: AppDependencies): Hono {
  const app = new Hono();
  const rpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const openApiHandler = new OpenAPIHandler(router, {
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

  const corsMiddleware = cors({
    origin: webOrigins,
    credentials: true,
  });

  app.use("/api/auth/*", corsMiddleware);
  app.use("/rpc/*", corsMiddleware);

  app.on(["GET", "POST"], "/api/auth/*", (context) => {
    return auth.handler(context.req.raw);
  });

  app.use("/api/*", async (context, next) => {
    const { matched, response } = await openApiHandler.handle(context.req.raw, {
      prefix: "/api",
      context: {
        db,
        headers: context.req.raw.headers,
        auth,
      },
    });

    if (matched) {
      return context.newResponse(response.body, response);
    }

    await next();
  });

  app.use("/rpc/*", async (context, next) => {
    const { matched, response } = await rpcHandler.handle(context.req.raw, {
      prefix: "/rpc",
      context: {
        db,
        headers: context.req.raw.headers,
        auth,
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
