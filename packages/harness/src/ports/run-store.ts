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
}

export interface CommitTurnResult {
  turn: TurnRecord;
}

export interface QueuedInput {
  id: string;
  message: TranscriptMessage;
  author: PrincipalRef;
}

export interface RunStore {
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  updateRunState(runId: string, state: RunState): Promise<void>;
  listTurns(runId: string): Promise<TurnRecord[]>;
  commitTurn(input: CommitTurnInput): Promise<CommitTurnResult>;
  appendEvent(runId: string, event: RunEventData): Promise<RunEvent>;
  listEvents(runId: string): Promise<RunEvent[]>;
  enqueueSteering(runId: string, input: QueuedInput): Promise<void>;
  drainSteering(runId: string): Promise<QueuedInput[]>;
  hasSteering(runId: string): Promise<boolean>;
  enqueueFollowUp(threadRef: string, input: QueuedInput): Promise<void>;
  drainFollowUps(threadRef: string): Promise<QueuedInput[]>;
}
