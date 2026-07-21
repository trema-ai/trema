import { z } from "zod";

import { pub } from "./builders.js";

const get = pub
  .route({
    method: "GET",
    path: "/config",
    summary: "Get public deployment and sign-in configuration",
    description: "Read the public settings a sign-in page needs. No authentication required.",
    tags: ["Configuration"],
  })
  .output(
    z
      .object({
        mode: z
          .enum(["hosted", "dedicated"])
          .describe(
            "The deployment mode. `hosted` serves many organizations; `dedicated` serves one.",
          ),
        needsBootstrap: z
          .boolean()
          .describe(
            "True when the deployment is dedicated and has no organization yet. The first user must redeem the bootstrap token.",
          ),
        providers: z
          .object({
            password: z.boolean().describe("True when password sign-in is enabled."),
            google: z.boolean().describe("True when Google sign-in is configured."),
          })
          .describe("The sign-in methods the deployment offers."),
      })
      .describe("Public deployment and sign-in configuration."),
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
