import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  createInvite,
  listMembers,
  MemberConflictError,
  MemberNotFoundError,
  redeemInvite,
  setMemberRole,
} from "../services/members/index.js";
import { authed, requireCapability } from "./builders.js";

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
const principalSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
});
const memberSchema = z.object({ principal: principalSchema, role: roleSchema });

const list = requireCapability("read")
  .route({
    method: "GET",
    path: "/members",
    summary: "List organization members",
  })
  .output(z.array(memberSchema))
  .handler(async ({ context }) =>
    (await listMembers(context.db, context.org.id)).map(({ principal, role }) => ({
      principal,
      role,
    })),
  );

const setRole = requireCapability("manage_members")
  .route({
    method: "POST",
    path: "/members/role",
    summary: "Set an organization member's role",
  })
  .input(z.object({ principalId: z.uuid(), role: roleSchema }))
  .output(memberSchema)
  .handler(async ({ context, input }) => {
    try {
      const result = await setMemberRole(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        principalId: input.principalId,
        role: input.role,
      });
      return { principal: result.principal, role: result.grant.role };
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
  role: roleSchema,
  scopeId: z.uuid().optional(),
  expiresAt: z.iso.datetime().transform((value) => new Date(value)).optional(),
});

const inviteCreate = requireCapability("manage_members", {
  scopeId: (input) => inviteCreateInput.safeParse(input).data?.scopeId,
})
  .route({ method: "POST", path: "/invites", summary: "Create an invite link" })
  .input(inviteCreateInput)
  .output(
    z.object({
      id: z.string(),
      link: z.url(),
      role: roleSchema,
      scopeId: z.string(),
      expiresAt: z.string(),
    }),
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

const inviteRedeem = authed
  .route({
    method: "POST",
    path: "/invites/redeem",
    summary: "Redeem an invite link",
  })
  .input(z.object({ token: z.string().min(1) }))
  .output(
    z.object({
      orgId: z.string(),
      principal: principalSchema,
      role: roleSchema,
      scopeId: z.string(),
    }),
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
  invites: { create: inviteCreate, redeem: inviteRedeem },
};
