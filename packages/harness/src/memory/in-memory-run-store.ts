import type { RunState } from "#harness/core/index.js";
import { canTransition } from "#harness/core/index.js";
import type { RunEvent, RunEventData } from "#harness/events/index.js";
import type {
  Clock,
  CommitTurnInput,
  CommitTurnResult,
  ElicitationRecord,
  ElicitationResolution,
  IntentClaimMeta,
  QueuedInput,
  RecordStopResult,
  RunRecord,
  RunStore,
  RunTransitionInput,
  StopRecord,
  TurnRecord,
} from "#harness/ports/index.js";

/** Run states a stop can still reach; terminal states refuse the fact. */
const ACTIVE_RUN_STATES: RunState[] = ["queued", "running", "awaiting_approval", "awaiting_input"];

/** In-memory reference implementation of the complete `RunStore` contract. */
export class InMemoryRunStore implements RunStore {
  readonly #clock: Clock;
  readonly #runs = new Map<string, RunRecord>();
  readonly #turns = new Map<string, TurnRecord[]>();
  readonly #events = new Map<string, RunEvent[]>();
  readonly #steering = new Map<string, QueuedInput[]>();
  readonly #followUps = new Map<string, QueuedInput[]>();
  readonly #intents = new Map<string, IntentClaimMeta | undefined>();
  readonly #stops = new Map<string, StopRecord>();
  readonly #elicitations = new Map<string, ElicitationRecord>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async createRun(run: RunRecord): Promise<void> {
    if (this.#runs.has(run.id)) {
      throw new Error(`run already exists: ${run.id}`);
    }
    this.#runs.set(run.id, { ...run });
    this.#turns.set(run.id, []);
    this.#events.set(run.id, []);
    this.#steering.set(run.id, []);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.#runs.get(runId);
    return run === undefined ? undefined : { ...run };
  }

  async findActiveRun(threadRef: string): Promise<RunRecord | undefined> {
    const active = [...this.#runs.values()]
      .filter((run) => run.threadRef === threadRef && ACTIVE_RUN_STATES.includes(run.state))
      .at(-1);
    return active === undefined ? undefined : { ...active };
  }

  async updateRunState(runId: string, state: RunState): Promise<void> {
    const run = this.#requireRun(runId);
    if (!canTransition(run.state, state)) {
      throw new Error(`illegal run state transition: ${run.state} -> ${state}`);
    }
    this.#runs.set(runId, { ...run, state });
  }

  async transitionRun(input: RunTransitionInput): Promise<void> {
    const run = this.#requireRun(input.runId);
    if (!canTransition(run.state, input.state)) {
      throw new Error(`illegal run state transition: ${run.state} -> ${input.state}`);
    }
    this.#runs.set(input.runId, {
      ...run,
      state: input.state,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    if (input.event !== undefined) this.#append(input.runId, input.event);
  }

  async listTurns(runId: string): Promise<TurnRecord[]> {
    return [...this.#requireTurns(runId)];
  }

  async commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
    const run = this.#requireRun(input.turn.runId);
    const turns = this.#requireTurns(input.turn.runId);
    if (input.turn.index !== turns.length) {
      throw new Error(`turn index ${input.turn.index} is not next for run ${input.turn.runId}`);
    }

    if (input.state !== undefined && !canTransition(run.state, input.state)) {
      throw new Error(`illegal run state transition: ${run.state} -> ${input.state}`);
    }

    turns.push(input.turn);
    this.#runs.set(run.id, {
      ...run,
      turnCount: turns.length,
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    for (const event of input.events ?? []) this.#append(run.id, event);
    if (input.elicitation !== undefined) {
      this.#elicitations.set(input.elicitation.event.elicitationId, input.elicitation);
    }
    return { turn: input.turn };
  }

  async completePendingTurn(
    runId: string,
    turnIndex: number,
    toolResults: TurnRecord["toolResults"],
  ): Promise<void> {
    const turns = this.#requireTurns(runId);
    const turn = turns[turnIndex];
    if (turn === undefined) throw new Error(`unknown turn: ${runId}/${turnIndex}`);
    // Completion is single-shot: a turn without a pending call is committed,
    // and a duplicate resume must not rewrite it.
    if (turn.pendingToolCall === undefined) {
      throw new Error(`no pending turn to complete: ${runId}/${turnIndex}`);
    }
    const { pendingToolCall: _pendingToolCall, ...completed } = turn;
    turns[turnIndex] = { ...completed, toolResults: [...toolResults], stopReason: "toolUse" };
  }

  async appendEvent(runId: string, event: RunEventData): Promise<RunEvent> {
    this.#requireRun(runId);
    return this.#append(runId, event);
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return [...this.#requireEvents(runId)];
  }

  async eventCursor(runId: string): Promise<number> {
    return this.#requireEvents(runId).length;
  }

  async discardEventsAfter(runId: string, cursor: number): Promise<void> {
    const events = this.#requireEvents(runId);
    if (cursor < 0 || cursor > events.length) throw new Error(`invalid event cursor: ${cursor}`);
    events.splice(cursor);
  }

  async enqueueSteering(runId: string, input: QueuedInput): Promise<void> {
    const queue = this.#steering.get(runId);
    if (queue === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    if (queue.some((queued) => queued.id === input.id)) return;
    queue.push(input);
  }

  async drainSteering(runId: string): Promise<QueuedInput[]> {
    const queue = this.#steering.get(runId);
    if (queue === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    this.#steering.set(runId, []);
    return [...queue];
  }

  async hasSteering(runId: string): Promise<boolean> {
    const queue = this.#steering.get(runId);
    if (queue === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    return queue.length > 0;
  }

  async enqueueFollowUp(threadRef: string, input: QueuedInput): Promise<void> {
    const queue = this.#followUps.get(threadRef) ?? [];
    queue.push(input);
    this.#followUps.set(threadRef, queue);
  }

  async drainFollowUps(threadRef: string): Promise<QueuedInput[]> {
    const queue = this.#followUps.get(threadRef) ?? [];
    this.#followUps.set(threadRef, []);
    return [...queue];
  }

  async recordIntent(intentId: string, meta?: IntentClaimMeta): Promise<"recorded" | "duplicate"> {
    if (this.#intents.has(intentId)) return "duplicate";
    this.#intents.set(intentId, meta);
    return "recorded";
  }

  async recordStop(stop: StopRecord): Promise<RecordStopResult> {
    const run = this.#requireRun(stop.runId);
    if (!ACTIVE_RUN_STATES.includes(run.state)) return "run-not-active";
    if (!this.#stops.has(stop.runId)) this.#stops.set(stop.runId, stop);
    return "recorded";
  }

  async getStop(runId: string): Promise<StopRecord | undefined> {
    const stop = this.#stops.get(runId);
    return stop === undefined ? undefined : { ...stop };
  }

  async getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined> {
    const record = this.#elicitations.get(elicitationId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async resolveElicitation(
    elicitationId: string,
    resolution: ElicitationResolution,
  ): Promise<"resolved" | "already-resolved"> {
    const record = this.#elicitations.get(elicitationId);
    if (record === undefined) throw new Error(`unknown elicitation: ${elicitationId}`);
    if (record.resolution !== undefined) return "already-resolved";
    const run = this.#requireRun(record.runId);
    const event = {
      type: "elicitation-resolved" as const,
      elicitationId,
      optionId: resolution.optionId,
      by: resolution.by,
      at: resolution.at,
    };
    this.#elicitations.set(elicitationId, { ...record, resolution });
    this.#append(record.runId, event);
    if (resolution.scope === "run") {
      const toolKey = pendingToolName(this.#requireTurns(record.runId), record.event);
      if (toolKey !== undefined) {
        this.#runs.set(run.id, {
          ...run,
          runGrants: [...new Set([...(run.runGrants ?? []), toolKey])],
        });
      }
    }
    return "resolved";
  }

  async expireElicitation(
    elicitationId: string,
    by: { principalId: string; displayName?: string },
    at: string,
  ): Promise<"resolved" | "already-resolved"> {
    const record = this.#elicitations.get(elicitationId);
    if (record === undefined) throw new Error(`unknown elicitation: ${elicitationId}`);
    if (record.resolution !== undefined) return "already-resolved";
    const run = this.#requireRun(record.runId);
    if (!["awaiting_approval", "awaiting_input"].includes(run.state)) {
      throw new Error(`run is not parked: ${run.id}`);
    }
    const resolution: ElicitationResolution = {
      optionId: "expired",
      decision: "expired",
      scope: "once",
      by,
      at,
    };
    this.#elicitations.set(elicitationId, { ...record, resolution });
    this.#runs.set(run.id, { ...run, state: "stale" });
    this.#append(run.id, {
      type: "elicitation-resolved",
      elicitationId,
      optionId: "expired",
      by,
      at,
    });
    return "resolved";
  }

  #append(runId: string, event: RunEventData): RunEvent {
    const events = this.#requireEvents(runId);
    const envelope: RunEvent = {
      runId,
      seq: events.length + 1,
      at: this.#clock.now(),
      v: 1,
      event,
    };
    events.push(envelope);
    return envelope;
  }

  #requireRun(runId: string): RunRecord {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    return run;
  }

  #requireTurns(runId: string): TurnRecord[] {
    const turns = this.#turns.get(runId);
    if (turns === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    return turns;
  }

  #requireEvents(runId: string): RunEvent[] {
    const events = this.#events.get(runId);
    if (events === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    return events;
  }
}

function pendingToolName(
  turns: TurnRecord[],
  event: ElicitationRecord["event"],
): string | undefined {
  const callId = event.reference?.callId;
  if (callId === undefined) return undefined;
  for (const turn of turns) {
    const block = turn.message.blocks.find(
      (candidate) => candidate.type === "toolCall" && candidate.callId === callId,
    );
    if (block?.type === "toolCall") return block.name;
  }
  return undefined;
}
