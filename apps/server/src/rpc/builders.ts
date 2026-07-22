import { oo } from "@orpc/openapi";
import { ORPCError, os } from "@orpc/server";

import type { Auth } from "#/lib/auth/index.js";
import type { Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";
import { authorize, type Capability } from "#/services/authorize/index.js";
import type { ConnectorFetch, PlatformAppDirectory } from "#/services/connectors/index.js";
import {
  resolveServiceCredential,
  ServiceCredentialAuthenticationError,
} from "#/services/credentials/index.js";

export interface RpcContext {
  db: Database;
  headers: Headers;
  auth: Auth;
  env: Environment;
  connectorFetch?: ConnectorFetch;
  platformApps?: PlatformAppDirectory;
}

export const pub = os.$context<RpcContext>();

export const authed = pub.use(
  oo.spec(
    pub.middleware(async ({ context, next }) => {
      const session = await context.auth.api.getSession({
        headers: context.headers,
      });

      if (!session) {
        throw new ORPCError("UNAUTHORIZED", {
          message: "Authentication required",
        });
      }

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
        throw new ORPCError("UNAUTHORIZED", {
          message: "Service credential required",
        });
      }

      try {
        const credential = await resolveServiceCredential(context.db, match[1]!);
        return next({
          context: {
            org: credential.org,
            principal: credential.principal,
          },
        });
      } catch (error) {
        if (error instanceof ServiceCredentialAuthenticationError) {
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

export const orgScoped = authed.use(async ({ context, next }) => {
  const { activeOrgId } = context.session.session;

  if (!activeOrgId) {
    throw new ORPCError("FORBIDDEN", {
      message: "No active organization",
    });
  }

  const [org, principal] = await Promise.all([
    context.db.org.findUnique({
      where: { id: activeOrgId },
    }),
    context.db.principal.findUnique({
      where: {
        orgId_authId: {
          orgId: activeOrgId,
          authId: context.session.user.id,
        },
      },
    }),
  ]);

  if (!org) {
    throw new ORPCError("FORBIDDEN", {
      message: "Active organization not found",
    });
  }

  if (!principal) {
    throw new ORPCError("FORBIDDEN", {
      message: "Principal not found in active organization",
    });
  }

  if (principal.deactivatedAt) {
    throw new ORPCError("FORBIDDEN", {
      message: "Principal is deactivated",
    });
  }

  return next({
    context: {
      org,
      principal,
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
        throw new ORPCError("FORBIDDEN", {
          message: "Organization scope not found",
        });
      }
      scopeId = orgScope.id;
    }

    if (!(await authorize(context.principal, capability, scopeId, context.db))) {
      throw new ORPCError("FORBIDDEN", {
        message: `Capability required: ${capability}`,
      });
    }

    return next({ context: { authorizedScopeId: scopeId } });
  });
}
