import { ORPCError } from "@orpc/server";
import type { Engine, PrincipalRef } from "@trema/harness";
import { z } from "zod";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import { type IntentCaller, serviceOrSessionAuthed } from "#server/rpc/builders.js";
import {
  ContextCapabilityUnavailableError,
  createRunServices,
  IntentMismatchError,
  IntentOptionError,
  IntentStateError,
  IntentTargetError,
  type RunServices,
  resolveRunAccess,
  startRun,
  submitTargetIntent,
  type TargetIntent,
} from "#server/services/runs/index.js";
import {
  SessionClosedError,
  SessionResolutionError,
  SessionValidationError,
} from "#server/services/sessions/index.js";

/** The request context fields the run services need. */
export interface RunServicesContext {
  db: Database;
  env: Environment;
  runEngineFor?: (orgId: string) => Engine;
}

/**
 * Builds the run services for the calling organization.
 * @throws {ORPCError} When the deployment has no run engine configured.
 */
export function runServicesFor(context: RunServicesContext, orgId: string): RunServices {
  if (context.runEngineFor === undefined) {
    log.error("Run engine is not configured");
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "This deployment cannot schedule runs",
    });
  }
  return createRunServices({
    db: context.db,
    env: context.env,
    orgId,
    engine: context.runEngineFor(orgId),
  });
}

const messageIntentSchema = z
  .object({
    type: z.literal("message").describe("Says something to the agent on the thread."),
    text: z.string().trim().min(1).describe("What the message says."),
  })
  .describe("A message for the thread. An active run absorbs it; otherwise a new run starts.");

const resolveIntentSchema = z
  .object({
    type: z.literal("resolve").describe("Decides a blocking elicitation."),
    elicitationId: z.string().trim().min(1).describe("The elicitation being decided."),
    optionId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The chosen option, one the elicitation offers. The decision and its scope derive from the option; approvals enforce approver policy where the decision lands.",
      ),
  })
  .describe("A decision on a blocking elicitation — what resumes a parked run.");

const stopIntentSchema = z
  .object({
    type: z.literal("stop").describe("Cancels the run."),
    runId: z.string().trim().min(1).describe("The active run to stop."),
  })
  .describe(
    "A request to stop an active run. The stop fact is recorded first; the `run-finished` event on the stream is the acknowledgement.",
  );

const retryIntentSchema = z
  .object({
    type: z.literal("retry").describe("Re-runs failed work."),
    runId: z.string().trim().min(1).describe("The failed or stale run to retry."),
  })
  .describe("A new run for a failed or stale one, on the same thread.");

const feedbackIntentSchema = z
  .object({
    type: z.literal("feedback").describe("Thumbs on a run."),
    runId: z.string().trim().min(1).describe("The run the feedback is about."),
    verdict: z.enum(["up", "down"]).describe("Thumbs up or thumbs down."),
    comment: z.string().trim().min(1).optional().describe("Optional words to go with it."),
  })
  .describe("Feedback on a run, recorded as an audit fact. The run itself is untouched.");

// The full intent vocabulary of interface 03, minus `steer`: the steer/message
// split is dispatch's decision, so a caller only ever sends `message` and the
// server classifies it against the thread's active run.
const intentSchema = z
  .discriminatedUnion("type", [
    messageIntentSchema,
    resolveIntentSchema,
    stopIntentSchema,
    retryIntentSchema,
    feedbackIntentSchema,
  ])
  .describe("What the caller is doing.");

// The envelope's `target` mirrors the reference the intent itself carries —
// interface 03 defines both — so it is accepted for envelope fidelity and
// checked against the intent, never trusted over it.
const targetSchema = z
  .object({
    runId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The run a stop, retry, or feedback intent addresses."),
    elicitationId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The elicitation a resolve intent addresses."),
  })
  .describe(
    "What a non-message intent addresses. Optional: the intent carries the same reference, and the two must agree when both are present.",
  );

/** The reference a given intent addresses, for the target cross-check. */
function intentReference(intent: z.infer<typeof intentSchema>): {
  runId?: string;
  elicitationId?: string;
} {
  if (intent.type === "message") return {};
  if (intent.type === "resolve") return { elicitationId: intent.elicitationId };
  return { runId: intent.runId };
}

function assertTargetAgrees(
  target: z.infer<typeof targetSchema> | undefined,
  intent: z.infer<typeof intentSchema>,
): void {
  if (target === undefined) return;
  const expected = intentReference(intent);
  const runDisagrees = target.runId !== undefined && target.runId !== expected.runId;
  const elicitationDisagrees =
    target.elicitationId !== undefined && target.elicitationId !== expected.elicitationId;
  if (runDisagrees || elicitationDisagrees) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Target does not match the intent's own reference",
      data: { code: "target_mismatch" },
    });
  }
}

/** Maps a mismatched intent-id reuse to its structured conflict. */
function throwIfIntentMismatch(error: unknown): void {
  if (error instanceof IntentMismatchError) {
    throw new ORPCError("CONFLICT", { message: error.message, data: { code: error.code } });
  }
}

/** Maps session-resolution failures to the structured errors surfaces get. */
function throwSessionError(error: unknown): never {
  throwIfIntentMismatch(error);
  if (error instanceof SessionResolutionError) {
    // An unbound location is the same structured error a surface would get;
    // `personal_scopes_disabled` is the product moment web 06 renders in
    // place of the composer.
    throw new ORPCError(error.code === "location_unbound" ? "NOT_FOUND" : "FORBIDDEN", {
      message: error.message,
      data: { code: error.code, ...error.detail },
    });
  }
  if (error instanceof SessionValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof SessionClosedError) {
    throw new ORPCError("CONFLICT", { message: error.message, data: { code: error.code } });
  }
  throw error;
}

/** Maps target-intent failures to the structured errors the spec describes. */
function throwIntentError(error: unknown): never {
  throwIfIntentMismatch(error);
  if (error instanceof IntentTargetError) {
    throw new ORPCError("NOT_FOUND", { message: error.message, data: { code: error.code } });
  }
  if (error instanceof IntentStateError) {
    throw new ORPCError("CONFLICT", { message: error.message, data: { code: error.code } });
  }
  if (error instanceof IntentOptionError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message, data: { code: error.code } });
  }
  if (error instanceof ContextCapabilityUnavailableError) {
    // Approval decisions relay to the context app's data plane, which this
    // deployment does not serve yet. The gap is named, never a 500.
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: error.message,
      data: { code: error.code },
    });
  }
  throw error;
}

/**
 * A session-authenticated caller acts on a run only where the access rule
 * gives the full view: the audit view may know a run exists but may not touch
 * it, and everyone else finds nothing — the same byte-identical refusal the
 * reads give. A service credential is org-level authority and skips this,
 * exactly as it does for the message path.
 */
async function requireActionableRun(
  db: Database,
  caller: IntentCaller,
  runId: string,
  refusal: string,
): Promise<void> {
  const verdict = await resolveRunAccess({
    db,
    orgId: caller.org.id,
    principal: caller.principal,
    runId,
  });
  if (verdict.access !== "full") {
    throw new ORPCError("NOT_FOUND", { message: refusal });
  }
}

/**
 * A browser session's message lands only on the caller's own web threads.
 *
 * Dispatch finds a thread's active run by `threadRef` alone, so without this
 * check a member who knows another member's thread reference could steer that
 * member's run or graft messages onto their thread. Ownership is deterministic
 * lookup, never judgment: every session or captured conversation already on
 * the thread must sit on the caller's own web location. A fresh reference is
 * fine — the run it starts is what claims it. The refusal is NOT_FOUND,
 * byte-identical to a thread that does not exist, so probing confirms nothing.
 */
async function requireOwnWebThread(
  db: Database,
  caller: IntentCaller,
  threadRef: string,
): Promise<void> {
  const own = { surface: "web", locationRef: caller.principal.id };
  const [foreignSession, foreignConversation] = await Promise.all([
    db.contextSession.findFirst({
      where: { orgId: caller.org.id, threadRef, NOT: own },
      select: { id: true },
    }),
    db.conversation.findFirst({
      where: { orgId: caller.org.id, threadRef, NOT: own },
      select: { id: true },
    }),
  ]);
  if (foreignSession !== null || foreignConversation !== null) {
    throw new ORPCError("NOT_FOUND", { message: "Thread not found" });
  }
}

/**
 * Resolves the run a session-authenticated target intent must be allowed to
 * touch. Check-then-act, like every mutating route (items' `itemScoped`,
 * schedules' `requireManageableSchedule`): access revoked between this check
 * and the write it guards is an accepted window, not one this route closes
 * alone.
 */
async function authorizeTarget(
  db: Database,
  caller: IntentCaller,
  intent: Exclude<z.infer<typeof intentSchema>, { type: "message" }>,
): Promise<void> {
  if (caller.mode !== "session") return;
  if (intent.type === "resolve") {
    const elicitation = await db.runElicitation.findUnique({
      where: { orgId_id: { orgId: caller.org.id, id: intent.elicitationId } },
      select: { runId: true },
    });
    // A missing elicitation and one on a run the caller may not see read the
    // same, so neither confirms the other person's run is there.
    if (elicitation === null) {
      throw new ORPCError("NOT_FOUND", { message: "Elicitation not found" });
    }
    await requireActionableRun(db, caller, elicitation.runId, "Elicitation not found");
    return;
  }
  await requireActionableRun(db, caller, intent.runId, "Run not found");
}

const submit = serviceOrSessionAuthed
  .route({
    method: "POST",
    path: "/intents",
    successStatus: 202,
    summary: "Submit an intent",
    description: [
      "The one write seam for conversational input, under either auth mode.",
      "A service credential names any bound location; a browser session posts to its own web location, stamped server-side.",
      "A message lands on the thread: an active run absorbs it, otherwise a new run starts.",
      "A resolve decides a blocking elicitation, a stop cancels an active run, a retry re-runs a failed one, and feedback is recorded as an audit fact.",
      "The response reports the durably recorded classification and never waits for execution:",
      "observe progress through the run's event stream.",
    ].join(" "),
    tags: ["Intents"],
  })
  .input(
    z
      .object({
        intentId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Retry the same call with the same id to reach the same effect exactly once. Reusing an id for a different intent or target is refused as a conflict.",
          ),
        locationRef: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "The surface-specific location identifier, bound to a scope. Service-mode messages require it; a browser session posts to its own web location and must not send it.",
          ),
        surface: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "The integration surface the location belongs to. Service mode only; defaults to `api`. A browser session is always the `web` surface.",
          ),
        threadRef: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "The thread a message joins. It defaults to the surface and location; a non-message intent takes its thread from its target. A browser session names only its own web threads — another member's thread reads as missing.",
          ),
        target: targetSchema.optional(),
        intent: intentSchema,
      })
      .describe("Where the intent goes and what it asks for."),
  )
  .output(
    z
      .object({
        runId: z
          .string()
          .nullable()
          .describe("The run the intent landed on. Null when a duplicate call is still routing."),
        // Web 06 names started/steered/resolved/follow-up/duplicate and is
        // silent on the rest; `stopped`, `retried`, and `recorded` extend the
        // enum deliberately, each naming the fact the 2xx certifies.
        outcome: z
          .enum([
            "started",
            "steered",
            "follow-up",
            "resolved",
            "stopped",
            "retried",
            "recorded",
            "duplicate",
          ])
          .describe(
            "`started` created a run, `steered` added the message to the active run, `follow-up` queued it behind a run that is finishing, `resolved` recorded the elicitation decision, `stopped` recorded the stop, `retried` created the retry run, `recorded` filed the feedback, `duplicate` repeated a used id.",
          ),
        threadRef: z.string().describe("The thread the intent landed on."),
      })
      .describe("Where the intent landed."),
  )
  .handler(async ({ context, input }) => {
    const { caller } = context;
    const services = runServicesFor(context, caller.org.id);
    const author: PrincipalRef = {
      principalId: caller.principal.id,
      displayName: caller.principal.displayName,
    };

    // The session names the surface and the location — a member can only post
    // to their own web location — so a body that tries to is refused, not
    // silently corrected.
    if (
      caller.mode === "session" &&
      (input.surface !== undefined || input.locationRef !== undefined)
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: "A browser session cannot name a surface or location",
        data: { code: "session_names_location" },
      });
    }
    assertTargetAgrees(input.target, input.intent);

    if (input.intent.type === "message") {
      // Session mode stamps the web origin from the cookie: the surface is
      // `web`, the location is the member — one web location per member — and
      // the run classifies as a surface message, not an API trigger.
      const origin =
        caller.mode === "session"
          ? {
              trigger: "message" as const,
              surface: "web",
              locationRef: caller.principal.id,
              requester: { principalId: caller.principal.id },
            }
          : {
              trigger: "api" as const,
              surface: input.surface ?? "api",
              locationRef: requireServiceLocation(input.locationRef),
              // A credential bound to the organization's agent is nobody
              // asking, so the session opens in service mode with no requester.
              ...(caller.principal.kind === "human"
                ? { requester: { principalId: caller.principal.id } }
                : {}),
            };
      if (caller.mode === "session" && input.threadRef !== undefined) {
        await requireOwnWebThread(context.db, caller, input.threadRef);
      }
      try {
        return await startRun({
          services,
          input: {
            intentId: input.intentId,
            ...origin,
            message: { role: "user", blocks: [{ type: "text", text: input.intent.text }] },
            author,
            ...(input.threadRef === undefined ? {} : { threadRef: input.threadRef }),
          },
        });
      } catch (error) {
        throwSessionError(error);
      }
    }

    await authorizeTarget(context.db, caller, input.intent);
    try {
      return await submitTargetIntent({
        services,
        input: {
          intentId: input.intentId,
          by: author,
          intent: toTargetIntent(input.intent),
        },
      });
    } catch (error) {
      throwIntentError(error);
    }
  });

/** Rebuilds the wire intent as the service type, dropping absent optionals. */
function toTargetIntent(
  intent: Exclude<z.infer<typeof intentSchema>, { type: "message" }>,
): TargetIntent {
  if (intent.type === "resolve") {
    return { type: "resolve", elicitationId: intent.elicitationId, optionId: intent.optionId };
  }
  if (intent.type === "feedback") {
    return {
      type: "feedback",
      runId: intent.runId,
      verdict: intent.verdict,
      ...(intent.comment === undefined ? {} : { comment: intent.comment }),
    };
  }
  return { type: intent.type, runId: intent.runId };
}

/** A service-mode message must say where it goes; nothing can be derived. */
function requireServiceLocation(locationRef: string | undefined): string {
  if (locationRef === undefined) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A service-mode message names the location it goes to",
      data: { code: "location_required" },
    });
  }
  return locationRef;
}

export const intentsRouter = { submit };
