import { ORPCError, os } from "@orpc/server";

import type { Auth } from "../lib/auth/index.js";
import type { Database } from "../lib/db/index.js";

export interface RpcContext {
  db: Database;
  headers: Headers;
  auth: Auth;
}

export const pub = os.$context<RpcContext>();

export const authed = pub.use(async ({ context, next }) => {
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
});

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

  return next({
    context: {
      org,
      principal,
    },
  });
});
