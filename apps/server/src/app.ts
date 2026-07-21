import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Auth } from "./lib/auth/index.js";
import type { Database } from "./lib/db/index.js";
import type { Environment } from "./lib/env/schema.js";
import { generateOpenApiDocument, OPENAPI_PREFIX } from "./openapi.js";
import { router } from "./router.js";

export interface AppDependencies {
  db: Database;
  auth: Auth;
  env: Environment;
}

export function createApp({ db, auth, env }: AppDependencies): Hono {
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

  // Generate the OpenAPI document once at startup. The route below serves this
  // resolved value, so no request pays the generation cost.
  const openApiDocument = generateOpenApiDocument();

  const corsMiddleware = cors({
    origin: env.TREMA_WEB_ORIGINS,
    credentials: true,
  });

  app.use("/api/auth/*", corsMiddleware);
  app.use(`${OPENAPI_PREFIX}/*`, corsMiddleware);
  app.use("/rpc/*", corsMiddleware);

  app.on(["GET", "POST"], "/api/auth/*", (context) => {
    return auth.handler(context.req.raw);
  });

  app.get(`${OPENAPI_PREFIX}/spec.json`, async (context) => {
    return context.json(await openApiDocument);
  });

  app.use(`${OPENAPI_PREFIX}/*`, async (context, next) => {
    const { matched, response } = await openApiHandler.handle(context.req.raw, {
      prefix: OPENAPI_PREFIX,
      context: {
        db,
        headers: context.req.raw.headers,
        auth,
        env,
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
        env,
      },
    });

    if (matched) {
      return context.newResponse(response.body, response);
    }

    await next();
  });

  const webDist = env.TREMA_WEB_DIST;
  if (webDist) {
    app.use("*", serveStatic({ root: webDist }));
    app.use("*", async (context, next) => {
      if (context.req.method !== "GET" && context.req.method !== "HEAD") return next();
      const path = context.req.path;
      if (
        path === "/health" ||
        path === "/ready" ||
        path.startsWith("/api/") ||
        path.startsWith("/rpc/")
      ) {
        return next();
      }
      return serveStatic({ root: webDist, path: "index.html" })(context, next);
    });
  }

  app.notFound((context) => {
    return context.json({ error: "Not found" }, 404);
  });

  return app;
}
