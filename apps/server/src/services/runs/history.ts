import type { RunEventData, RunState, TextBlock, TranscriptMessage } from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";

/**
 * Prior runs whose exchange is replayed into a new run's context.
 *
 * A failed, cancelled, or stale run still carries the message the person sent,
 * and a retry is a *new* run with nothing queued on it — dropping those runs
 * would leave a retry with no user message at all. What such a run rarely
 * contributes is assistant text: an `error` or a pause clears the trailing
 * text, so a half-finished answer is not replayed as if it were the answer.
 */
const PRIOR_RUN_STATES: RunState[] = ["completed", "failed", "cancelled", "stale"];

/**
 * Default cap on prior runs replayed into a new run's context.
 *
 * A blunt last-N cap, not compaction: budgeting the assembled context is
 * `prepareTurn`'s job, and it is the one that will know the model's window.
 */
export const DEFAULT_THREAD_HISTORY_RUNS = 10;

/**
 * Event types that end a run's trailing text.
 *
 * Anything that follows one of these belongs to a later turn, so the text
 * before it was narration rather than the run's answer. Tool input, note, and
 * result events need no entry: `tool-start` always precedes them.
 */
const CLEARS_TRAILING_TEXT = new Set<RunEventData["type"]>([
  "run-started",
  "steering",
  "tool-start",
  "tool-result",
  "elicitation",
  "segment-end",
  "error",
]);

/** One prior run's event log, oldest event first. */
export interface ThreadRunLog {
  runId: string;
  events: readonly RunEventData[];
}

/** Persistence, tenancy, and bounds for reading a thread's derived history. */
export interface ThreadHistoryOptions {
  db: Database;
  orgId: string;
  threadRef: string;
  /** The run being planned. It is excluded along with anything created after it. */
  runId: string;
  /** Creation time of the run being planned, when it is known. */
  before?: Date;
  /**
   * Cap on prior runs.
   * @defaultValue {@link DEFAULT_THREAD_HISTORY_RUNS}
   */
  limit?: number;
}

function textMessage(role: TranscriptMessage["role"], blocks: TextBlock[]): TranscriptMessage {
  return { role, blocks };
}

/**
 * Derives one run's conversational contribution from its log.
 *
 * Per [interface 02](../specs/interface/02-messages.md) a run contributes its
 * opening message and its final text parts, and nothing else: activity,
 * reasoning, and elicitation parts are run detail, reachable through the
 * canonical run view. The opening message is the leading `steering` run — the
 * input drained at the first turn boundary. Steering that lands mid-run shaped
 * the answer this run already gave, so the lean record keeps the answer and
 * not the correction. Unknown event types are skipped, as everywhere else.
 */
export function deriveRunMessages(events: readonly RunEventData[]): TranscriptMessage[] {
  const opening: TranscriptMessage[] = [];
  const trailing = new Map<string, string>();
  let beforeFirstTurn = true;

  for (const event of events) {
    if (beforeFirstTurn && event.type === "steering") {
      opening.push(textMessage("user", [{ type: "text", text: event.text }]));
    } else if (event.type !== "run-started") {
      beforeFirstTurn = false;
    }

    switch (event.type) {
      case "text-start":
        trailing.set(event.blockId, trailing.get(event.blockId) ?? "");
        break;
      case "text-delta":
        trailing.set(event.blockId, (trailing.get(event.blockId) ?? "") + event.delta);
        break;
      default:
        if (CLEARS_TRAILING_TEXT.has(event.type)) trailing.clear();
        break;
    }
  }

  const blocks: TextBlock[] = [...trailing.values()]
    .filter((text) => text.length > 0)
    .map((text) => ({ type: "text", text }));

  return blocks.length === 0 ? opening : [...opening, textMessage("assistant", blocks)];
}

/** Derives a thread's conversational record from its prior runs' logs, in run order. */
export function deriveThreadMessages(runs: readonly ThreadRunLog[]): TranscriptMessage[] {
  return runs.flatMap((run) => deriveRunMessages(run.events));
}

/**
 * Reads a thread's prior runs and derives the messages a new run starts from.
 *
 * There is no thread-message table: the record is derived from the logs of the
 * runs that came before, which is what keeps it append-only and free of any
 * capture dependency.
 */
export async function readThreadMessages(
  options: ThreadHistoryOptions,
): Promise<TranscriptMessage[]> {
  const rows = await options.db.agentRun.findMany({
    where: {
      orgId: options.orgId,
      threadRef: options.threadRef,
      state: { in: PRIOR_RUN_STATES },
      id: { not: options.runId },
      ...(options.before === undefined ? {} : { createdAt: { lt: options.before } }),
    },
    // The cap keeps the newest runs, so the read orders descending and the
    // derivation flips back to run order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit ?? DEFAULT_THREAD_HISTORY_RUNS,
    select: {
      id: true,
      events: { orderBy: { seq: "asc" }, select: { event: true } },
    },
  });

  const runs: ThreadRunLog[] = rows.reverse().map((row) => ({
    runId: row.id,
    events: row.events.map(({ event }) => event as unknown as RunEventData),
  }));
  return deriveThreadMessages(runs);
}
