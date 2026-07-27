import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { Approval } from "#server/generated/prisma/client.js";
import { orgScoped } from "#server/rpc/builders.js";
import {
  approveApproval,
  ApprovalApproverError,
  ApprovalArgsMismatchError,
  ApprovalNotFoundError,
  ApprovalStateError,
  ApprovalValidationError,
  APPROVAL_PAGE_SIZE,
  denyApproval,
  listResolvableApprovals,
  requireApproval,
} from "#server/services/approvals/index.js";
import { authorize } from "#server/services/authorize/index.js";

const statusSchema = z
  .enum(["pending", "approved", "denied", "expired"])
  .describe("Where the approval ended up. `expired` means nobody answered in time.");

const approvalSchema = z
  .object({
    id: z.string().describe("The approval's unique ID. A UUID (version 7)."),
    sessionId: z.string().describe("The session whose run asked for the call."),
    scopeId: z.string().describe("The scope the approver roles are read at."),
    toolKey: z
      .string()
      .describe(
        "The call waiting on a decision. `context:activate_item` is a proposed item waiting to be turned on.",
      ),
    args: z.json().describe("The call's arguments, verbatim. The approval covers these alone."),
    argsHash: z.string().describe("A fingerprint of the arguments. Execution compares it."),
    reason: z.string().describe("The model's one-line justification for the call."),
    sensitivity: z
      .enum(["read", "write", "destructive"])
      .describe("The tool sensitivity class the policy gated."),
    approverRoles: z
      .array(z.enum(["owner", "admin", "member", "viewer"]))
      .describe("The roles that may resolve it, as pinned when it was asked."),
    allowRequesterApproval: z
      .boolean()
      .describe("Whether the person who asked may resolve it themselves."),
    requesterPrincipalId: z
      .string()
      .nullable()
      .describe("The person the run was acting for, when one is linked."),
    status: statusSchema,
    expiresAt: z.string().describe("When the approval expires. An ISO 8601 date-time."),
    nudgeCount: z.number().int().describe("How many times it has been re-surfaced."),
    resolvedById: z.string().nullable().describe("The person who resolved it, when resolved."),
    resolvedAt: z.string().nullable().describe("When it was resolved. An ISO 8601 date-time."),
    executedAt: z
      .string()
      .nullable()
      .describe("When the approved call ran. Set once, by the executor that claimed it."),
    createdAt: z.string().describe("When the approval was asked for. An ISO 8601 date-time."),
  })
  .describe("One gated call waiting on a person, and how it ended.");

function serialize(approval: Approval) {
  return {
    id: approval.id,
    sessionId: approval.sessionId,
    scopeId: approval.scopeId,
    toolKey: approval.toolKey,
    args: approval.argsJson as z.infer<typeof approvalSchema>["args"],
    argsHash: approval.argsHash,
    reason: approval.reason,
    sensitivity: approval.sensitivity,
    approverRoles: approval.approverRoles,
    allowRequesterApproval: approval.allowRequesterApproval,
    requesterPrincipalId: approval.requesterPrincipalId,
    status: approval.status,
    expiresAt: approval.expiresAt.toISOString(),
    nudgeCount: approval.nudgeCount,
    resolvedById: approval.resolvedById,
    resolvedAt: approval.resolvedAt?.toISOString() ?? null,
    executedAt: approval.executedAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
  };
}

/**
 * The approval vocabulary as HTTP. Exported because item activation is an
 * approval taken from the control plane and answers with the same codes.
 */
export function throwApprovalError(error: unknown): never {
  if (error instanceof ApprovalNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof ApprovalApproverError) {
    throw new ORPCError("FORBIDDEN", { message: error.message });
  }
  if (error instanceof ApprovalStateError || error instanceof ApprovalArgsMismatchError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ApprovalValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

const list = orgScoped
  .route({
    method: "GET",
    path: "/approvals",
    summary: "List approvals awaiting you",
    description:
      "List the approvals the acting principal may resolve, pending ones by default. The rule pinned on each approval decides, so this is exactly the set the approve and deny calls accept.",
    tags: ["Approvals"],
  })
  .input(
    z
      .object({
        status: statusSchema.optional().describe("Which approvals to list. Defaults to pending."),
        scopeId: z.uuid().optional().describe("Only list this scope's approvals. A UUID."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`How many approvals to return. Defaults to ${APPROVAL_PAGE_SIZE}.`),
      })
      .describe("Optional approval-list filters."),
  )
  .output(
    z
      .object({ approvals: z.array(approvalSchema) })
      .describe("The approvals this principal may resolve."),
  )
  .handler(async ({ context, input }) => {
    const approvals = await listResolvableApprovals(context.db, {
      orgId: context.org.id,
      principal: context.principal,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return { approvals: approvals.map(serialize) };
  });

const get = orgScoped
  .route({
    method: "GET",
    path: "/approvals/{id}",
    summary: "Get an approval",
    description:
      "Read one approval, including the arguments it covers and the reason the model gave. Readable by anyone who can read its scope.",
    tags: ["Approvals"],
  })
  .input(z.object({ id: z.uuid().describe("The ID of the approval to read. A UUID.") }))
  .output(approvalSchema)
  .handler(async ({ context, input }) => {
    try {
      const approval = await requireApproval(context.db, context.org.id, input.id);
      if (!(await authorize(context.principal, "read", approval.scopeId, context.db))) {
        // An approval in a scope the caller cannot read reports as missing:
        // its tool key and reason would otherwise describe that scope's work.
        throw new ApprovalNotFoundError();
      }
      return serialize(approval);
    } catch (error) {
      throwApprovalError(error);
    }
  });

const approve = orgScoped
  .route({
    method: "POST",
    path: "/approvals/{id}/approve",
    summary: "Approve a gated call",
    description:
      "Approve the recorded call. The approver must satisfy the rule pinned on the approval when it was asked, not the scope's current policy. Approving a `context:activate_item` approval also activates the item.",
    tags: ["Approvals"],
  })
  .input(z.object({ id: z.uuid().describe("The ID of the approval to approve. A UUID.") }))
  .output(
    z
      .object({
        approval: approvalSchema,
        activatedItemId: z
          .string()
          .optional()
          .describe("The item this approval activated, for an item-activation approval."),
      })
      .describe("The resolved approval, and what approving it did."),
  )
  .handler(async ({ context, input }) => {
    try {
      const resolved = await approveApproval(context.db, {
        orgId: context.org.id,
        approvalId: input.id,
        approverPrincipalId: context.principal.id,
      });
      return {
        approval: serialize(resolved.approval),
        ...(resolved.activatedItemId === undefined
          ? {}
          : { activatedItemId: resolved.activatedItemId }),
      };
    } catch (error) {
      throwApprovalError(error);
    }
  });

const deny = orgScoped
  .route({
    method: "POST",
    path: "/approvals/{id}/deny",
    summary: "Deny a gated call",
    description:
      "Refuse the recorded call. The run reads the denial as the tool's result and carries on without it.",
    tags: ["Approvals"],
  })
  .input(z.object({ id: z.uuid().describe("The ID of the approval to deny. A UUID.") }))
  .output(approvalSchema)
  .handler(async ({ context, input }) => {
    try {
      return serialize(
        await denyApproval(context.db, {
          orgId: context.org.id,
          approvalId: input.id,
          approverPrincipalId: context.principal.id,
        }),
      );
    } catch (error) {
      throwApprovalError(error);
    }
  });

export const approvalsRouter = { list, get, approve, deny };
