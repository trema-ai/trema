import { z } from "zod";

import { pub } from "./builders.js";

const get = pub
  .route({
    method: "GET",
    path: "/config",
    summary: "Get public deployment and sign-in configuration",
  })
  .output(
    z.object({
      mode: z.enum(["hosted", "dedicated"]),
      needsBootstrap: z.boolean(),
      providers: z.object({
        password: z.boolean(),
        google: z.boolean(),
      }),
    }),
  )
  .handler(async ({ context }) => ({
    mode: context.env.TREMA_MODE,
    needsBootstrap: context.env.TREMA_MODE === "dedicated" && (await context.db.org.count()) === 0,
    providers: {
      password: context.env.TREMA_PASSWORD_AUTH_ENABLED,
      google: Boolean(context.env.TREMA_GOOGLE_CLIENT_ID && context.env.TREMA_GOOGLE_CLIENT_SECRET),
    },
  }));

export const configRouter = {
  get,
};
