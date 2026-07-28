import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import { findRedeemableInvite } from "#server/services/members/index.js";

const INVITE_TOKEN_HEADER = "x-trema-invite-token";

export interface AuthDependencies {
  db: Database;
  env: Environment;
}

function createConfiguredAuth({ db, env }: AuthDependencies) {
  const socialProviders =
    env.TREMA_GOOGLE_CLIENT_ID && env.TREMA_GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.TREMA_GOOGLE_CLIENT_ID,
            clientSecret: env.TREMA_GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined;

  log.debug("Configuring authentication", {
    passwordEnabled: env.TREMA_PASSWORD_AUTH_ENABLED,
    googleEnabled: Boolean(socialProviders),
  });

  return betterAuth({
    database: prismaAdapter(db, {
      provider: "postgresql",
    }),
    secret: env.TREMA_AUTH_SECRET,
    baseURL: env.TREMA_AUTH_BASE_URL,
    trustedOrigins: env.TREMA_WEB_ORIGINS,
    emailAndPassword: {
      enabled: env.TREMA_PASSWORD_AUTH_ENABLED,
    },
    socialProviders,
    hooks: {
      // Account creation on a bootstrapped dedicated deployment happens through
      // member invites. Social sign-in is out of scope for this gate.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") {
          return;
        }
        if (env.TREMA_MODE === "hosted" || env.TREMA_OPEN_SIGNUP) {
          return;
        }
        // The bootstrap window: the operator creates an account before there is
        // an organization to be invited into.
        if ((await db.org.count()) === 0) {
          return;
        }

        const token = ctx.headers?.get(INVITE_TOKEN_HEADER);
        if (!token) {
          log.warn("Account creation rejected", { reason: "invite_required" });
          throw new APIError("FORBIDDEN", { message: "Account creation requires an invite" });
        }
        // Validation only — the invite is redeemed later, through the authed
        // members.invites.redeem procedure.
        const invite = await findRedeemableInvite(db, token);
        if (!invite) {
          log.warn("Account creation rejected", { reason: "invalid_invite" });
          throw new APIError("FORBIDDEN", { message: "Account creation requires an invite" });
        }
      }),
    },
    databaseHooks: {
      user: {
        update: {
          after: async (user) => {
            const { count } = await db.principal.updateMany({
              where: { authId: user.id, kind: "human" },
              data: { displayName: user.name },
            });
            log.debug("Principal display names synced", { userId: user.id, principals: count });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const principals = await db.principal.findMany({
              where: { authId: session.userId },
              select: { orgId: true },
              take: 2,
            });

            if (principals.length === 1) {
              log.debug("Session pinned to the only organization", {
                userId: session.userId,
                orgId: principals[0]?.orgId,
              });
              return {
                data: { activeOrgId: principals[0]?.orgId },
              };
            }

            log.debug("Session created without an active organization", {
              userId: session.userId,
              organizations: principals.length,
            });
          },
        },
      },
    },
    session: {
      additionalFields: {
        activeOrgId: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createConfiguredAuth>;

export function createAuth(dependencies: AuthDependencies): Auth {
  return createConfiguredAuth(dependencies);
}
