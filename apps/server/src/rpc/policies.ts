import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { Policy } from "#server/generated/prisma/client.js";
import { authorize } from "#server/services/authorize/index.js";
import {
  deletePolicy,
  listPolicies,
  PolicyNotFoundError,
  PolicyValidationError,
  resolveScopePolicies,
  setPolicy,
} from "#server/services/policies/index.js";
import { requireCapability } from "./builders.js";

const sensitivitySchema = z
  .enum(["read", "write", "destructive"])
  .describe("The tool sensitivity class the policy governs.");

const actionSchema = z
  .enum(["allow", "require_approval", "deny"])
  .describe("What happens when the agent calls a tool of this class.");

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]).describe("An organization role.");

const policySchema = z
  .object({
    id: z.string().describe("The policy's unique ID. A UUID (version 7)."),
    scopeId: z.string().describe("The scope the policy applies to."),
    sensitivity: sensitivitySchema,
    action: actionSchema,
    approverRoles: z
      .array(roleSchema)
      .describe("The roles that may resolve an approval. Empty unless the action requires one."),
    allowRequesterApproval: z
      .boolean()
      .describe("Whether the person who asked may approve their own request."),
    createdAt: z.string().describe("When the policy was created. An ISO 8601 date-time."),
    updatedAt: z.string().describe("When the policy was last written. An ISO 8601 date-time."),
  })
  .describe("One scope's approval policy for one sensitivity class.");

const decisionSchema = z
  .object({
    sensitivity: sensitivitySchema,
    action: actionSchema,
    approverRoles: z.array(roleSchema).describe("The roles that may resolve an approval."),
    allowRequesterApproval: z
      .boolean()
      .describe("Whether the person who asked may approve their own request."),
    source: z.json().describe("Where the decision came from: a stored policy or the default."),
  })
  .describe("The resolved approval policy for one sensitivity class.");

function serialize(policy: Policy) {
  return {
    id: policy.id,
    scopeId: policy.scopeId,
    sensitivity: policy.sensitivity,
    action: policy.action,
    approverRoles: policy.approverRoles,
    allowRequesterApproval: policy.allowRequesterApproval,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function throwPolicyError(error: unknown): never {
  if (error instanceof PolicyNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof PolicyValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

const scopeIdFromInput = (input: unknown): string | undefined =>
  typeof input === "object" && input !== null && "scopeId" in input
    ? ((input as { scopeId?: string }).scopeId ?? undefined)
    : undefined;

const list = requireCapability("read", { scopeId: scopeIdFromInput })
  .route({
    method: "GET",
    path: "/policies",
    summary: "List approval policies",
    description:
      "List the stored approval policies in the active organization, optionally filtered to one scope. Scopes with no row for a class fall back to a wider scope or the built-in defaults; read the resolved view to see what a session would get.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().optional().describe("Only list this scope's policies. A UUID."),
      })
      .describe("Optional policy-list filters."),
  )
  .output(z.object({ policies: z.array(policySchema) }).describe("The matching approval policies."))
  .handler(async ({ context, input }) => {
    const policies = await listPolicies(context.db, {
      orgId: context.org.id,
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
    });
    // Personal scopes do not inherit org roles, so an org-wide listing must
    // check each scope the results came from rather than the org scope alone.
    const readable = new Map<string, boolean>();
    for (const scopeId of new Set(policies.map((policy) => policy.scopeId))) {
      readable.set(scopeId, await authorize(context.principal, "read", scopeId, context.db));
    }
    return {
      policies: policies.filter((policy) => readable.get(policy.scopeId) === true).map(serialize),
    };
  });

const resolved = requireCapability("read", { scopeId: scopeIdFromInput })
  .route({
    method: "GET",
    path: "/policies/resolved",
    summary: "Resolve a scope's approval policy",
    description:
      "The decision each sensitivity class resolves to for this scope right now: the narrowest scope in the chain holding a row wins, and a class with no row anywhere falls back to the built-in default. A session pins this same result for its whole life.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope to resolve the policy for. A UUID."),
      })
      .describe("The scope to resolve."),
  )
  .output(
    z
      .object({
        scopeId: z.string().describe("The scope the policy resolved for."),
        scopeChain: z
          .array(z.string())
          .describe("The scope IDs the policy resolved over, widest first."),
        decisions: z
          .object({ read: decisionSchema, write: decisionSchema, destructive: decisionSchema })
          .describe("One resolved decision per sensitivity class."),
      })
      .describe("The approval policy a session opened against this scope would carry."),
  )
  .handler(async ({ context, input }) => {
    try {
      return await resolveScopePolicies(context.db, {
        orgId: context.org.id,
        scopeId: input.scopeId,
      });
    } catch (error) {
      throwPolicyError(error);
    }
  });

const set = requireCapability("edit_policies", { scopeId: scopeIdFromInput })
  .route({
    method: "PUT",
    path: "/policies/{scopeId}/{sensitivity}",
    summary: "Set an approval policy",
    description:
      "Create or replace one scope's policy for one sensitivity class. A scope holds at most one policy per class. Approver fields are stored only for `require_approval`; outside a personal scope such a policy needs an approver role, because the requester cannot be its sole approver.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope the policy applies to. A UUID."),
        sensitivity: sensitivitySchema,
        action: actionSchema,
        approverRoles: z
          .array(roleSchema)
          .optional()
          .describe("The roles that may resolve an approval. Ignored unless `require_approval`."),
        allowRequesterApproval: z
          .boolean()
          .optional()
          .describe(
            "Whether the person who asked may approve their own request. Ignored unless `require_approval`; defaults to false.",
          ),
      })
      .describe("The approval policy to store."),
  )
  .output(policySchema)
  .handler(async ({ context, input }) => {
    try {
      return serialize(
        await setPolicy(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          scopeId: input.scopeId,
          sensitivity: input.sensitivity,
          action: input.action,
          ...(input.approverRoles === undefined ? {} : { approverRoles: input.approverRoles }),
          ...(input.allowRequesterApproval === undefined
            ? {}
            : { allowRequesterApproval: input.allowRequesterApproval }),
        }),
      );
    } catch (error) {
      throwPolicyError(error);
    }
  });

const remove = requireCapability("edit_policies", { scopeId: scopeIdFromInput })
  .route({
    method: "DELETE",
    path: "/policies/{scopeId}/{sensitivity}",
    summary: "Delete an approval policy",
    description:
      "Remove one scope's policy for a class. The class then resolves through the wider scope, or through the built-in default when nothing else carries a row.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope whose policy to remove. A UUID."),
        sensitivity: sensitivitySchema,
      })
      .describe("The approval policy to remove."),
  )
  .output(policySchema)
  .handler(async ({ context, input }) => {
    try {
      return serialize(
        await deletePolicy(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          scopeId: input.scopeId,
          sensitivity: input.sensitivity,
        }),
      );
    } catch (error) {
      throwPolicyError(error);
    }
  });

export const policiesRouter = { list, resolved, set, delete: remove };
