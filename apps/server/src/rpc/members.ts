import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  createInvite,
  deactivateMember,
  listInvites,
  listMembers,
  MemberConflictError,
  MemberNotFoundError,
  previewInvite,
  reactivateMember,
  redeemInvite,
  revokeInvite,
  setMemberRole,
} from "#/services/members/index.js";
import { authed, pub, requireCapability } from "./builders.js";

const roleSchema = z
  .enum(["owner", "admin", "member", "viewer"])
  .describe(
    "The role granted on a scope. It sets the member's capabilities. One of `owner`, `admin`, `member`, or `viewer`.",
  );
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
const memberSchema = z
  .object({
    principal: principalSchema.describe("The member's principal."),
    role: roleSchema.describe("The member's role on the organization scope."),
    status: z
      .enum(["active", "deactivated"])
      .describe("Whether the member can authenticate and act in the organization."),
    joinedAt: z
      .string()
      .describe("When the member joined the organization. An ISO 8601 date-time."),
  })
  .describe("A member of the organization and the role they hold.");

const list = requireCapability("read")
  .route({
    method: "GET",
    path: "/members",
    summary: "List organization members",
    description: "List the human members of the active organization.",
    tags: ["Members"],
  })
  .output(z.array(memberSchema).describe("The human members of the active organization."))
  .handler(async ({ context }) =>
    (await listMembers(context.db, context.org.id)).map(({ principal, role, createdAt }) => ({
      principal,
      role,
      status: principal.deactivatedAt ? ("deactivated" as const) : ("active" as const),
      joinedAt: createdAt.toISOString(),
    })),
  );

const setRole = requireCapability("manage_members")
  .route({
    method: "POST",
    path: "/members/role",
    summary: "Set an organization member's role",
    description:
      "Change a member's role in the active organization. The organization's last owner cannot be demoted.",
    tags: ["Members"],
  })
  .input(
    z.object({
      principalId: z.uuid().describe("The ID of the member's principal. A UUID."),
      role: roleSchema.describe("The role to assign to the member."),
    }),
  )
  .output(memberSchema)
  .handler(async ({ context, input }) => {
    try {
      const result = await setMemberRole(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        principalId: input.principalId,
        role: input.role,
      });
      return {
        principal: result.principal,
        role: result.grant.role,
        status: result.principal.deactivatedAt ? "deactivated" : "active",
        joinedAt: result.grant.createdAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof MemberConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      if (error instanceof MemberNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const inviteList = requireCapability("manage_members")
  .route({
    method: "GET",
    path: "/invites",
    summary: "List pending invites",
    description: "List unexpired organization invites that have not been redeemed or revoked.",
    tags: ["Members"],
  })
  .output(
    z
      .array(
        z
          .object({
            id: z.string().describe("The invite's unique ID. A UUID (version 7)."),
            role: roleSchema.describe("The role the invite grants when redeemed."),
            scopeId: z
              .string()
              .describe("The ID of the scope the invite grants access to. A UUID."),
            invitedBy: z
              .string()
              .describe("The display name of the member who created the invite."),
            createdAt: z.string().describe("When the invite was created. An ISO 8601 date-time."),
            expiresAt: z.string().describe("When the invite expires. An ISO 8601 date-time."),
          })
          .describe("A pending organization invite."),
      )
      .describe("The pending invites for the active organization."),
  )
  .handler(async ({ context }) =>
    (await listInvites(context.db, context.org.id)).map((invite) => ({
      id: invite.id,
      role: invite.role,
      scopeId: invite.scopeId,
      invitedBy: invite.createdBy.displayName,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
    })),
  );

const inviteRevoke = requireCapability("manage_members")
  .route({
    method: "POST",
    path: "/invites/{id}/revoke",
    summary: "Revoke an invite",
    description: "Revoke a pending invite so its token can no longer be previewed or redeemed.",
    tags: ["Members"],
  })
  .input(
    z.object({
      id: z.uuid().describe("The ID of the invite to revoke. A UUID."),
    }),
  )
  .output(
    z
      .object({
        id: z.string().describe("The revoked invite's unique ID. A UUID (version 7)."),
        revokedAt: z.string().describe("When the invite was revoked. An ISO 8601 date-time."),
      })
      .describe("The revoked invite."),
  )
  .handler(async ({ context, input }) => {
    try {
      const invite = await revokeInvite(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        inviteId: input.id,
      });
      return { id: invite.id, revokedAt: invite.revokedAt!.toISOString() };
    } catch (error) {
      if (error instanceof MemberConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      if (error instanceof MemberNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const memberStateSchema = z
  .object({
    id: z.string().describe("The member principal's unique ID. A UUID (version 7)."),
    status: z
      .enum(["active", "deactivated"])
      .describe("Whether the member can authenticate and act in the organization."),
  })
  .describe("The member's lifecycle state.");

function lifecycleInput() {
  return z.object({
    id: z.uuid().describe("The ID of the member's principal. A UUID."),
  });
}

const deactivate = requireCapability("manage_members")
  .route({
    method: "POST",
    path: "/principals/{id}/deactivate",
    summary: "Deactivate a member",
    description:
      "Block a human member from acting, revoke their service credentials, and remove their identity links without deleting their grants or authored records.",
    tags: ["Members"],
  })
  .input(lifecycleInput())
  .output(memberStateSchema)
  .handler(async ({ context, input }) => {
    try {
      const principal = await deactivateMember(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        principalId: input.id,
      });
      return { id: principal.id, status: "deactivated" as const };
    } catch (error) {
      if (error instanceof MemberConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      if (error instanceof MemberNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const reactivate = requireCapability("manage_members")
  .route({
    method: "POST",
    path: "/principals/{id}/reactivate",
    summary: "Reactivate a member",
    description:
      "Restore a deactivated member without restoring revoked credentials or deleted identity links.",
    tags: ["Members"],
  })
  .input(lifecycleInput())
  .output(memberStateSchema)
  .handler(async ({ context, input }) => {
    try {
      const principal = await reactivateMember(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        principalId: input.id,
      });
      return { id: principal.id, status: "active" as const };
    } catch (error) {
      if (error instanceof MemberConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      if (error instanceof MemberNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const inviteCreateInput = z.object({
  role: roleSchema.describe("The role the invite grants when it is redeemed."),
  scopeId: z
    .uuid()
    .optional()
    .describe(
      "The ID of the scope the invite grants access to. A UUID. Defaults to the organization scope.",
    ),
  expiresAt: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional()
    .describe(
      "When the invite expires. An ISO 8601 date-time. Must be in the future. Defaults to seven days after creation.",
    ),
});

const inviteCreate = requireCapability("manage_members", {
  scopeId: (input) => inviteCreateInput.safeParse(input).data?.scopeId,
})
  .route({
    method: "POST",
    path: "/invites",
    summary: "Create an invite link",
    description: "Create an invite link that grants a role on a scope when someone redeems it.",
    tags: ["Members"],
  })
  .input(inviteCreateInput)
  .output(
    z
      .object({
        id: z.string().describe("The invite's unique ID. A UUID (version 7)."),
        link: z.url().describe("The join URL to share. It carries the single-use invite token."),
        role: roleSchema.describe("The role the invite grants when redeemed."),
        scopeId: z.string().describe("The ID of the scope the invite grants access to. A UUID."),
        expiresAt: z.string().describe("When the invite expires. An ISO 8601 date-time."),
      })
      .describe("A created invite and the link to share."),
  )
  .handler(async ({ context, input }) => {
    if (input.expiresAt && input.expiresAt <= new Date()) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Invite expiry must be in the future",
      });
    }
    try {
      const { invite, link } = await createInvite(context.db, context.env, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        role: input.role,
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
      return {
        id: invite.id,
        link,
        role: invite.role,
        scopeId: invite.scopeId,
        expiresAt: invite.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof MemberNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const invitePreview = pub
  .route({
    method: "POST",
    path: "/invites/preview",
    summary: "Preview an invite link",
    description:
      "Look up the organization and inviter behind an invite token before redeeming it. Returns not-found when the invite is invalid, expired, or already redeemed.",
    tags: ["Members"],
  })
  .input(
    z.object({
      token: z.string().min(1).describe("The invite token from the join link."),
    }),
  )
  .output(
    z
      .object({
        orgName: z.string().describe("The name of the organization the invite joins."),
        invitedBy: z.string().describe("The display name of the member who created the invite."),
      })
      .describe("The organization and inviter behind an invite link."),
  )
  .handler(async ({ context, input }) => {
    try {
      return await previewInvite(context.db, input.token);
    } catch (error) {
      if (error instanceof MemberNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const inviteRedeem = authed
  .route({
    method: "POST",
    path: "/invites/redeem",
    summary: "Redeem an invite link",
    description: "Redeem an invite token to join the organization with the granted role.",
    tags: ["Members"],
  })
  .input(
    z.object({
      token: z.string().min(1).describe("The invite token from the join link."),
    }),
  )
  .output(
    z
      .object({
        orgId: z.string().describe("The ID of the organization the caller joined. A UUID."),
        principal: principalSchema.describe("The caller's principal in the organization."),
        role: roleSchema.describe("The role the caller received."),
        scopeId: z.string().describe("The ID of the scope the role applies to. A UUID."),
      })
      .describe("The result of redeeming an invite."),
  )
  .handler(async ({ context, input }) => {
    try {
      const result = await redeemInvite(context.db, {
        token: input.token,
        authId: context.session.user.id,
        displayName: context.session.user.name,
        email: context.session.user.email,
      });
      return {
        orgId: result.principal.orgId,
        principal: result.principal,
        role: result.grant.role,
        scopeId: result.grant.scopeId,
      };
    } catch (error) {
      if (error instanceof MemberConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      throw error;
    }
  });

export const membersRouter = {
  list,
  setRole,
  deactivate,
  reactivate,
  invites: {
    list: inviteList,
    create: inviteCreate,
    preview: invitePreview,
    redeem: inviteRedeem,
    revoke: inviteRevoke,
  },
};
