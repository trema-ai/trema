import type { ModelRef, StopReason, ToolCall, ToolDef, TranscriptMessage, Usage } from "../core/index.js";
import type { RunEventData } from "../events/index.js";

/** Requested provider reasoning level. */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** Inputs for one streaming model turn. */
export interface TurnRequest {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  thinking?: ThinkingLevel;
  /** Maximum generated tokens for this turn. */
  budget?: { maxOutputTokens?: number };
  /** Cancels the active provider request. */
  abort: AbortSignal;
}

/** Final durable output from one streaming model turn. */
export interface TurnResult {
  message: TranscriptMessage;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  /** Failure details when the stop reason is `error`. */
  error?: {
    message: string;
    retryable: boolean;
    /** Provider-requested delay in milliseconds before retrying. */
    retryAfterMs?: number;
  };
}

/** Event stream with one promise for its final turn result. */
export interface TurnStream extends AsyncIterable<RunEventData> {
  result: Promise<TurnResult>;
}

/** Inputs for a tool-free model completion. */
export interface CompleteRequest {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  /** Maximum generated tokens for this completion. */
  budget?: { maxOutputTokens?: number };
  /** Cancels the active provider request. */
  abort: AbortSignal;
}

/** Text and usage from a tool-free model completion. */
export interface CompleteResult {
  text: string;
  usage: Usage;
}

/** Adapts model providers to harness turn and completion requests. */
export interface ModelPort {
  /** Starts a turn whose events and final result describe the same provider request. */
  streamTurn(request: TurnRequest): TurnStream;
  /** Generates text without exposing tools or streaming events. */
  complete(request: CompleteRequest): Promise<CompleteResult>;
}
