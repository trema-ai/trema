import { ORPCError } from "@orpc/server";
import {
  type PrincipalRef,
  PrincipalRefSchema,
  parseRunEvent,
  type RunEventData,
  type TranscriptMessage,
} from "@trema/harness";
import { z } from "zod";

import type { AgentRun } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { orgScoped } from "#server/rpc/builders.js";
import {
  deriveOpeningMessage,
  renderToolOutputBlocks,
  resolveRunAccess,
  resolveRunsAccess,
} from "#server/services/runs/index.js";

/** Default page size for the event read. */
export const RUN_EVENT_PAGE_SIZE = 200;
/** The largest page the event read serves. */
export const RUN_EVENT_PAGE_LIMIT = 1000;

/**
 * How many leading events the opening-message derivation reads per run.
 *
 * The opening message is the steering the loop drained at the first turn
 * boundary, written immediately after `run-started` — always within the first
 * handful of events. The window only bounds the read; the derivation itself
 * stops at the first event that is neither.
 */
const OPENING_EVENT_WINDOW = 50;

/** Default number of runs the thread list serves. */
export const THREAD_RUN_LIST_SIZE = 100;
/** The largest thread list served. */
export const THREAD_RUN_LIST_LIMIT = 200;

const runStateSchema = z
  .enum([
    "queued",
    "running",
    "awaiting_approval",
    "awaiting_input",
    "completed",
    "failed",
    "cancelled",
    "stale",
  ])
  .describe("Where the run is in its lifecycle.");

const runTriggerSchema = z
  .enum(["message", "api", "schedule", "retry", "resume"])
  .describe("Why the run exists.");

const usageSchema = z
  .json()
  .describe("Token and cost totals across the run's turns. Null until a turn commits.");

const eventPayloadSchema = z.json().describe("The event payload, exactly as recorded.");

const queuedInputSchema = z
  .object({
    id: z.string().describe("The queued input's ID — the intent id the caller sent."),
    kind: z
      .enum(["steering", "follow_up"])
      .describe(
        "`steering` waits on this run's next turn boundary; `follow_up` waits on the thread and starts the next run.",
      ),
    text: z.string().describe("What the message says."),
    author: PrincipalRefSchema.describe("Who said it."),
    position: z.number().int().describe("Drain order across the queue."),
    queuedAt: z.string().describe("When it was queued. An ISO 8601 date-time."),
  })
  .describe("One message waiting for a turn boundary.");

const fullRunSchema = z
  .object({
    access: z.literal("full").describe("The caller may read the run's content."),
    id: z.string().describe("The run's unique ID."),
    state: runStateSchema,
    trigger: runTriggerSchema,
    threadRef: z.string().describe("The thread the run serializes against."),
    surface: z.string().describe("The integration surface the run's session belongs to."),
    locationRef: z.string().describe("The surface-specific location the session was opened at."),
    createdAt: z.string().describe("When the run was created. An ISO 8601 date-time."),
    updatedAt: z.string().describe("When the run last changed. An ISO 8601 date-time."),
    turnCount: z.number().int().describe("Number of committed turns."),
    usage: usageSchema,
    error: z.string().nullable().describe("The failure that ended the run, when one did."),
    retryOfRunId: z.string().nullable().describe("The run this retry follows, when it is one."),
    retryAttempt: z
      .number()
      .int()
      .nullable()
      .describe("One-based attempt number across a retry chain."),
    grantSnapshot: z
      .object({
        scopeChain: z
          .array(z.string())
          .describe("Scope IDs in resolution order, widest first, as pinned at session open."),
        snapshotHash: z.string().describe("Fingerprint of the pinned policy snapshot."),
      })
      .describe("What the run was allowed, pinned when its session opened."),
    queuedInput: z
      .array(queuedInputSchema)
      .describe("Undrained steering and follow-ups, in drain order."),
  })
  .describe("The run as its viewers see it.");

const metadataRunSchema = z
  .object({
    access: z
      .literal("metadata")
      .describe("The caller sees that the run happened, never its content."),
    id: z.string().describe("The run's unique ID."),
    state: runStateSchema,
    trigger: runTriggerSchema,
    createdAt: z.string().describe("When the run was created. An ISO 8601 date-time."),
    updatedAt: z.string().describe("When the run last changed. An ISO 8601 date-time."),
    turnCount: z.number().int().describe("Number of committed turns."),
    usage: usageSchema,
    toolNames: z
      .array(z.string())
      .describe("The distinct tools the run called, from its `tool-start` events."),
  })
  .describe("The audit view of a run in someone else's personal scope.");

/**
 * The one refusal for a run the caller may not read, byte-identical to a run
 * that does not exist: a distinct refusal would disclose that another
 * person's run is there.
 */
function runNotFound(): never {
  throw new ORPCError("NOT_FOUND", { message: "Run not found" });
}

function metadataView(run: AgentRun) {
  return {
    id: run.id,
    state: run.state,
    trigger: run.trigger,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    turnCount: run.turnCount,
    usage: run.usage as z.infer<typeof usageSchema>,
  };
}

function messageText(message: TranscriptMessage): string {
  return message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The distinct tool names a run's log records, in first-call order. */
async function distinctToolNames(db: Database, orgId: string, runId: string): Promise<string[]> {
  const rows = await db.runEvent.findMany({
    where: { orgId, runId, event: { path: ["type"], equals: "tool-start" } },
    orderBy: { seq: "asc" },
    select: { event: true },
  });
  const names = rows.flatMap((row) => {
    const name = (row.event as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
  return [...new Set(names)];
}

const get = orgScoped
  .route({
    method: "GET",
    path: "/runs/{id}",
    summary: "Get a run",
    description:
      "Read one run. A viewer with read at the run's scope gets the full record — state, thread, grant snapshot, queued input. An org admin looking at another person's personal-scope run gets audit metadata: that the run happened and which tools it called, never content. Anyone else finds nothing.",
    tags: ["Runs"],
  })
  .input(z.object({ id: z.string().trim().min(1).describe("The ID of the run to read.") }))
  .output(
    z
      .discriminatedUnion("access", [fullRunSchema, metadataRunSchema])
      .describe("The run, at the depth this caller may see."),
  )
  .handler(async ({ context, input }) => {
    const verdict = await resolveRunAccess({
      db: context.db,
      orgId: context.org.id,
      principal: context.principal,
      runId: input.id,
    });
    if (verdict.access === "none") runNotFound();
    if (verdict.access === "metadata") {
      return {
        access: "metadata" as const,
        ...metadataView(verdict.run),
        toolNames: await distinctToolNames(context.db, context.org.id, verdict.run.id),
      };
    }

    const { run, session } = verdict;
    // Full access always carries the session (access.ts): the verdict's type
    // allows null only for the sessionless anomaly, which never reaches here.
    if (session === null) runNotFound();

    // Steering queues on the run; a follow-up queues on the thread, waiting to
    // start the next run behind this one. Both are this run's pending input.
    const queued = await context.db.runQueuedInput.findMany({
      where: {
        orgId: context.org.id,
        OR: [{ runId: run.id }, { kind: "follow_up", threadRef: run.threadRef }],
      },
      orderBy: { position: "asc" },
    });

    return {
      access: "full" as const,
      ...metadataView(run),
      threadRef: run.threadRef,
      surface: session.surface,
      locationRef: session.locationRef,
      error: run.error,
      retryOfRunId: run.retryOfRunId,
      retryAttempt: run.retryAttempt,
      grantSnapshot: { scopeChain: session.scopeChain, snapshotHash: session.snapshotHash },
      queuedInput: queued.map((row) => ({
        id: row.id,
        kind: row.kind,
        text: messageText(row.message as unknown as TranscriptMessage),
        author: row.author as unknown as PrincipalRef,
        position: row.position,
        queuedAt: row.createdAt.toISOString(),
      })),
    };
  });

const events = orgScoped
  .route({
    method: "GET",
    path: "/runs/{id}/events",
    summary: "Read a run's event log",
    description:
      "Read the run's persisted events in sequence order, from a cursor. Content-private: only a viewer with full access to the run reads its log — the audit view does not. Known event types are validated; unknown types pass through as recorded, for readers newer than this server. A stored event that fails validation is skipped and counted rather than failing the page.",
    tags: ["Runs"],
  })
  .input(
    z.object({
      id: z.string().trim().min(1).describe("The ID of the run whose log to read."),
      after: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Return events with a sequence number greater than this. Defaults to 0."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(RUN_EVENT_PAGE_LIMIT)
        .default(RUN_EVENT_PAGE_SIZE)
        .describe(`How many events to return. Defaults to ${RUN_EVENT_PAGE_SIZE}.`),
    }),
  )
  .output(
    z
      .object({
        events: z
          .array(
            z
              .object({
                seq: z.number().int().describe("One-based sequence number, dense within the run."),
                at: z.string().describe("When the event was recorded. An ISO 8601 date-time."),
                event: eventPayloadSchema,
              })
              .describe("One recorded event."),
          )
          .describe("The page of events, ascending by sequence number."),
        cursor: z
          .number()
          .int()
          .describe("The last sequence number the page covers. Pass it back as `after`."),
        hasMore: z.boolean().describe("Whether events beyond the cursor exist."),
        malformed: z
          .number()
          .int()
          .describe("Recorded events on this page that failed validation and were skipped."),
      })
      .describe("One page of the run's event log."),
  )
  .handler(async ({ context, input }) => {
    const verdict = await resolveRunAccess({
      db: context.db,
      orgId: context.org.id,
      principal: context.principal,
      runId: input.id,
    });
    if (verdict.access !== "full") runNotFound();

    const rows = await context.db.runEvent.findMany({
      where: { orgId: context.org.id, runId: verdict.run.id, seq: { gt: input.after } },
      orderBy: { seq: "asc" },
      // One row past the page answers `hasMore` without a count.
      take: input.limit + 1,
      select: { seq: true, at: true, v: true, event: true },
    });
    const page = rows.slice(0, input.limit);

    let malformed = 0;
    const parsed = page.flatMap((row) => {
      try {
        const result = parseRunEvent({
          runId: verdict.run.id,
          seq: row.seq,
          at: row.at.toISOString(),
          v: row.v,
          event: row.event,
        });
        return [
          {
            seq: row.seq,
            at: row.at.toISOString(),
            event: result.value.event as z.infer<typeof eventPayloadSchema>,
          },
        ];
      } catch {
        // A malformed known event is a fact about the log, not a reason to
        // hide the rest of the page: it is skipped and counted, and the
        // cursor still advances past it.
        malformed += 1;
        return [];
      }
    });

    return {
      events: parsed,
      cursor: page.at(-1)?.seq ?? input.after,
      hasMore: rows.length > input.limit,
      malformed,
    };
  });

const outputTextBlockSchema = z
  .object({
    kind: z.literal("text").describe("Plain text output."),
    text: z.string().describe("The text, cut at the byte cap when it exceeds it."),
    truncated: z.boolean().describe("Whether the text was cut at the byte cap."),
  })
  .describe("One text block of the output.");

const outputImageBlockSchema = z
  .object({
    kind: z.literal("image").describe("Base64-encoded image output."),
    mediaType: z.string().describe("The image's media type, e.g. `image/png`."),
    data: z
      .string()
      .nullable()
      .describe("The base64 image data, or null when the image was omitted for size."),
    omitted: z
      .boolean()
      .describe("Whether the image exceeded the inline cap and its data was omitted."),
  })
  .describe("One image block of the output.");

const output = orgScoped
  .route({
    method: "GET",
    path: "/runs/{id}/outputs/{outputRef}",
    summary: "Read a tool call's full output",
    description:
      "Read the full output behind one tool call, as the run's transcript stores it — the `tool-result` event carries only a summary, and its `outputRef` names what this endpoint resolves. Content-private: only a viewer with full access to the run reads outputs; anyone else — the audit view included — finds nothing, indistinguishable from a run or a reference that does not exist. Text is cut at a byte cap with the cut declared; an oversized image keeps its media type but ships no data.",
    tags: ["Runs"],
  })
  .input(
    z.object({
      id: z.string().trim().min(1).describe("The ID of the run the output belongs to."),
      outputRef: z
        .string()
        .trim()
        .min(1)
        .describe("The output reference from the run's `tool-result` event — the tool call's id."),
    }),
  )
  .output(
    z
      .object({
        callId: z.string().describe("The tool call the output belongs to."),
        status: z
          .enum(["ok", "error", "denied"])
          .describe("How the call ended: its output is a result, an error body, or a refusal."),
        summary: z
          .string()
          .nullable()
          .describe(
            "The summary the run's `tool-result` event carried, when the log has one — so the client renders the expansion without re-joining the event.",
          ),
        blocks: z
          .array(z.discriminatedUnion("kind", [outputTextBlockSchema, outputImageBlockSchema]))
          .describe("The output's content blocks, in transcript order."),
      })
      .describe("One tool call's full output, rendered by content type under size caps."),
  )
  .handler(async ({ context, input }) => {
    const verdict = await resolveRunAccess({
      db: context.db,
      orgId: context.org.id,
      principal: context.principal,
      runId: input.id,
    });
    if (verdict.access !== "full") runNotFound();

    // Full outputs live in the committed turns, keyed by the tool call id —
    // resolution reads the transcript, not the event, so runs recorded before
    // refs were minted still resolve.
    const turns = await context.db.turn.findMany({
      where: { orgId: context.org.id, runId: verdict.run.id },
      orderBy: { index: "asc" },
      select: { toolResults: true },
    });
    const result = turns
      .flatMap((turn) => (Array.isArray(turn.toolResults) ? turn.toolResults : []))
      .map((entry) => entry as unknown as TranscriptMessage)
      .find((message) => message.role === "toolResult" && message.toolCallId === input.outputRef);
    // An unknown reference reads exactly like a run the caller may not see.
    if (result === undefined) runNotFound();

    const eventRow = await context.db.runEvent.findFirst({
      where: {
        orgId: context.org.id,
        runId: verdict.run.id,
        AND: [
          { event: { path: ["type"], equals: "tool-result" } },
          { event: { path: ["callId"], equals: input.outputRef } },
        ],
      },
      orderBy: { seq: "asc" },
      select: { event: true },
    });
    const summary = (eventRow?.event as { summary?: unknown } | undefined)?.summary;

    return {
      callId: input.outputRef,
      status: result.status ?? "ok",
      summary: typeof summary === "string" ? summary : null,
      blocks: renderToolOutputBlocks(result),
    };
  });

const listByThread = orgScoped
  .route({
    method: "GET",
    path: "/threads/{threadRef}/runs",
    summary: "List a thread's runs",
    description:
      "The thread's most recent runs in run order, each with the opening message its log derives — what the run was asked, by whom. Only runs the caller may fully read are listed; a thread whose runs are all invisible is indistinguishable from an empty one.",
    tags: ["Threads"],
  })
  .input(
    z.object({
      threadRef: z.string().trim().min(1).describe("The thread whose runs to list."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(THREAD_RUN_LIST_LIMIT)
        .default(THREAD_RUN_LIST_SIZE)
        .describe(
          `How many of the thread's most recent runs to consider. Defaults to ${THREAD_RUN_LIST_SIZE}.`,
        ),
    }),
  )
  .output(
    z
      .object({
        runs: z
          .array(
            z
              .object({
                id: z.string().describe("The run's unique ID."),
                state: runStateSchema,
                trigger: runTriggerSchema,
                createdAt: z.string().describe("When the run was created. An ISO 8601 date-time."),
                openingMessage: z
                  .object({
                    author: PrincipalRefSchema.describe("Who asked."),
                    text: z.string().describe("What was asked."),
                  })
                  .nullable()
                  .describe(
                    "The message the run opened with, derived from its log. Null for a run nobody messaged — a schedule firing, a resume.",
                  ),
              })
              .describe("One run on the thread."),
          )
          .describe("The runs the caller may read, in run order."),
      })
      .describe("The thread's visible runs."),
  )
  .handler(async ({ context, input }) => {
    // The most recent runs, bounded — the tail is what the thread screen
    // renders. Read newest-first, then restore the (createdAt, id) run order
    // dispatch serializes on: two runs in one millisecond still list stably.
    const rows = (
      await context.db.agentRun.findMany({
        where: { orgId: context.org.id, threadRef: input.threadRef },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
      })
    ).reverse();

    const verdicts = await resolveRunsAccess({
      db: context.db,
      orgId: context.org.id,
      principal: context.principal,
      runs: rows,
    });
    const visible = verdicts.flatMap((verdict) => (verdict.access === "full" ? [verdict.run] : []));
    if (visible.length === 0) return { runs: [] };

    // One query for every visible run's leading events: `seq` is dense from 1,
    // so the window is a `lte` filter rather than a per-run `take`.
    const leading = await context.db.runEvent.findMany({
      where: {
        orgId: context.org.id,
        runId: { in: visible.map((run) => run.id) },
        seq: { lte: OPENING_EVENT_WINDOW },
      },
      orderBy: [{ runId: "asc" }, { seq: "asc" }],
      select: { runId: true, seq: true, at: true, v: true, event: true },
    });
    const leadingByRun = Map.groupBy(leading, (event) => event.runId);

    const runs = visible.map((run) => {
      // Aligned with the events read: recorded events validate before they are
      // used, so a malformed payload — one that would throw here or emerge
      // shaped wrong for the response — costs the run its opening message,
      // never the run or the rest of the thread. Derivation stops at the first
      // malformed row: past it, "what opened this run" cannot be trusted. An
      // *unknown* event type is different — additive by the interface
      // contract, written by a newer server — so it skips rather than
      // terminates: a steering behind it is still the opening.
      const validated: RunEventData[] = [];
      for (const event of leadingByRun.get(run.id) ?? []) {
        try {
          const parsed = parseRunEvent({
            runId: run.id,
            seq: event.seq,
            at: event.at.toISOString(),
            v: event.v,
            event: event.event,
          });
          if (parsed.kind === "unknown") continue;
          validated.push(parsed.value.event as RunEventData);
        } catch {
          break;
        }
      }
      return {
        id: run.id,
        state: run.state,
        trigger: run.trigger,
        createdAt: run.createdAt.toISOString(),
        openingMessage: deriveOpeningMessage(validated),
      };
    });
    return { runs };
  });

export const runsRouter = { get, events, output, listByThread };
