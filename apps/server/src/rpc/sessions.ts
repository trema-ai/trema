import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { ContextSession, Scope } from "#/generated/prisma/client.js";
import { log } from "#/lib/logger/index.js";
import { serviceAuthed, sessionAuthed } from "#/rpc/builders.js";
import {
  closeSession,
  openSession,
  type OpenSessionResult,
  renewSession,
  SessionClosedError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionResolutionError,
  SessionValidationError,
} from "#/services/sessions/index.js";

const modeSchema = z
  .enum(["service", "delegated"])
  .describe(
    "The session's identity mode. `service` acts as the organization's agent; `delegated` acts as the requesting person.",
  );

const scopeSchema = z
  .object({
    id: z.string().describe("The scope's unique ID. A UUID (version 7)."),
    kind: z.enum(["org", "shared", "personal"]).describe("The scope kind."),
    name: z.string().describe("The scope's display name."),
  })
  .describe("One scope in the session's resolution chain.");

const standingSchema = z
  .object({
    instructions: z
      .string()
      .describe("The scope chain's active instructions, concatenated widest to narrowest."),
    rules: z
      .array(
        z.object({
          id: z.string().describe("The item ID the rule comes from."),
          type: z.string().describe("The memory type, such as `rule` or `preference`."),
          content: z.string().describe("The rule text to inject."),
        }),
      )
      .describe("The standing memories that fit the token budget, most-recently-reinforced first."),
    skillIndex: z
      .array(
        z.object({
          name: z.string().describe("The skill's name."),
          description: z.string().describe("The skill's one-line description."),
        }),
      )
      .describe("A name and description line per installed skill."),
    budgetTokens: z.number().int().describe("The token budget the standing set was cut at."),
    usedTokens: z.number().int().describe("The estimated token cost of the injected content."),
    overflowItemIds: z
      .array(z.string())
      .describe("Standing items the budget cut. They remain reachable through search."),
  })
  .describe("The bounded set of context injected into every turn of this session.");

const policyDecisionSchema = z
  .object({
    sensitivity: z
      .enum(["read", "write", "destructive"])
      .describe("The tool sensitivity class the decision governs."),
    action: z
      .enum(["allow", "require_approval", "deny"])
      .describe("What happens when the agent calls a tool of this class."),
    approverRoles: z
      .array(z.enum(["owner", "admin", "member", "viewer"]))
      .describe("The roles that may resolve an approval for this class."),
    allowRequesterApproval: z
      .boolean()
      .describe("Whether the person who asked may approve their own request."),
    source: z.json().describe("Where the decision came from: a stored policy or the default."),
  })
  .describe("The resolved approval policy for one sensitivity class.");

const policySnapshotSchema = z
  .object({
    version: z.number().int().describe("The snapshot format version."),
    scopeId: z.string().describe("The scope the session opened against."),
    scopeChain: z.array(z.string()).describe("The scope IDs the policy resolved over."),
    decisions: z
      .object({
        read: policyDecisionSchema,
        write: policyDecisionSchema,
        destructive: policyDecisionSchema,
      })
      .describe("One resolved decision per sensitivity class."),
  })
  .describe("The approval policy pinned for the session's whole life.");

const sessionSchema = z
  .object({
    sessionId: z.string().describe("The session's unique ID. A UUID (version 7)."),
    sessionToken: z
      .string()
      .describe("The bearer token for this session's data-plane calls. Returned only once."),
    expiresAt: z
      .string()
      .describe("When the session token expires. An ISO 8601 date-time. Renewal extends it."),
    mode: modeSchema,
    scopeChain: z
      .array(scopeSchema)
      .describe("The scopes the session reads, widest first. Writes land at the last one."),
    standing: standingSchema,
    tools: z.array(z.json()).describe("The tool definitions this session may call."),
    policySnapshot: policySnapshotSchema,
    snapshotHash: z.string().describe("A stable identifier for the resolved snapshot contents."),
    actingPrincipalId: z.string().describe("The principal the session acts as."),
    requesterPrincipalId: z
      .string()
      .nullable()
      .describe("The person who asked, when they are linked to a principal."),
    requesterExternalRef: z
      .string()
      .nullable()
      .describe("The raw surface id of the requester, when they are not linked."),
  })
  .describe("An opened context session and its pinned snapshot.");

function serializeOpenedSession(result: OpenSessionResult) {
  const { session, standing } = result;
  return {
    sessionId: session.id,
    sessionToken: result.sessionToken,
    expiresAt: session.expiresAt.toISOString(),
    mode: session.mode,
    scopeChain: result.scopeChain.map((scope: Scope) => ({
      id: scope.id,
      kind: scope.kind,
      name: scope.name,
    })),
    standing: {
      ...standing.standing,
      budgetTokens: standing.budgetTokens,
      usedTokens: standing.usedTokens,
      overflowItemIds: standing.overflowItemIds,
    },
    tools: result.tools,
    policySnapshot: result.policySnapshot,
    snapshotHash: session.snapshotHash,
    actingPrincipalId: session.actingPrincipalId,
    requesterPrincipalId: session.requesterPrincipalId,
    requesterExternalRef: session.requesterExternalRef,
  };
}

function throwSessionError(error: unknown): never {
  if (error instanceof SessionResolutionError) {
    // The harness turns these into onboarding: link your account, or ask an
    // administrator to bind this location.
    throw new ORPCError(error.code === "location_unbound" ? "NOT_FOUND" : "FORBIDDEN", {
      message: error.message,
      data: { code: error.code, ...error.detail },
    });
  }
  if (error instanceof SessionValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof SessionNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof SessionClosedError) {
    throw new ORPCError("CONFLICT", { message: error.message, data: { code: error.code } });
  }
  if (error instanceof SessionExpiredError) {
    throw new ORPCError("UNAUTHORIZED", { message: error.message, data: { code: error.code } });
  }
  throw error;
}

// The path id and the bearer token must name the same session. A mismatch
// reads as "not found" so a token cannot probe for other sessions.
function assertSessionMatches(session: ContextSession, sessionId: string): void {
  if (session.id !== sessionId) {
    log.warn("Session token does not match the requested session", {
      requestedSessionId: sessionId,
    });
    throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  }
}

const open = serviceAuthed
  .route({
    method: "POST",
    path: "/sessions",
    summary: "Open a context session",
    description:
      "Resolve a surface location to a scope and open a session against it. The response carries the session token, the standing context, and the pinned policy snapshot.",
    tags: ["Sessions"],
  })
  .input(
    z
      .object({
        surface: z.string().trim().min(1).describe("The integration surface, such as `slack`."),
        locationRef: z.string().trim().min(1).describe("The surface-specific location identifier."),
        dm: z
          .boolean()
          .optional()
          .describe(
            "Whether the location is a one-to-one conversation with the agent. A linked person's DM resolves to their personal scope.",
          ),
        threadRef: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The thread this session belongs to, when the surface has threads."),
        requester: z
          .union([
            z.object({
              externalUserId: z
                .string()
                .trim()
                .min(1)
                .describe("The requesting person's raw surface id."),
            }),
            z.object({
              principalId: z.uuid().describe("The requesting person's principal ID. A UUID."),
            }),
          ])
          .optional()
          .describe("Who asked. Omit it for scheduled work that nobody triggered."),
      })
      .describe("The location and requester to open a session for."),
  )
  .output(sessionSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeOpenedSession(
        await openSession(context.db, {
          orgId: context.org.id,
          surface: input.surface,
          locationRef: input.locationRef,
          standingBudgetTokens: context.env.TREMA_SESSION_STANDING_BUDGET_TOKENS,
          ...(input.dm === undefined ? {} : { dm: input.dm }),
          ...(input.threadRef === undefined ? {} : { threadRef: input.threadRef }),
          ...(input.requester === undefined ? {} : { requester: input.requester }),
        }),
      );
    } catch (error) {
      throwSessionError(error);
    }
  });

const renew = sessionAuthed
  .route({
    method: "POST",
    path: "/sessions/{id}/renew",
    summary: "Renew a context session",
    description:
      "Extend an open session's token lifetime. The token itself does not change. An expired session cannot be renewed; open a new one.",
    tags: ["Sessions"],
  })
  .input(z.object({ id: z.uuid().describe("The ID of the session to renew. A UUID.") }))
  .output(
    z
      .object({
        sessionId: z.string().describe("The renewed session's ID."),
        expiresAt: z.string().describe("The new expiry. An ISO 8601 date-time."),
      })
      .describe("The renewed session lifetime."),
  )
  .handler(async ({ context, input }) => {
    assertSessionMatches(context.contextSession, input.id);
    try {
      const renewed = await renewSession(context.db, {
        orgId: context.contextSession.orgId,
        sessionId: input.id,
      });
      return { sessionId: renewed.id, expiresAt: renewed.expiresAt.toISOString() };
    } catch (error) {
      throwSessionError(error);
    }
  });

const usageSchema = z
  .object({
    inputTokens: z.number().int().min(0).optional().describe("Input tokens the run consumed."),
    outputTokens: z.number().int().min(0).optional().describe("Output tokens the run generated."),
    totalTokens: z.number().int().min(0).optional().describe("Total tokens the provider reported."),
    cacheReadTokens: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Input tokens read from a provider cache."),
    cacheWriteTokens: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Input tokens written to a provider cache."),
    costUsd: z.number().min(0).optional().describe("Reported cost in United States dollars."),
  })
  .describe("Aggregate usage for the run the session served.");

const close = sessionAuthed
  .route({
    method: "POST",
    path: "/sessions/{id}/close",
    summary: "Close a context session",
    description:
      "Close a session and record the run's usage. An expired session still closes, so usage is never lost.",
    tags: ["Sessions"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The ID of the session to close. A UUID."),
        usage: usageSchema.optional(),
      })
      .describe("The session to close and the usage to record."),
  )
  .output(
    z
      .object({
        sessionId: z.string().describe("The closed session's ID."),
        closedAt: z.string().describe("When the session closed. An ISO 8601 date-time."),
        usage: usageSchema.nullable().describe("The recorded usage, when the caller reported it."),
      })
      .describe("The closed session and its recorded usage."),
  )
  .handler(async ({ context, input }) => {
    assertSessionMatches(context.contextSession, input.id);
    try {
      const closed = await closeSession(context.db, {
        orgId: context.contextSession.orgId,
        sessionId: input.id,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      });
      return {
        sessionId: closed.id,
        closedAt: closed.closedAt!.toISOString(),
        usage: (closed.usage ?? null) as z.infer<typeof usageSchema> | null,
      };
    } catch (error) {
      throwSessionError(error);
    }
  });

export const sessionsRouter = { open, renew, close };
