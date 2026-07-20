import type {
  ModelRef,
  RunState,
  StopReason,
  TranscriptMessage,
  Trigger,
  Usage,
} from "../core/index.js";
import type { PrincipalRef, RunEvent, RunEventData } from "../events/index.js";

export interface RunRecord {
  id: string;
  threadRef: string;
  state: RunState;
  trigger: Trigger;
  turnCount: number;
  sessionId?: string;
  retryOfRunId?: string;
  retryAttempt?: number;
  usage?: Usage;
  error?: string;
  runGrants?: string[];
}

export interface TurnRecord {
  runId: string;
  index: number;
  model: ModelRef;
  message: TranscriptMessage;
  toolResults: TranscriptMessage[];
  pendingToolCall?: { callId: string; elicitationId: string };
  stopReason: StopReason;
  usage: Usage;
}

export interface CommitTurnInput {
  turn: TurnRecord;
  events?: RunEventData[];
  state?: RunState;
  elicitation?: ElicitationRecord;
}

export interface CommitTurnResult {
  turn: TurnRecord;
}

export interface QueuedInput {
  id: string;
  message: TranscriptMessage;
  author: PrincipalRef;
}

export interface StopRecord {
  intentId: string;
  runId: string;
  by: PrincipalRef;
  at: string;
}

export type ResolutionScope = "once" | "run" | "always";

export interface ElicitationResolution {
  optionId: string;
  decision: "approved" | "denied" | "answered" | "expired";
  scope: ResolutionScope;
  by: PrincipalRef;
  at: string;
  reason?: string;
}

export interface ElicitationRecord {
  runId: string;
  event: Extract<RunEventData, { type: "elicitation" }>;
  expiresAt?: string;
  resolution?: ElicitationResolution;
}

export interface RunTransitionInput {
  runId: string;
  state: RunState;
  event?: RunEventData;
  usage?: Usage;
  error?: string;
}

export type RecordIntentResult = "recorded" | "duplicate";
export type ResolveElicitationResult = "resolved" | "already-resolved";

export interface RunStore {
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  findActiveRun(threadRef: string): Promise<RunRecord | undefined>;
  updateRunState(runId: string, state: RunState): Promise<void>;
  transitionRun(input: RunTransitionInput): Promise<void>;
  listTurns(runId: string): Promise<TurnRecord[]>;
  commitTurn(input: CommitTurnInput): Promise<CommitTurnResult>;
  completePendingTurn(runId: string, turnIndex: number, toolResults: TranscriptMessage[]): Promise<void>;
  appendEvent(runId: string, event: RunEventData): Promise<RunEvent>;
  listEvents(runId: string): Promise<RunEvent[]>;
  eventCursor(runId: string): Promise<number>;
  discardEventsAfter(runId: string, cursor: number): Promise<void>;
  enqueueSteering(runId: string, input: QueuedInput): Promise<void>;
  drainSteering(runId: string): Promise<QueuedInput[]>;
  hasSteering(runId: string): Promise<boolean>;
  enqueueFollowUp(threadRef: string, input: QueuedInput): Promise<void>;
  drainFollowUps(threadRef: string): Promise<QueuedInput[]>;
  recordIntent(intentId: string): Promise<RecordIntentResult>;
  recordStop(stop: StopRecord): Promise<void>;
  getStop(runId: string): Promise<StopRecord | undefined>;
  getElicitation(elicitationId: string): Promise<ElicitationRecord | undefined>;
  resolveElicitation(
    elicitationId: string,
    resolution: ElicitationResolution,
  ): Promise<ResolveElicitationResult>;
  expireElicitation(elicitationId: string, by: PrincipalRef, at: string): Promise<ResolveElicitationResult>;
}
