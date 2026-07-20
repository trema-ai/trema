import { canTransition } from "../core/index.js";
import type { RunState } from "../core/index.js";
import type { RunEvent, RunEventData } from "../events/index.js";
import type {
  Clock,
  CommitTurnInput,
  CommitTurnResult,
  QueuedInput,
  RunRecord,
  RunStore,
  TurnRecord,
} from "../ports/index.js";

export class InMemoryRunStore implements RunStore {
  readonly #clock: Clock;
  readonly #runs = new Map<string, RunRecord>();
  readonly #turns = new Map<string, TurnRecord[]>();
  readonly #events = new Map<string, RunEvent[]>();
  readonly #steering = new Map<string, QueuedInput[]>();
  readonly #followUps = new Map<string, QueuedInput[]>();

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

  async updateRunState(runId: string, state: RunState): Promise<void> {
    const run = this.#requireRun(runId);
    if (!canTransition(run.state, state)) {
      throw new Error(`illegal run state transition: ${run.state} -> ${state}`);
    }
    this.#runs.set(runId, { ...run, state });
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

    turns.push(input.turn);
    this.#runs.set(run.id, { ...run, turnCount: turns.length });
    return { turn: input.turn };
  }

  async appendEvent(runId: string, event: RunEventData): Promise<RunEvent> {
    this.#requireRun(runId);
    return this.#append(runId, event);
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return [...this.#requireEvents(runId)];
  }

  async enqueueSteering(runId: string, input: QueuedInput): Promise<void> {
    const queue = this.#steering.get(runId);
    if (queue === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
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
