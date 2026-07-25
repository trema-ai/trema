import { randomUUID } from "node:crypto";

import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Engine } from "@trema/harness";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Auth } from "./lib/auth/index.js";
import type { Database } from "./lib/db/index.js";
import type { Environment } from "./lib/env/schema.js";
import { log, withLogger } from "./lib/logger/index.js";
import { generateOpenApiDocument, OPENAPI_PREFIX } from "./openapi.js";
import { router } from "./router.js";
import type { RpcContext } from "./rpc/builders.js";
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
} from "./services/connectors/index.js";
import { handleDataPlaneRequest } from "./services/dataplane/mcp.js";

export interface AppDependencies {
  db: Database;
  auth: Auth;
  env: Environment;
  connectorFetch?: ConnectorFetch;
  mcpClientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  runEngineFor?: (orgId: string) => Engine;
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

function withConnected(url: string, connectionId: string): string {
  const redirect = new URL(url);
  redirect.searchParams.set("connected", connectionId);
  return redirect.toString();
}

// Probes run on a timer; their lines would drown the log at info.
const PROBE_PATHS = new Set(["/health", "/ready"]);

// A client can trigger UNAUTHORIZED or FORBIDDEN at will, so those must not
// reach the error level or a stack trace: `procedureInterceptor` already reports
// them at warn. Only a failure the server owns is an incident.
function reportUnexpected(message: string) {
  return (error: unknown): void => {
    if (error instanceof ORPCError && error.status < 500) return;
    log.error(message, { error });
  };
}

// Runs around every procedure call, so the procedure name reaches every line a
// handler or service logs. Interceptors sit outside the middleware chain, which
// keeps procedure context typing untouched.
function procedureInterceptor({
  path,
  next,
}: {
  path: readonly string[];
  next: () => Promise<unknown>;
}): Promise<unknown> {
  const startedAt = performance.now();
  return withLogger(log.child({ procedure: path.join(".") }), async () => {
    try {
      const result = await next();
      log.debug("Procedure completed", { durationMs: Math.round(performance.now() - startedAt) });
      return result;
    } catch (error) {
      // Defined failures (FORBIDDEN, CONFLICT) are outcomes, not incidents;
      // onError logs the unexpected ones with their stack.
      if (error instanceof ORPCError) {
        log.warn("Procedure rejected", {
          code: error.code,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      throw error;
    }
  });
}

export function createApp({
  db,
  auth,
  env,
  connectorFetch,
  mcpClientFactory,
  platformApps,
  runEngineFor,
}: AppDependencies): Hono {
  const app = new Hono();
  const rpcHandler = new RPCHandler<RpcContext>(router, {
    clientInterceptors: [procedureInterceptor],
    interceptors: [onError(reportUnexpected("RPC request failed"))],
  });
  const openApiHandler = new OpenAPIHandler<RpcContext>(router, {
    clientInterceptors: [procedureInterceptor],
    interceptors: [onError(reportUnexpected("API request failed"))],
  });

  // First middleware, so every route below runs inside a request-scoped logger:
  // anything a handler or service logs carries the requestId without passing it.
  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? randomUUID();
    const method = context.req.method;
    const path = context.req.path;
    const startedAt = performance.now();

    context.header("x-request-id", requestId);

    await withLogger(log.child({ requestId, method, path }), async () => {
      try {
        await next();
      } catch (error) {
        // Hono has not built a response yet, so there is no status to report.
        log.error("Request failed", {
          error,
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw error;
      }

      const details = {
        status: context.res.status,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (context.res.status >= 500) log.error("Request failed", details);
      else if (PROBE_PATHS.has(path)) log.debug("Request handled", details);
      else log.info("Request handled", details);
    });
  });

  app.get("/health", (context) => {
    return context.json({ ok: true });
  });

  app.get("/ready", async (context) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return context.json({ ok: true });
    } catch (error) {
      log.error("Readiness check failed", { error });
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
      const destination = safeConnectorReturnUrl(returnTo, env.TREMA_WEB_ORIGINS);
      return context.redirect(withConnected(destination, result.connection.id));
    } catch (error) {
      const code = connectorErrorCode(error);
      // An expired or replayed state is a user revisiting a stale callback link,
      // and the service already logged why; only an unclassified failure is ours.
      if (code === "connect_failed") log.error("Connector OAuth callback failed", { error });
      else log.warn("Connector OAuth callback failed", { code });
      const destination = safeConnectorReturnUrl(returnTo, env.TREMA_WEB_ORIGINS);
      return context.redirect(withConnectorError(destination, code));
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

  // The data plane sits on the versioned public surface beside the session
  // routes that mint its tokens. It speaks MCP rather than REST, so it is a raw
  // mount: it carries no oRPC procedures and never appears in the OpenAPI
  // document. Registered before the OpenAPI handler so the path is ours.
  app.all(`${OPENAPI_PREFIX}/mcp`, async (context) => {
    return handleDataPlaneRequest(context.req.raw, { db, env });
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
        ...(runEngineFor ? { runEngineFor } : {}),
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
        ...(runEngineFor ? { runEngineFor } : {}),
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
