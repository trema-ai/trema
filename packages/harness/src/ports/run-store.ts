import type {
  ModelRef,
  RunState,
  StopReason,
  TranscriptMessage,
  Trigger,
  Usage,
} from "#harness/core/index.js";
import type { PrincipalRef, RunEvent, RunEventData } from "#harness/events/index.js";

/** Durable metadata and aggregate outcome for one run. */
export interface RunRecord {
  id: string;
  threadRef: string;
  state: RunState;
  trigger: Trigger;
  /** Number of committed turns. */
  turnCount: number;
  sessionId?: string;
  /** Run that this retry follows. */
  retryOfRunId?: string;
  /** One-based retry attempt across a retry chain. */
  retryAttempt?: number;
  usage?: Usage;
  error?: string;
  /** Tool names approved for the remainder of this run. */
  runGrants?: string[];
}

/** Durable checkpoint for one completed or paused turn. */
export interface TurnRecord {
  runId: string;
  /** Zero-based index that must follow the prior committed turn. */
  index: number;
  model: ModelRef;
  /**
   * Input delivered to the model at this turn's boundary — steering and
   * follow-ups drained just before the call, in delivery order.
   *
   * A resumed execution rebuilds the model context from committed turns, so
   * the turn that consumed the input is where the input has to be recorded.
   * The `steering` event says *when* the run absorbed a message; this says
   * *what* the model was given, whole and in place.
   */
  input?: TranscriptMessage[];
  message: TranscriptMessage;
  /** Tool results already completed for this turn. */
  toolResults: TranscriptMessage[];
  /** Tool call awaiting resolution before this turn can finish. */
  pendingToolCall?: { callId: string; elicitationId: string };
  stopReason: StopReason;
  usage: Usage;
}

/** Values committed atomically with a turn checkpoint. */
export interface CommitTurnInput {
  turn: TurnRecord;
  events?: RunEventData[];
  state?: RunState;
  elicitation?: ElicitationRecord;
}

/** Turn checkpoint returned after a successful commit. */
export interface CommitTurnResult {
  turn: TurnRecord;
}

/** User input queued for an active run or its thread. */
export interface QueuedInput {
  id: string;
  message: TranscriptMessage;
  author: PrincipalRef;
}

/** Durable fact that a principal requested a run to stop. */
export interface StopRecord {
  intentId: string;
  runId: string;
  by: PrincipalRef;
  at: string;
}

/** Lifetime requested for an elicitation resolution. */
export type ResolutionScope = "once" | "run" | "always";

/** Durable decision for one elicitation. */
export interface ElicitationResolution {
  optionId: string;
  decision: "approved" | "denied" | "answered" | "expired";
  scope: ResolutionScope;
  by: PrincipalRef;
  at: string;
  reason?: string;
}

/** Blocking elicitation and its optional terminal resolution. */
export interface ElicitationRecord {
  runId: string;
  event: Extract<RunEventData, { type: "elicitation" }>;
  /** Standard date-time string after which the elicitation can expire. */
  expiresAt?: string;
  resolution?: ElicitationResolution;
}

/** State transition and optional outcome data committed together. */
export interface RunTransitionInput {
  runId: string;
  state: RunState;
  event?: RunEventData;
  usage?: Usage;
  error?: string;
}

/** Result of atomically claiming an intent identifier. */
export type RecordIntentResult = "recorded" | "duplicate";
/** Result of recording a stop fact with its atomic active-state recheck. */
export type RecordStopResult = "recorded" | "run-not-active";

/**
 * What an intent claim was made for. A duplicate whose kind or target differs
 * from the claim is a mismatched reuse of the id, never a replay to answer.
 */
export interface IntentClaimMeta {
  kind: string;
  /** The run or elicitation the intent addressed, when it had one. */
  targetId?: string;
  /** Caller-controlled routing values, used to reject a changed idempotent retry. */
  requestHash?: string;
}
/** Result of the first or a later elicitation resolution attempt. */
export type ResolveElicitationResult = "resolved" | "already-resolved";

/** Durable persistence contract for runs, turns, events, queues, and elicitations. */
export interface RunStore {
  /** Creates a run with empty turn, event, and steering collections. */
  createRun(run: RunRecord): Promise<void>;
  /** Returns the run or `undefined` when it does not exist. */
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** Returns the latest nonterminal run for a thread. */
  findActiveRun(threadRef: string): Promise<RunRecord | undefined>;
  /** Applies one legal state transition. */
  updateRunState(runId: string, state: RunState): Promise<void>;
  /** Atomically applies a legal state transition, event, usage, and error. */
  transitionRun(input: RunTransitionInput): Promise<void>;
  /** Lists committed turns in ascending index order. */
  listTurns(runId: string): Promise<TurnRecord[]>;
  /** Atomically commits the next turn with its events, state, and elicitation. */
  commitTurn(input: CommitTurnInput): Promise<CommitTurnResult>;
  /** Adds resumed tool results and clears the pending call from a paused turn. */
  completePendingTurn(
    runId: string,
    turnIndex: number,
    toolResults: TranscriptMessage[],
  ): Promise<void>;
  /** Appends one event with the next dense sequence number for its run. */
  appendEvent(runId: string, event: RunEventData): Promise<RunEvent>;
  /** Lists event envelopes in ascending sequence order. */
  listEvents(runId: string): Promise<RunEvent[]>;
  /** Returns a cursor immediately after the run's last event. */
  eventCursor(runId: string): Promise<number>;
  /** Removes events appended after the cursor, preserving events through that boundary. */
  discardEventsAfter(runId: string, cursor: number): Promise<void>;
  /** Queues input once by id for the identified active run's next turn boundary. */
  enqueueSteering(runId: string, input: QueuedInput): Promise<void>;
  /** Removes and returns steering queued for one run. */
  drainSteering(runId: string): Promise<QueuedInput[]>;
  /** Reports whether one run has queued steering. */
  hasSteering(runId: string): Promise<boolean>;
  /** Queues input for a thread after its active run would otherwise end. */
  enqueueFollowUp(threadRef: string, input: QueuedInput): Promise<void>;
  /** Removes and returns follow-ups queued for one thread. */
  drainFollowUps(threadRef: string): Promise<QueuedInput[]>;
  /**
   * Atomically claims an intent identifier; only one concurrent caller
   * receives `recorded`. The claim keeps `meta` so a later call reusing the
   * id can be checked against what the id was claimed for.
   */
  recordIntent(intentId: string, meta?: IntentClaimMeta): Promise<RecordIntentResult>;
  /**
   * Records the first stop fact for a run without replacing it. The run's
   * state is rechecked atomically with the record: a run that already reached
   * a terminal state reports `run-not-active` and gains no stop fact.
   */
  recordStop(stop: StopRecord): Promise<RecordStopResult>;
  /** Returns the recorded stop fact, if any. */
  getStop(runId: string): Promise<StopRecord | undefined>;
  /** Returns an elicitation and its resolution, if present. */
  getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined>;
  /** Atomically records the first resolution and its event. */
  resolveElicitation(
    elicitationId: string,
    resolution: ElicitationResolution,
  ): Promise<ResolveElicitationResult>;
  /** Atomically resolves an expired elicitation and marks its parked run stale. */
  expireElicitation(
    elicitationId: string,
    by: PrincipalRef,
    at: string,
  ): Promise<ResolveElicitationResult>;
}
