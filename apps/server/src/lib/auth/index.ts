import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import type { Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";

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
    databaseHooks: {
      user: {
        update: {
          after: async (user) => {
            await db.principal.updateMany({
              where: { authId: user.id, kind: "human" },
              data: { displayName: user.name },
            });
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
              return {
                data: { activeOrgId: principals[0]?.orgId },
              };
            }
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
