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
        openSignup: z
          .boolean()
          .describe(
            "True when the sign-in page may offer account creation without an invite. A bootstrapped dedicated deployment creates accounts through member invites instead.",
          ),
        providers: z
          .object({
            password: z.boolean().describe("True when password sign-in is enabled."),
            google: z.boolean().describe("True when Google sign-in is configured."),
          })
          .describe("The sign-in methods the deployment offers."),
        legal: z
          .object({
            termsUrl: z
              .string()
              .nullable()
              .describe("The URL of the deployment's terms of service. Null when not configured."),
            privacyUrl: z
              .string()
              .nullable()
              .describe("The URL of the deployment's privacy policy. Null when not configured."),
          })
          .describe("The legal documents the sign-in page links to."),
      })
      .describe("Public deployment and sign-in configuration."),
  )
  .handler(async ({ context }) => {
    const needsBootstrap =
      context.env.TREMA_MODE === "dedicated" && (await context.db.org.count()) === 0;

    return {
      mode: context.env.TREMA_MODE,
      needsBootstrap,
      openSignup:
        context.env.TREMA_MODE === "hosted" || context.env.TREMA_OPEN_SIGNUP || needsBootstrap,
      providers: {
        password: context.env.TREMA_PASSWORD_AUTH_ENABLED,
        google: Boolean(
          context.env.TREMA_GOOGLE_CLIENT_ID && context.env.TREMA_GOOGLE_CLIENT_SECRET,
        ),
      },
      legal: {
        termsUrl: context.env.TREMA_TERMS_URL ?? null,
        privacyUrl: context.env.TREMA_PRIVACY_URL ?? null,
      },
    };
  });

export const configRouter = {
  get,
};
