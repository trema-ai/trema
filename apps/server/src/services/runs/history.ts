import type {
  PrincipalRef,
  RunEventData,
  RunState,
  TextBlock,
  TranscriptMessage,
} from "@trema/harness";

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
 * result events need no entry: `tool-start` always precedes them. `segment-end`
 * is handled on its own, because a *completed* segment ends an answer rather
 * than discarding a half-written one.
 */
const CLEARS_TRAILING_TEXT = new Set<RunEventData["type"]>([
  "run-started",
  "steering",
  "tool-start",
  "tool-result",
  "elicitation",
  "error",
]);

/** One prior run's event log, oldest event first. */
export interface ThreadRunLog {
  runId: string;
  events: readonly RunEventData[];
}

/**
 * Where a thread's prior runs end.
 *
 * `createdAt` alone would not say: Postgres timestamps are millisecond-grained,
 * so two runs can share one, and the listing breaks that tie on `id`. The
 * cursor is the same pair the ordering is, which is what makes "before this
 * run" mean exactly "earlier in the listing".
 */
export interface ThreadHistoryCursor {
  createdAt: Date;
  id: string;
}

/** Persistence, tenancy, and bounds for reading a thread's derived history. */
export interface ThreadHistoryOptions {
  db: Database;
  orgId: string;
  threadRef: string;
  /** The run being planned. It is excluded along with anything created after it. */
  runId: string;
  /** Where the run being planned sits in the thread's order, when it is known. */
  before?: ThreadHistoryCursor;
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
 * Per [interface 02](../specs/interface/02-messages.md) a run contributes the
 * messages it was given and the text parts that answered them, and nothing
 * else: activity, reasoning, and elicitation parts are run detail, reachable
 * through the canonical run view.
 *
 * A run holds one exchange, or several when it absorbs a follow-up. An exchange
 * opens at run start and again after `segment-end(completed)` — the boundary
 * the loop writes when the answer is finished and a drained follow-up starts
 * the next one. The `steering` events at an exchange's start are what was
 * asked; steering that lands mid-answer shaped the answer this run already
 * gave, so the lean record keeps the answer and not the correction. Unknown
 * event types are skipped, as everywhere else.
 */
export function deriveRunMessages(events: readonly RunEventData[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const trailing = new Map<string, string>();
  let openingExchange = true;

  const flushAnswer = () => {
    const blocks: TextBlock[] = [...trailing.values()]
      .filter((text) => text.length > 0)
      .map((text) => ({ type: "text", text }));
    trailing.clear();
    if (blocks.length > 0) messages.push(textMessage("assistant", blocks));
  };

  for (const event of events) {
    if (openingExchange && event.type === "steering") {
      messages.push(textMessage("user", [{ type: "text", text: event.text }]));
    } else if (event.type !== "run-started") {
      openingExchange = false;
    }

    switch (event.type) {
      case "text-start":
        trailing.set(event.blockId, trailing.get(event.blockId) ?? "");
        break;
      case "text-delta":
        trailing.set(event.blockId, (trailing.get(event.blockId) ?? "") + event.delta);
        break;
      case "segment-end":
        // A completed segment is an answer; any other reason — a pause above
        // all — leaves half-written text that must not be replayed as one.
        if (event.reason === "completed") {
          flushAnswer();
          openingExchange = true;
        } else {
          trailing.clear();
        }
        break;
      default:
        if (CLEARS_TRAILING_TEXT.has(event.type)) trailing.clear();
        break;
    }
  }

  flushAnswer();
  return messages;
}

/** The message a run opened with, as the log recorded it. */
export interface OpeningMessage {
  author: PrincipalRef;
  text: string;
}

/**
 * Derives the message a run opened with from its log.
 *
 * The rule is {@link deriveRunMessages}'s opening exchange: the `steering`
 * events before anything but `run-started` are what the run was asked, because
 * the loop drains the triggering message into the log at the first turn
 * boundary. The first of them is the opening message; any further leading
 * steers are still in the log, where a projection renders them as steering.
 * A run with no leading steering — a schedule firing, a resume — opened with
 * nothing, and the answer is null.
 */
export function deriveOpeningMessage(events: readonly RunEventData[]): OpeningMessage | null {
  for (const event of events) {
    if (event.type === "steering") return { author: event.author, text: event.text };
    if (event.type !== "run-started") return null;
  }
  return null;
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
      // Ordered before the run being planned, by the same (createdAt, id) the
      // read orders on: a run created in the same millisecond is prior when its
      // id sorts first.
      ...(options.before === undefined
        ? {}
        : {
            OR: [
              { createdAt: { lt: options.before.createdAt } },
              { createdAt: options.before.createdAt, id: { lt: options.before.id } },
            ],
          }),
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
