import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  BootstrapConflictError,
  getBootstrapTokenHash,
  requireNoOrganizations,
  takeBootstrapLock,
  verifyBootstrapToken,
} from "../services/bootstrap/index.js";
import { createOrgWithOwner } from "../services/org/index.js";
import { authed } from "./builders.js";

const bootstrapResult = z.object({
  org: z.object({
    id: z.string(),
    name: z.string(),
  }),
  principal: z.object({
    id: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
  }),
});

const redeem = authed
  .route({
    method: "POST",
    path: "/bootstrap/redeem",
    summary: "Redeem the dedicated-mode bootstrap token",
  })
  .input(
    z.object({
      token: z.string().min(1),
      orgName: z.string().trim().min(1),
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

      return {
        org: result.org,
        principal: result.ownerPrincipal,
      };
    } catch (error) {
      if (error instanceof BootstrapConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      throw error;
    }
  });

export const bootstrapRouter = {
  redeem,
};
