export type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted" | "paused";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface ModelRef {
  id: string;
  provider?: string;
}

export type ToolKind = "read" | "edit" | "search" | "execute" | "fetch" | "connector" | "other";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: unknown;
  kind: ToolKind;
  execution?: "parallel" | "sequential";
}

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
  providerMeta?: unknown;
}
