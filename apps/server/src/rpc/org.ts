import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { createOrgWithOwner, OrganizationNameError, renameOrg } from "#/services/org/index.js";
import { authed, orgScoped, requireCapability } from "./builders.js";

const orgSchema = z.object({
  id: z.string().describe("The organization's unique ID. A UUID (version 7)."),
  name: z.string().describe("The organization's display name."),
});

const principalSchema = z.object({
  id: z.string().describe("The principal's unique ID. A UUID (version 7)."),
  displayName: z.string().describe("The name shown for the principal (a person or an agent)."),
  email: z
    .string()
    .nullable()
    .describe(
      "The principal's sign-in email. Null for an agent principal or when no email is on file.",
    ),
});

const membershipSchema = z
  .object({
    org: orgSchema.describe("The organization."),
    principal: principalSchema.describe("The caller's principal in the organization."),
  })
  .describe("An organization and the caller's principal in it.");

const create = authed
  .route({
    method: "POST",
    path: "/orgs",
    summary: "Create a hosted-mode organization",
    description:
      "Create a new organization and make the caller its owner. Available only in hosted mode.",
    tags: ["Organizations"],
  })
  .input(
    z.object({
      name: z.string().trim().min(1).describe("A name for the new organization. Cannot be empty."),
    }),
  )
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
    description: "List the organizations the signed-in user belongs to.",
    tags: ["Organizations"],
  })
  .output(z.array(membershipSchema).describe("The organizations the signed-in user belongs to."))
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
    description: "Read the active organization and the caller's principal in it.",
    tags: ["Organizations"],
  })
  .output(membershipSchema)
  .handler(({ context }) => ({
    org: context.org,
    principal: context.principal,
  }));

const update = requireCapability("manage_org")
  .route({
    method: "PATCH",
    path: "/orgs/current",
    summary: "Rename the active organization",
    description: "Change the active organization's display name.",
    tags: ["Organizations"],
  })
  .input(
    z.object({
      name: z
        .string()
        .trim()
        .min(1)
        .describe("The organization's new display name. Cannot be empty."),
    }),
  )
  .output(orgSchema.describe("The renamed organization."))
  .handler(async ({ context, input }) => {
    try {
      return await renameOrg(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        name: input.name,
      });
    } catch (error) {
      if (error instanceof OrganizationNameError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    }
  });

const switchOrg = authed
  .route({
    method: "POST",
    path: "/orgs/switch",
    summary: "Switch the session's active organization",
    description: "Change which organization the session treats as active.",
    tags: ["Organizations"],
  })
  .input(
    z.object({
      orgId: z.uuid().describe("The ID of the organization to make active. A UUID."),
    }),
  )
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

    if (principal?.kind !== "human") {
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
  update,
  switch: switchOrg,
};
