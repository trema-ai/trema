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
import {
  type ConnectorFetch,
  completeOAuthCallback,
  consumeOAuthState,
  hashOAuthState,
  type McpClientFactory,
  OAuthStateExpiredError,
  OAuthStateSingleUseError,
  OAuthTokenExchangeError,
  type PlatformAppDirectory,
  syncConnectorInstallation,
} from "./services/connectors/index.js";

// A fresh connect should surface the MCP server's tools without a manual
// sync click, but a slow provider must not hold the browser redirect hostage.
const SYNC_ON_CONNECT_TIMEOUT_MS = 8000;

export interface AppDependencies {
  db: Database;
  auth: Auth;
  env: Environment;
  connectorFetch?: ConnectorFetch;
  mcpClientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
}

export function safeConnectorReturnUrl(
  returnTo: string | null | undefined,
  webOrigins: readonly string[],
): string {
  const fallback = webOrigins[0];
  if (!fallback) throw new Error("At least one web origin is required");
  if (!returnTo) return fallback;
  try {
    const candidate = new URL(returnTo);
    const allowedOrigins = new Set(webOrigins.map((origin) => new URL(origin).origin));
    return allowedOrigins.has(candidate.origin) ? candidate.toString() : fallback;
  } catch {
    return fallback;
  }
}

function connectorErrorCode(error: unknown): string {
  if (error instanceof OAuthStateExpiredError) return error.code;
  if (error instanceof OAuthStateSingleUseError) return error.code;
  if (error instanceof OAuthTokenExchangeError) return error.code;
  return "connect_failed";
}

function withConnectorError(url: string, code: string): string {
  const redirect = new URL(url);
  redirect.searchParams.set("connector_error", code);
  return redirect.toString();
}

export function createApp({
  db,
  auth,
  env,
  connectorFetch,
  mcpClientFactory,
  platformApps,
}: AppDependencies): Hono {
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

  app.get("/connect/callback", async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const providerError = context.req.query("error");
    let returnTo: string | null | undefined;

    try {
      if (!state) throw new OAuthStateSingleUseError();
      if (providerError || !code) {
        const consumed = await consumeOAuthState(db, state);
        returnTo = consumed.returnTo;
        const destination = safeConnectorReturnUrl(returnTo, env.TREMA_WEB_ORIGINS);
        return context.redirect(withConnectorError(destination, "provider_error"));
      }
      const pending = await db.connectorOAuthState.findUnique({
        where: { stateHash: hashOAuthState(state) },
        select: { returnTo: true },
      });
      returnTo = pending?.returnTo;
      const result = await completeOAuthCallback(db, {
        state,
        code,
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        ...(env.TREMA_CREDENTIAL_MASTER_KEY ? { masterKey: env.TREMA_CREDENTIAL_MASTER_KEY } : {}),
        ...(connectorFetch ? { fetch: connectorFetch } : {}),
        ...(platformApps ? { platformApps } : {}),
      });
      returnTo = result.returnTo;
      // Best-effort tool sync: MCP installations get their tools/list right
      // away; REST providers reject sync by design and any failure is left
      // for a manual sync — neither may break the redirect.
      const sync = syncConnectorInstallation(db, {
        orgId: result.orgId,
        actorPrincipalId: result.credential.principalId,
        installationItemId: result.credential.installationItemId,
        ...(env.TREMA_CREDENTIAL_MASTER_KEY ? { masterKey: env.TREMA_CREDENTIAL_MASTER_KEY } : {}),
        ...(connectorFetch ? { fetch: connectorFetch } : {}),
        ...(mcpClientFactory ? { clientFactory: mcpClientFactory } : {}),
      }).catch(() => undefined);
      let syncTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        sync,
        new Promise<void>((resolve) => {
          syncTimer = setTimeout(resolve, SYNC_ON_CONNECT_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(syncTimer);
      return context.redirect(safeConnectorReturnUrl(returnTo, env.TREMA_WEB_ORIGINS));
    } catch (error) {
      const destination = safeConnectorReturnUrl(returnTo, env.TREMA_WEB_ORIGINS);
      return context.redirect(withConnectorError(destination, connectorErrorCode(error)));
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
        ...(connectorFetch ? { connectorFetch } : {}),
        ...(mcpClientFactory ? { mcpClientFactory } : {}),
        ...(platformApps ? { platformApps } : {}),
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
        ...(connectorFetch ? { connectorFetch } : {}),
        ...(mcpClientFactory ? { mcpClientFactory } : {}),
        ...(platformApps ? { platformApps } : {}),
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
