import { oo } from "@orpc/openapi";
import { ORPCError, os } from "@orpc/server";
import type { Engine } from "@trema/harness";

import type { Org, Principal } from "#server/generated/prisma/client.js";
import type { Auth } from "#server/lib/auth/index.js";
import { resolveOrgPrincipal } from "#server/lib/auth/org-principal.js";
import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { bindLogger, log } from "#server/lib/logger/index.js";
import { authorize, type Capability } from "#server/services/authorize/index.js";
import type {
  ConnectorFetch,
  McpClientFactory,
  PlatformAppDirectory,
} from "#server/services/connectors/index.js";
import {
  resolveServiceCredential,
  ServiceCredentialAuthenticationError,
} from "#server/services/credentials/index.js";
import {
  authenticateSession,
  SessionAuthenticationError,
} from "#server/services/sessions/index.js";

export interface RpcContext {
  db: Database;
  headers: Headers;
  auth: Auth;
  env: Environment;
  connectorFetch?: ConnectorFetch;
  mcpClientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  /** Schedules run execution for one organization. Absent in a deployment that only serves context. */
  runEngineFor?: (orgId: string) => Engine;
}

// The procedure name and timing are bound by the handler interceptor in
// `app.ts`; the middleware below adds the ids it resolves along the way, so a
// line logged in a service carries the whole chain.
export const pub = os.$context<RpcContext>();

export const authed = pub.use(
  oo.spec(
    pub.middleware(async ({ context, next }) => {
      const session = await context.auth.api.getSession({
        headers: context.headers,
      });

      if (!session) {
        log.warn("Authentication required");
        throw new ORPCError("UNAUTHORIZED", {
          message: "Authentication required",
        });
      }

      bindLogger({ userId: session.user.id });

      return next({
        context: {
          session,
        },
      });
    }),
    { security: [{ sessionCookie: [] }] },
  ),
);

export const serviceAuthed = pub.use(
  oo.spec(
    pub.middleware(async ({ context, next }) => {
      const authorization = context.headers.get("authorization");
      const match = authorization?.match(/^Bearer (\S+)$/);
      if (!match) {
        log.warn("Service credential required");
        throw new ORPCError("UNAUTHORIZED", {
          message: "Service credential required",
        });
      }

      try {
        const credential = await resolveServiceCredential(context.db, match[1]!);
        bindLogger({
          orgId: credential.org.id,
          principalId: credential.principal.id,
          actor: "service",
        });

        return await next({
          context: {
            org: credential.org,
            principal: credential.principal,
          },
        });
      } catch (error) {
        if (error instanceof ServiceCredentialAuthenticationError) {
          log.warn("Service credential rejected");
          throw new ORPCError("UNAUTHORIZED", {
            message: "Invalid service credential",
          });
        }
        throw error;
      }
    }),
    { security: [{ serviceCredential: [] }] },
  ),
);

/** Who is calling a dual-mode route, and through which credential. */
export type IntentCaller =
  | { mode: "service"; org: Org; principal: Principal }
  | { mode: "session"; org: Org; principal: Principal };

/**
 * The intent endpoint's two auth modes on one route (harness 06): a service
 * credential in the Authorization header, or the browser's session cookie. A
 * bearer token takes the `serviceAuthed` path; its absence takes the
 * `authed`/`orgScoped` path — the same resolution steps, reused here because
 * one route cannot chain two exclusive builders. `caller.mode` is what a
 * handler branches on when the modes differ, such as who names the location.
 */
export const serviceOrSessionAuthed = pub.use(
  oo.spec(
    pub.middleware(async ({ context, next }) => {
      return next({ context: { caller: await resolveIntentCaller(context) } });
    }),
    { security: [{ serviceCredential: [] }, { sessionCookie: [] }] },
  ),
);

/** The shared resolution behind {@link serviceOrSessionAuthed}. */
async function resolveIntentCaller(context: RpcContext): Promise<IntentCaller> {
  const authorization = context.headers.get("authorization");
  const match = authorization?.match(/^Bearer (\S+)$/);
  if (match) {
    try {
      const credential = await resolveServiceCredential(context.db, match[1]!);
      bindLogger({
        orgId: credential.org.id,
        principalId: credential.principal.id,
        actor: "service",
      });
      return { mode: "service", org: credential.org, principal: credential.principal };
    } catch (error) {
      if (error instanceof ServiceCredentialAuthenticationError) {
        log.warn("Service credential rejected");
        throw new ORPCError("UNAUTHORIZED", {
          message: "Invalid service credential",
        });
      }
      throw error;
    }
  }

  const session = await context.auth.api.getSession({ headers: context.headers });
  if (!session) {
    log.warn("Authentication required");
    throw new ORPCError("UNAUTHORIZED", {
      message: "Authentication required",
    });
  }
  bindLogger({ userId: session.user.id });
  const resolved = await resolveOrgPrincipal(context.db, session);
  if (!resolved.ok) {
    throw new ORPCError("FORBIDDEN", {
      message: resolved.message,
    });
  }
  return { mode: "session", org: resolved.org, principal: resolved.principal };
}

// Session-token authentication for the session protocol itself. The middleware
// only proves possession of the token; each route decides what an expired or
// closed session may still do.
export const sessionAuthed = pub.use(
  oo.spec(
    pub.middleware(async ({ context, next }) => {
      const authorization = context.headers.get("authorization");
      const match = authorization?.match(/^Bearer (\S+)$/);
      if (!match) {
        log.warn("Session token required");
        throw new ORPCError("UNAUTHORIZED", {
          message: "Session token required",
        });
      }

      try {
        const session = await authenticateSession(context.db, match[1]!);
        bindLogger({
          orgId: session.orgId,
          principalId: session.actingPrincipalId,
          sessionId: session.id,
          actor: "session",
        });

        return await next({ context: { contextSession: session } });
      } catch (error) {
        if (error instanceof SessionAuthenticationError) {
          log.warn("Session token rejected");
          throw new ORPCError("UNAUTHORIZED", {
            message: "Invalid session token",
          });
        }
        throw error;
      }
    }),
    { security: [{ sessionToken: [] }] },
  ),
);

export const orgScoped = authed.use(async ({ context, next }) => {
  const resolved = await resolveOrgPrincipal(context.db, context.session);

  if (!resolved.ok) {
    throw new ORPCError("FORBIDDEN", {
      message: resolved.message,
    });
  }

  return next({
    context: {
      org: resolved.org,
      principal: resolved.principal,
    },
  });
});

export interface CapabilityOptions {
  scopeId?: (input: unknown) => string | undefined;
}

export function requireCapability(capability: Capability, options: CapabilityOptions = {}) {
  return orgScoped.use(async ({ context, next }, input) => {
    let scopeId = options.scopeId?.(input);
    if (!scopeId) {
      const orgScope = await context.db.scope.findFirst({
        where: { orgId: context.org.id, kind: "org" },
        select: { id: true },
      });
      if (!orgScope) {
        log.error("Organization scope not found");
        throw new ORPCError("FORBIDDEN", {
          message: "Organization scope not found",
        });
      }
      scopeId = orgScope.id;
    }

    if (!(await authorize(context.principal, capability, scopeId, context.db))) {
      log.warn("Capability denied", { capability, scopeId });
      throw new ORPCError("FORBIDDEN", {
        message: `Capability required: ${capability}`,
      });
    }

    log.debug("Capability granted", { capability, scopeId });

    return next({ context: { authorizedScopeId: scopeId } });
  });
}
