import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { log } from "#server/lib/logger/index.js";
import {
  BootstrapConflictError,
  getBootstrapTokenHash,
  requireNoOrganizations,
  takeBootstrapLock,
  verifyBootstrapToken,
} from "#server/services/bootstrap/index.js";
import { createOrgWithOwner } from "#server/services/org/index.js";
import { authed } from "./builders.js";

const bootstrapResult = z
  .object({
    org: z
      .object({
        id: z.string().describe("The organization's unique ID. A UUID (version 7)."),
        name: z.string().describe("The organization's display name."),
      })
      .describe("The organization that was created."),
    principal: z
      .object({
        id: z.string().describe("The principal's unique ID. A UUID (version 7)."),
        displayName: z.string().describe("The name shown for the owner principal."),
        email: z
          .string()
          .nullable()
          .describe("The owner's sign-in email. Null when no email is on file."),
      })
      .describe("The caller's owner principal in the new organization."),
  })
  .describe("The organization and owner principal created by bootstrap.");

const redeem = authed
  .route({
    method: "POST",
    path: "/bootstrap/redeem",
    summary: "Redeem the dedicated-mode bootstrap token",
    description:
      "Create the first organization on a dedicated deployment by redeeming the bootstrap token. The caller becomes the owner. Available only in dedicated mode, and only while no organization exists.",
    tags: ["Bootstrap"],
  })
  .input(
    z.object({
      token: z.string().min(1).describe("The bootstrap token for the dedicated deployment."),
      orgName: z
        .string()
        .trim()
        .min(1)
        .describe("A name for the first organization. Cannot be empty."),
    }),
  )
  .output(bootstrapResult)
  .handler(async ({ context, input }) => {
    if (context.env.TREMA_MODE !== "dedicated") {
      throw new ORPCError("FORBIDDEN", {
        message: "Bootstrap is available only in dedicated mode",
      });
    }

    const persistedHash = await getBootstrapTokenHash(context.db);
    if (!persistedHash || !verifyBootstrapToken(input.token, persistedHash)) {
      log.warn("Bootstrap token rejected");
      throw new ORPCError("FORBIDDEN", {
        message: "Invalid bootstrap token",
      });
    }

    try {
      const result = await createOrgWithOwner(
        context.db,
        {
          name: input.orgName,
          owner: {
            authId: context.session.user.id,
            displayName: context.session.user.name,
            email: context.session.user.email,
          },
        },
        {
          beforeCreate: async (transaction) => {
            await takeBootstrapLock(transaction);
            await requireNoOrganizations(transaction);
          },
          afterCreate: async (transaction, { org, ownerPrincipal }) => {
            await transaction.auditLog.create({
              data: {
                orgId: org.id,
                actorPrincipalId: ownerPrincipal.id,
                action: "org.bootstrap",
                subject: org.id,
                payload: { mode: "dedicated" },
              },
            });
            await transaction.session.update({
              where: { id: context.session.session.id },
              data: { activeOrgId: org.id },
            });
          },
        },
      );

      log.info("Organization bootstrapped", {
        orgId: result.org.id,
        principalId: result.ownerPrincipal.id,
      });

      return {
        org: result.org,
        principal: result.ownerPrincipal,
      };
    } catch (error) {
      if (error instanceof BootstrapConflictError) {
        log.warn("Bootstrap redeem rejected", { reason: "already_bootstrapped" });
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      throw error;
    }
  });

export const bootstrapRouter = {
  redeem,
};
