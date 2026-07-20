import type { ModelRef, StopReason, ToolCall, ToolDef, TranscriptMessage, Usage } from "../core/index.js";
import type { RunEventData } from "../events/index.js";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface TurnRequest {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  thinking?: ThinkingLevel;
  budget?: { maxOutputTokens?: number };
  abort: AbortSignal;
}

export interface TurnResult {
  message: TranscriptMessage;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  error?: {
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
}

export interface TurnStream extends AsyncIterable<RunEventData> {
  result: Promise<TurnResult>;
}

export interface CompleteRequest {
  model: ModelRef;
  instructions: string;
  messages: TranscriptMessage[];
  budget?: { maxOutputTokens?: number };
  abort: AbortSignal;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
}

export interface ModelPort {
  streamTurn(request: TurnRequest): TurnStream;
  complete(request: CompleteRequest): Promise<CompleteResult>;
}
