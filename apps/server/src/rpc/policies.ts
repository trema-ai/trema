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

const modeSchema = z
  .enum(["ask", "delegated", "full"])
  .describe(
    "An approval mode: ask pauses every connector call, delegated lets a call-time classifier escalate unsafe calls, full runs ungated.",
  );

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]).describe("An organization role.");

const policySchema = z
  .object({
    id: z.string().describe("The policy's unique ID. A UUID (version 7)."),
    scopeId: z.string().describe("The scope the policy applies to."),
    connectorKey: z
      .string()
      .nullable()
      .describe("The connector the row governs; null bounds every connector in the scope."),
    maxMode: modeSchema.describe(
      "The loosest approval mode a human may choose where this row applies. The most restrictive applicable row wins.",
    ),
    approverRoles: z
      .array(roleSchema)
      .describe("The roles that may resolve an interrupt routed by this row."),
    allowRequesterApproval: z
      .boolean()
      .describe("Whether the person who asked may approve their own action."),
    createdAt: z.string().describe("When the policy was created. An ISO 8601 date-time."),
    updatedAt: z.string().describe("When the policy was last written. An ISO 8601 date-time."),
  })
  .describe("One scope's approval-mode ceiling for one connector, or scope-wide.");

const routingSchema = z
  .object({
    approverRoles: z.array(roleSchema).describe("The roles that may resolve an interrupt."),
    allowRequesterApproval: z
      .boolean()
      .describe("Whether the person who asked may approve their own action."),
    source: z.json().describe("Where the routing came from: a stored policy or the default."),
  })
  .describe("Who resolves the interrupts that pause here.");

function serialize(policy: Policy) {
  return {
    id: policy.id,
    scopeId: policy.scopeId,
    connectorKey: policy.connectorKey,
    maxMode: policy.maxMode,
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
      "List the stored approval-mode ceilings in the active organization, optionally filtered to one scope. A scope with no row resolves through the wider scope's rows and the built-in default; read the resolved view to see what a session would get.",
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
      "The mode ceiling and interrupt routing this scope resolves to right now: the most restrictive applicable row wins, and a scope with no rows anywhere gets the built-in default. Pass a connector key to see one connector's ceiling. A session pins the same rows for its whole life.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope to resolve the policy for. A UUID."),
        connectorKey: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Resolve the ceiling this connector would get."),
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
        rows: z.array(policySchema.omit({ createdAt: true, updatedAt: true })),
        ceiling: modeSchema.describe(
          "The loosest mode a human may choose here, before classifier availability.",
        ),
        routing: routingSchema,
      })
      .describe("The approval policy a session opened against this scope would carry."),
  )
  .handler(async ({ context, input }) => {
    try {
      return await resolveScopePolicies(context.db, {
        orgId: context.org.id,
        scopeId: input.scopeId,
        ...(input.connectorKey === undefined ? {} : { connectorKey: input.connectorKey }),
      });
    } catch (error) {
      throwPolicyError(error);
    }
  });

const set = requireCapability("edit_policies", { scopeId: scopeIdFromInput })
  .route({
    method: "PUT",
    path: "/policies/{scopeId}",
    summary: "Set an approval policy",
    description:
      "Create or replace one scope's ceiling for one connector, or its scope-wide row. A scope holds at most one row per key. The row's interrupts must be resolvable: name an approver role, allow requester approval, or both.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope the policy applies to. A UUID."),
        connectorKey: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The connector the row governs. Omit for the scope-wide row."),
        maxMode: modeSchema,
        approverRoles: z
          .array(roleSchema)
          .optional()
          .describe("The roles that may resolve an interrupt routed by this row."),
        allowRequesterApproval: z
          .boolean()
          .optional()
          .describe("Whether the person who asked may approve their own action. Defaults to true."),
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
          maxMode: input.maxMode,
          ...(input.connectorKey === undefined ? {} : { connectorKey: input.connectorKey }),
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
    path: "/policies/{scopeId}",
    summary: "Delete an approval policy",
    description:
      "Remove one scope's row for a connector, or its scope-wide row. The ceiling then resolves through the remaining rows, or the built-in default.",
    tags: ["Policies"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope whose policy to remove. A UUID."),
        connectorKey: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The connector row to remove. Omit for the scope-wide row."),
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
          ...(input.connectorKey === undefined ? {} : { connectorKey: input.connectorKey }),
        }),
      );
    } catch (error) {
      throwPolicyError(error);
    }
  });

export const policiesRouter = { list, resolved, set, delete: remove };
