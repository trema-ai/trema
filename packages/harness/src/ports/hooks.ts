import type { ModelRef, ToolCall, ToolDef, TranscriptMessage } from "../core/index.js";
import type { RunEventData } from "../events/index.js";
import type { TurnResult } from "./model-port.js";
import type { ToolExecutionResult } from "./tool-executor.js";

export interface PrepareTurnInput {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  turn: number;
}

export interface PrepareTurnResult {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  events?: RunEventData[];
}

export type PrepareTurnHook = (input: PrepareTurnInput) => Promise<PrepareTurnResult> | PrepareTurnResult;

export interface BeforeToolCallInput {
  call: ToolCall;
  definition: ToolDef;
}

export type BeforeToolCallResult =
  | { action: "execute"; call?: ToolCall }
  | { action: "block"; summary: string }
  | { action: "elicit"; event: Extract<RunEventData, { type: "elicitation" }> };

export type BeforeToolCallHook = (
  input: BeforeToolCallInput,
) => Promise<BeforeToolCallResult> | BeforeToolCallResult;

export interface AfterToolCallInput {
  call: ToolCall;
  definition: ToolDef;
  result: ToolExecutionResult;
}

export type AfterToolCallHook = (
  input: AfterToolCallInput,
) => Promise<ToolExecutionResult> | ToolExecutionResult;

export interface ShouldStopInput {
  turn: number;
  result: TurnResult;
  messages: TranscriptMessage[];
}

export type ShouldStopHook = (input: ShouldStopInput) => Promise<boolean> | boolean;

export interface TurnCommittedInput {
  turn: number;
  result: TurnResult;
  toolResults: TranscriptMessage[];
}

export type OnTurnCommittedHook = (input: TurnCommittedInput) => Promise<void> | void;

export interface HarnessHooks {
  prepareTurn?: PrepareTurnHook;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  shouldStop?: ShouldStopHook;
  onTurnCommitted?: OnTurnCommittedHook;
}
