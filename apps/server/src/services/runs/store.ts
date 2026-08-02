import type {
  Clock,
  CommitTurnInput,
  CommitTurnResult,
  ElicitationRecord,
  ElicitationResolution,
  IntentClaimMeta,
  QueuedInput,
  RecordIntentResult,
  RecordStopResult,
  ResolveElicitationResult,
  RunEvent,
  RunEventData,
  RunRecord,
  RunState,
  RunStore,
  RunTransitionInput,
  StopRecord,
  TranscriptMessage,
  TurnRecord,
  Usage,
} from "@trema/harness";
import { canTransition } from "@trema/harness";

import type { Prisma } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";

/** Run states a thread still considers active, so a new message steers instead of starting a run. */
const ACTIVE_RUN_STATES: RunState[] = ["queued", "running", "awaiting_approval", "awaiting_input"];

const PARKED_RUN_STATES: RunState[] = ["awaiting_approval", "awaiting_input"];

const UNIQUE_VIOLATION = "P2002";

/** Persistence, tenancy, and time dependencies for the Prisma run store. */
export interface PrismaRunStoreOptions {
  db: Database;
  orgId: string;
  /**
   * Supplies event timestamps.
   * @defaultValue the system clock
   */
  clock?: Clock;
}

type Transaction = Prisma.TransactionClient;

type AgentRunRow = {
  id: string;
  threadRef: string;
  state: RunState;
  trigger: RunRecord["trigger"];
  turnCount: number;
  sessionId: string | null;
  retryOfRunId: string | null;
  retryAttempt: number | null;
  usage: Prisma.JsonValue;
  error: string | null;
  runGrants: string[];
};

type TurnRow = {
  runId: string;
  index: number;
  model: Prisma.JsonValue;
  input: Prisma.JsonValue;
  message: Prisma.JsonValue;
  toolResults: Prisma.JsonValue;
  pendingCallId: string | null;
  pendingElicitationId: string | null;
  stopReason: TurnRecord["stopReason"];
  usage: Prisma.JsonValue;
};

type RunEventRow = {
  runId: string;
  seq: number;
  at: Date;
  v: number;
  event: Prisma.JsonValue;
};

type QueuedInputRow = {
  id: string;
  message: Prisma.JsonValue;
  author: Prisma.JsonValue;
  modelProviderName: string | null;
  modelModelId: string | null;
};

type QueuedInputWithModel = QueuedInput & { model?: { providerName: string; modelId: string } };

type ElicitationRow = {
  id: string;
  runId: string;
  event: Prisma.JsonValue;
  expiresAt: Date | null;
  resolution: Prisma.JsonValue;
};

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

function toRunRecord(row: AgentRunRow): RunRecord {
  return {
    id: row.id,
    threadRef: row.threadRef,
    state: row.state,
    trigger: row.trigger,
    turnCount: row.turnCount,
    runGrants: row.runGrants,
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    ...(row.retryOfRunId === null ? {} : { retryOfRunId: row.retryOfRunId }),
    ...(row.retryAttempt === null ? {} : { retryAttempt: row.retryAttempt }),
    ...(row.usage === null ? {} : { usage: row.usage as unknown as Usage }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function toTurnRecord(row: TurnRow): TurnRecord {
  const input = row.input as unknown as TranscriptMessage[] | null;
  return {
    runId: row.runId,
    index: row.index,
    model: row.model as unknown as TurnRecord["model"],
    ...(input === null || input.length === 0 ? {} : { input }),
    message: row.message as unknown as TranscriptMessage,
    toolResults: row.toolResults as unknown as TranscriptMessage[],
    stopReason: row.stopReason,
    usage: row.usage as unknown as TurnRecord["usage"],
    ...(row.pendingCallId === null || row.pendingElicitationId === null
      ? {}
      : {
          pendingToolCall: {
            callId: row.pendingCallId,
            elicitationId: row.pendingElicitationId,
          },
        }),
  };
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    runId: row.runId,
    seq: row.seq,
    at: row.at.toISOString(),
    v: 1,
    event: row.event as unknown as RunEventData,
  };
}

function toQueuedInput(row: QueuedInputRow): QueuedInputWithModel {
  return {
    id: row.id,
    message: row.message as unknown as TranscriptMessage,
    author: row.author as unknown as QueuedInput["author"],
    ...(row.modelProviderName === null || row.modelModelId === null
      ? {}
      : { model: { providerName: row.modelProviderName, modelId: row.modelModelId } }),
  };
}

function toElicitationRecord(row: ElicitationRow): ElicitationRecord {
  return {
    runId: row.runId,
    event: row.event as unknown as ElicitationRecord["event"],
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt.toISOString() }),
    ...(row.resolution === null
      ? {}
      : { resolution: row.resolution as unknown as ElicitationResolution }),
  };
}

/**
 * The `RunStore` port on Postgres, scoped to one organization.
 *
 * Every write that hands out an event `seq` allocates it with an
 * `UPDATE "AgentRun" SET "lastEventSeq" = "lastEventSeq" + n RETURNING`, in the
 * same transaction as the event rows and any state change. The row lock that
 * update takes is what keeps the sequence dense under concurrent appends, and
 * the unique `(runId, seq)` index rejects a duplicate that reached the table
 * some other way.
 */
export class PrismaRunStore implements RunStore {
  readonly #db: Database;
  readonly #orgId: string;
  readonly #clock: Clock;

  constructor(options: PrismaRunStoreOptions) {
    this.#db = options.db;
    this.#orgId = options.orgId;
    this.#clock = options.clock ?? { now: () => new Date().toISOString() };
  }

  async createRun(run: RunRecord): Promise<void> {
    try {
      await this.#db.agentRun.create({
        data: {
          id: run.id,
          orgId: this.#orgId,
          threadRef: run.threadRef,
          state: run.state,
          trigger: run.trigger,
          turnCount: run.turnCount,
          runGrants: run.runGrants ?? [],
          ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
          ...(run.retryOfRunId === undefined ? {} : { retryOfRunId: run.retryOfRunId }),
          ...(run.retryAttempt === undefined ? {} : { retryAttempt: run.retryAttempt }),
          ...(run.usage === undefined ? {} : { usage: json(run.usage) }),
          ...(run.error === undefined ? {} : { error: run.error }),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error(`run already exists: ${run.id}`);
      throw error;
    }
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const row = await this.#db.agentRun.findUnique({
      where: { orgId_id: { orgId: this.#orgId, id: runId } },
    });
    return row === null ? undefined : toRunRecord(row);
  }

  async findActiveRun(threadRef: string): Promise<RunRecord | undefined> {
    const row = await this.#db.agentRun.findFirst({
      where: { orgId: this.#orgId, threadRef, state: { in: ACTIVE_RUN_STATES } },
      orderBy: { createdAt: "desc" },
    });
    return row === null ? undefined : toRunRecord(row);
  }

  async updateRunState(runId: string, state: RunState): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      await this.#lockRun(tx, runId, state);
      await tx.agentRun.update({ where: { id: runId }, data: { state } });
    });
  }

  async transitionRun(input: RunTransitionInput): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      await this.#lockRun(tx, input.runId, input.state);
      await tx.agentRun.update({
        where: { id: input.runId },
        data: {
          state: input.state,
          ...(input.usage === undefined ? {} : { usage: json(input.usage) }),
          ...(input.error === undefined ? {} : { error: input.error }),
        },
      });
      if (input.event !== undefined) await this.#append(tx, input.runId, [input.event]);
    });
  }

  async listTurns(runId: string): Promise<TurnRecord[]> {
    const rows = await this.#db.turn.findMany({
      where: { orgId: this.#orgId, runId },
      orderBy: { index: "asc" },
    });
    return rows.map(toTurnRecord);
  }

  async commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
    const { turn } = input;
    await this.#db.$transaction(async (tx) => {
      const run = await this.#lockRun(tx, turn.runId, input.state);
      if (turn.index !== run.turnCount) {
        throw new Error(`turn index ${turn.index} is not next for run ${turn.runId}`);
      }

      await tx.turn.create({
        data: {
          orgId: this.#orgId,
          runId: turn.runId,
          index: turn.index,
          model: json(turn.model),
          input: json(turn.input ?? []),
          message: json(turn.message),
          toolResults: json(turn.toolResults),
          stopReason: turn.stopReason,
          usage: json(turn.usage),
          ...(turn.pendingToolCall === undefined
            ? {}
            : {
                pendingCallId: turn.pendingToolCall.callId,
                pendingElicitationId: turn.pendingToolCall.elicitationId,
              }),
        },
      });
      await tx.agentRun.update({
        where: { id: turn.runId },
        data: {
          turnCount: turn.index + 1,
          ...(input.state === undefined ? {} : { state: input.state }),
        },
      });
      await this.#append(tx, turn.runId, input.events ?? []);
      if (input.elicitation !== undefined) {
        const record = input.elicitation;
        await tx.runElicitation.create({
          data: {
            id: record.event.elicitationId,
            orgId: this.#orgId,
            runId: record.runId,
            event: json(record.event),
            ...(record.expiresAt === undefined ? {} : { expiresAt: new Date(record.expiresAt) }),
            ...(record.resolution === undefined ? {} : { resolution: json(record.resolution) }),
          },
        });
      }
    });
    return { turn };
  }

  async completePendingTurn(
    runId: string,
    turnIndex: number,
    toolResults: TranscriptMessage[],
  ): Promise<void> {
    // The pending guard makes completion single-shot: a duplicate resume finds
    // the call already cleared and must not rewrite a committed turn.
    const updated = await this.#db.turn.updateMany({
      where: { orgId: this.#orgId, runId, index: turnIndex, pendingCallId: { not: null } },
      data: {
        toolResults: json(toolResults),
        pendingCallId: null,
        pendingElicitationId: null,
        stopReason: "toolUse",
      },
    });
    if (updated.count === 0) throw new Error(`no pending turn to complete: ${runId}/${turnIndex}`);
  }

  async appendEvent(runId: string, event: RunEventData): Promise<RunEvent> {
    return this.#db.$transaction(async (tx) => {
      const [appended] = await this.#append(tx, runId, [event]);
      if (appended === undefined) throw new Error(`event was not appended: ${runId}`);
      return appended;
    });
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.#db.runEvent.findMany({
      where: { orgId: this.#orgId, runId },
      orderBy: { seq: "asc" },
    });
    return rows.map(toRunEvent);
  }

  async eventCursor(runId: string): Promise<number> {
    const row = await this.#db.agentRun.findUnique({
      where: { orgId_id: { orgId: this.#orgId, id: runId } },
      select: { lastEventSeq: true },
    });
    if (row === null) throw new Error(`unknown run: ${runId}`);
    return row.lastEventSeq;
  }

  async discardEventsAfter(runId: string, cursor: number): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ lastEventSeq: number }[]>`
        SELECT "lastEventSeq" FROM "AgentRun"
        WHERE "id" = ${runId} AND "orgId" = ${this.#orgId}
        FOR UPDATE`;
      if (row === undefined) throw new Error(`unknown run: ${runId}`);
      if (cursor < 0 || cursor > row.lastEventSeq) {
        throw new Error(`invalid event cursor: ${cursor}`);
      }
      await tx.runEvent.deleteMany({ where: { runId, seq: { gt: cursor } } });
      await tx.agentRun.update({ where: { id: runId }, data: { lastEventSeq: cursor } });
    });
  }

  async enqueueSteering(runId: string, input: QueuedInput): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const run = await tx.agentRun.findUnique({
        where: { orgId_id: { orgId: this.#orgId, id: runId } },
        select: { threadRef: true },
      });
      if (run === null) throw new Error(`unknown run: ${runId}`);
      const inserted = await tx.runQueuedInput.createMany({
        data: [
          {
            id: input.id,
            orgId: this.#orgId,
            kind: "steering",
            runId,
            threadRef: run.threadRef,
            message: json(input.message),
            author: json(input.author),
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        const existing = await tx.runQueuedInput.findUnique({
          where: { id: input.id },
          select: { orgId: true, kind: true, runId: true },
        });
        if (
          existing?.orgId !== this.#orgId ||
          existing.kind !== "steering" ||
          existing.runId !== runId
        ) {
          throw new Error(`queued input id belongs to a different route: ${input.id}`);
        }
      }
      // Steering is routed once the input and claim commit together. A new
      // run records its id before reaching this method, so this guard changes
      // only an active-run message whose claim was still unresolved.
      await tx.runIntent.updateMany({
        where: { orgId: this.#orgId, id: input.id, runId: null },
        data: { runId, outcome: "steered" },
      });
    });
  }

  async drainSteering(runId: string): Promise<QueuedInput[]> {
    const run = await this.#db.agentRun.findUnique({
      where: { orgId_id: { orgId: this.#orgId, id: runId } },
      select: { id: true },
    });
    if (run === null) throw new Error(`unknown run: ${runId}`);
    return this.#drain({ orgId: this.#orgId, kind: "steering", runId });
  }

  async hasSteering(runId: string): Promise<boolean> {
    const run = await this.#db.agentRun.findUnique({
      where: { orgId_id: { orgId: this.#orgId, id: runId } },
      select: { id: true },
    });
    if (run === null) throw new Error(`unknown run: ${runId}`);
    const queued = await this.#db.runQueuedInput.count({
      where: { orgId: this.#orgId, kind: "steering", runId },
    });
    return queued > 0;
  }

  async enqueueFollowUp(threadRef: string, input: QueuedInput): Promise<void> {
    const model = (input as QueuedInputWithModel).model;
    await this.#db.runQueuedInput.create({
      data: {
        id: input.id,
        orgId: this.#orgId,
        kind: "follow_up",
        threadRef,
        message: json(input.message),
        author: json(input.author),
        ...(model === undefined
          ? {}
          : {
              modelProviderName: model.providerName,
              modelModelId: model.modelId,
            }),
      },
    });
  }

  async drainFollowUps(threadRef: string): Promise<QueuedInput[]> {
    return this.#drain({ orgId: this.#orgId, kind: "follow_up", threadRef });
  }

  async recordIntent(intentId: string, meta?: IntentClaimMeta): Promise<RecordIntentResult> {
    try {
      await this.#db.runIntent.create({
        data: {
          id: intentId,
          orgId: this.#orgId,
          ...(meta === undefined ? {} : { kind: meta.kind }),
          ...(meta?.targetId === undefined ? {} : { targetId: meta.targetId }),
        },
      });
      return "recorded";
    } catch (error) {
      if (isUniqueViolation(error)) return "duplicate";
      throw error;
    }
  }

  async recordStop(stop: StopRecord): Promise<RecordStopResult> {
    return this.#db.$transaction(async (tx) => {
      // The recheck shares the row lock with the insert: a run finishing
      // concurrently commits its terminal state either before this lock (and
      // the stop reports the loss) or after it (and the stop fact stands).
      const [row] = await tx.$queryRaw<{ state: RunState }[]>`
        SELECT "state" FROM "AgentRun"
        WHERE "id" = ${stop.runId} AND "orgId" = ${this.#orgId}
        FOR UPDATE`;
      if (row === undefined) throw new Error(`unknown run: ${stop.runId}`);
      if (!ACTIVE_RUN_STATES.includes(row.state)) return "run-not-active";
      // The first stop fact wins; `skipDuplicates` keeps a second request
      // from aborting the transaction.
      await tx.runStop.createMany({
        data: [
          {
            runId: stop.runId,
            orgId: this.#orgId,
            intentId: stop.intentId,
            by: json(stop.by),
            at: new Date(stop.at),
          },
        ],
        skipDuplicates: true,
      });
      return "recorded";
    });
  }

  async getStop(runId: string): Promise<StopRecord | undefined> {
    const row = await this.#db.runStop.findFirst({ where: { orgId: this.#orgId, runId } });
    if (row === null) return undefined;
    return {
      intentId: row.intentId,
      runId: row.runId,
      by: row.by as unknown as StopRecord["by"],
      at: row.at.toISOString(),
    };
  }

  async getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined> {
    const row = await this.#db.runElicitation.findUnique({
      where: { orgId_id: { orgId: this.#orgId, id: elicitationId } },
    });
    return row === null ? undefined : toElicitationRecord(row);
  }

  async resolveElicitation(
    elicitationId: string,
    resolution: ElicitationResolution,
  ): Promise<ResolveElicitationResult> {
    return this.#db.$transaction(async (tx) => {
      const record = await this.#lockElicitation(tx, elicitationId);
      if (record.resolution !== undefined) return "already-resolved";

      await tx.runElicitation.update({
        where: { orgId_id: { orgId: this.#orgId, id: elicitationId } },
        data: { resolution: json(resolution) },
      });
      await this.#append(tx, record.runId, [
        {
          type: "elicitation-resolved",
          elicitationId,
          optionId: resolution.optionId,
          by: resolution.by,
          at: resolution.at,
        },
      ]);
      if (resolution.scope === "run") {
        const toolName = await this.#pendingToolName(tx, record);
        if (toolName !== undefined) {
          const run = await tx.agentRun.findUniqueOrThrow({
            where: { id: record.runId },
            select: { runGrants: true },
          });
          await tx.agentRun.update({
            where: { id: record.runId },
            data: { runGrants: [...new Set([...run.runGrants, toolName])] },
          });
        }
      }
      return "resolved";
    });
  }

  async expireElicitation(
    elicitationId: string,
    by: ElicitationResolution["by"],
    at: string,
  ): Promise<ResolveElicitationResult> {
    return this.#db.$transaction(async (tx) => {
      const record = await this.#lockElicitation(tx, elicitationId);
      if (record.resolution !== undefined) return "already-resolved";
      const run = await tx.agentRun.findUniqueOrThrow({
        where: { id: record.runId },
        select: { id: true, state: true },
      });
      if (!PARKED_RUN_STATES.includes(run.state)) {
        throw new Error(`run is not parked: ${run.id}`);
      }

      const resolution: ElicitationResolution = {
        optionId: "expired",
        decision: "expired",
        scope: "once",
        by,
        at,
      };
      await tx.runElicitation.update({
        where: { orgId_id: { orgId: this.#orgId, id: elicitationId } },
        data: { resolution: json(resolution) },
      });
      await tx.agentRun.update({ where: { id: run.id }, data: { state: "stale" } });
      await this.#append(tx, run.id, [
        { type: "elicitation-resolved", elicitationId, optionId: "expired", by, at },
      ]);
      return "resolved";
    });
  }

  /**
   * Allocates `events.length` sequence numbers and writes the envelopes.
   * The allocating update locks the run row for the rest of the transaction,
   * which is what serializes concurrent appends into a dense sequence.
   */
  async #append(tx: Transaction, runId: string, events: RunEventData[]): Promise<RunEvent[]> {
    if (events.length === 0) return [];
    const [allocated] = await tx.$queryRaw<{ lastEventSeq: number }[]>`
      UPDATE "AgentRun" SET "lastEventSeq" = "lastEventSeq" + ${events.length}
      WHERE "id" = ${runId} AND "orgId" = ${this.#orgId}
      RETURNING "lastEventSeq"`;
    if (allocated === undefined) throw new Error(`unknown run: ${runId}`);

    const at = new Date(this.#clock.now());
    const base = allocated.lastEventSeq - events.length;
    const envelopes = events.map((event, offset) => ({
      runId,
      seq: base + offset + 1,
      at: at.toISOString(),
      v: 1 as const,
      event,
    }));
    await tx.runEvent.createMany({
      data: envelopes.map((envelope) => ({
        orgId: this.#orgId,
        runId,
        seq: envelope.seq,
        at,
        event: json(envelope.event),
      })),
    });
    return envelopes;
  }

  /**
   * Locks one run row and rejects an illegal transition before any write.
   * @throws {Error} When the run does not exist or the transition is illegal.
   */
  async #lockRun(
    tx: Transaction,
    runId: string,
    next?: RunState,
  ): Promise<{ state: RunState; turnCount: number }> {
    const [row] = await tx.$queryRaw<{ state: RunState; turnCount: number }[]>`
      SELECT "state", "turnCount" FROM "AgentRun"
      WHERE "id" = ${runId} AND "orgId" = ${this.#orgId}
      FOR UPDATE`;
    if (row === undefined) throw new Error(`unknown run: ${runId}`);
    if (next !== undefined && !canTransition(row.state, next)) {
      throw new Error(`illegal run state transition: ${row.state} -> ${next}`);
    }
    return row;
  }

  /**
   * Locks one elicitation row so only the first resolution attempt writes.
   * @throws {Error} When the elicitation does not exist.
   */
  async #lockElicitation(tx: Transaction, elicitationId: string): Promise<ElicitationRecord> {
    const [row] = await tx.$queryRaw<ElicitationRow[]>`
      SELECT "id", "runId", "event", "expiresAt", "resolution" FROM "RunElicitation"
      WHERE "id" = ${elicitationId} AND "orgId" = ${this.#orgId}
      FOR UPDATE`;
    if (row === undefined) throw new Error(`unknown elicitation: ${elicitationId}`);
    return toElicitationRecord(row);
  }

  async #pendingToolName(tx: Transaction, record: ElicitationRecord): Promise<string | undefined> {
    const callId = record.event.reference?.callId;
    if (callId === undefined) return undefined;
    const turns = await tx.turn.findMany({
      where: { orgId: this.#orgId, runId: record.runId },
      orderBy: { index: "asc" },
      select: { message: true },
    });
    for (const turn of turns) {
      const message = turn.message as unknown as TranscriptMessage;
      const block = message.blocks.find(
        (candidate) => candidate.type === "toolCall" && candidate.callId === callId,
      );
      if (block?.type === "toolCall") return block.name;
    }
    return undefined;
  }

  /**
   * Claims and removes queued input in one statement, so each row reaches
   * exactly one drainer. The `FOR UPDATE` serializes overlapping drains: the
   * later one waits, then finds the rows already deleted and returns empty
   * rather than a duplicate or a split of the queue.
   */
  async #drain(where: {
    orgId: string;
    kind: "steering" | "follow_up";
    runId?: string;
    threadRef?: string;
  }): Promise<QueuedInput[]> {
    const runId = where.runId ?? null;
    const threadRef = where.threadRef ?? null;
    const rows = await this.#db.$queryRaw<(QueuedInputRow & { position: number })[]>`
      WITH claimed AS (
        SELECT "id" FROM "RunQueuedInput"
        WHERE "orgId" = ${where.orgId}
          AND "kind" = ${where.kind}::"RunInputKind"
          AND (${runId}::text IS NULL OR "runId" = ${runId})
          AND (${threadRef}::text IS NULL OR "threadRef" = ${threadRef})
        ORDER BY "position"
        FOR UPDATE
      )
      DELETE FROM "RunQueuedInput" AS q
      USING claimed
      WHERE q."id" = claimed."id"
      RETURNING q."id", q."message", q."author",
        q."modelProviderName", q."modelModelId", q."position"`;
    return rows.sort((a, b) => a.position - b.position).map(toQueuedInput);
  }
}
