import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { createOrgWithOwner } from "../services/org/index.js";
import { authed, orgScoped } from "./builders.js";

const orgSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const principalSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
});

const membershipSchema = z.object({
  org: orgSchema,
  principal: principalSchema,
});

const create = authed
  .route({
    method: "POST",
    path: "/orgs",
    summary: "Create a hosted-mode organization",
  })
  .input(z.object({ name: z.string().trim().min(1) }))
  .output(membershipSchema)
  .handler(async ({ context, input }) => {
    if (context.env.TREMA_MODE !== "hosted") {
      throw new ORPCError("FORBIDDEN", {
        message: "Organization creation is available only in hosted mode",
      });
    }

    const result = await createOrgWithOwner(
      context.db,
      {
        name: input.name,
        owner: {
          authId: context.session.user.id,
          displayName: context.session.user.name,
          email: context.session.user.email,
        },
      },
      {
        afterCreate: async (transaction, { org, ownerPrincipal }) => {
          await transaction.auditLog.create({
            data: {
              orgId: org.id,
              actorPrincipalId: ownerPrincipal.id,
              action: "org.create",
              subject: org.id,
              payload: { mode: "hosted" },
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
  });

const list = authed
  .route({
    method: "GET",
    path: "/orgs",
    summary: "List the signed-in user's organizations",
  })
  .output(z.array(membershipSchema))
  .handler(async ({ context }) => {
    const principals = await context.db.principal.findMany({
      where: {
        authId: context.session.user.id,
        kind: "human",
      },
      include: { org: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    return principals.map((principal) => ({
      org: principal.org,
      principal,
    }));
  });

const current = orgScoped
  .route({
    method: "GET",
    path: "/orgs/current",
    summary: "Get the active organization and principal",
  })
  .output(membershipSchema)
  .handler(({ context }) => ({
    org: context.org,
    principal: context.principal,
  }));

const switchOrg = authed
  .route({
    method: "POST",
    path: "/orgs/switch",
    summary: "Switch the session's active organization",
  })
  .input(z.object({ orgId: z.uuid() }))
  .output(membershipSchema)
  .handler(async ({ context, input }) => {
    const principal = await context.db.principal.findUnique({
      where: {
        orgId_authId: {
          orgId: input.orgId,
          authId: context.session.user.id,
        },
      },
      include: { org: true },
    });

    if (!principal || principal.kind !== "human") {
      throw new ORPCError("FORBIDDEN", {
        message: "Principal not found in organization",
      });
    }

    await context.db.session.update({
      where: { id: context.session.session.id },
      data: { activeOrgId: input.orgId },
    });

    return {
      org: principal.org,
      principal,
    };
  });

export const orgRouter = {
  create,
  list,
  current,
  switch: switchOrg,
};
