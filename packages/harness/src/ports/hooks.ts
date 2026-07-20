import type { ModelRef, ToolCall, ToolDef, TranscriptMessage } from "../core/index.js";
import type { RunEventData } from "../events/index.js";
import type { TurnResult } from "./model-port.js";
import type { ToolExecutionResult } from "./tool-executor.js";

/** Baseline model request passed to `prepareTurn`. */
export interface PrepareTurnInput {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  turn: number;
}

/** Replacement model request and optional events from `prepareTurn`. */
export interface PrepareTurnResult {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  events?: RunEventData[];
}

/**
 * Runs immediately before each model request and can replace its inputs.
 * Returned events are recorded before streaming starts.
 * Errors become recoverable run events, and the baseline request continues.
 */
export type PrepareTurnHook = (input: PrepareTurnInput) => Promise<PrepareTurnResult> | PrepareTurnResult;

/** Tool call and matched definition passed to `beforeToolCall`. */
export interface BeforeToolCallInput {
  call: ToolCall;
  definition: ToolDef;
}

/**
 * `execute` allows or replaces the call, `block` creates an error result, and `elicit` pauses the run.
 */
export type BeforeToolCallResult =
  | { action: "execute"; call?: ToolCall }
  | { action: "block"; summary: string }
  | { action: "elicit"; event: Extract<RunEventData, { type: "elicitation" }> };

/**
 * Runs in assistant order before each tool call.
 * An elicitation commits the completed prefix and leaves this call pending.
 * Errors become recoverable run events and error tool results.
 */
export type BeforeToolCallHook = (
  input: BeforeToolCallInput,
) => Promise<BeforeToolCallResult> | BeforeToolCallResult;

/** Tool execution result passed to `afterToolCall`. */
export interface AfterToolCallInput {
  call: ToolCall;
  definition: ToolDef;
  result: ToolExecutionResult;
}

/**
 * Runs after a tool executor returns or fails and can replace its result.
 * Errors become recoverable run events, and the original result remains.
 */
export type AfterToolCallHook = (
  input: AfterToolCallInput,
) => Promise<ToolExecutionResult> | ToolExecutionResult;

/** Completed turn context passed to `shouldStop`. */
export interface ShouldStopInput {
  turn: number;
  result: TurnResult;
  messages: TranscriptMessage[];
}

/**
 * Runs after tool execution and before the turn commits.
 * Returning `true` ends the loop after that commit.
 * Errors become recoverable run events, and execution continues.
 */
export type ShouldStopHook = (input: ShouldStopInput) => Promise<boolean> | boolean;

/** Committed turn data passed to `onTurnCommitted`. */
export interface TurnCommittedInput {
  turn: number;
  result: TurnResult;
  toolResults: TranscriptMessage[];
}

/**
 * Runs without blocking execution after a turn commits.
 * Errors become recoverable run events when event storage remains available.
 */
export type OnTurnCommittedHook = (input: TurnCommittedInput) => Promise<void> | void;

/** Optional policy and observation hooks for the run loop. Hook errors never escape the loop. */
export interface HarnessHooks {
  prepareTurn?: PrepareTurnHook;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  shouldStop?: ShouldStopHook;
  onTurnCommitted?: OnTurnCommittedHook;
}
