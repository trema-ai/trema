/**
 * Why a model turn ended.
 * `stop` means the model completed without requesting a tool.
 * `toolUse` means the model requested one or more tools.
 * `length` means the provider reached its output limit.
 * `error` means the model request failed.
 * `aborted` means cancellation interrupted the request.
 * `paused` means a blocking elicitation ended execution.
 */
export type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted" | "paused";

/** Token counts and cost reported for one turn or aggregated across a run. */
export interface Usage {
  /** Input token count. */
  inputTokens: number;
  /** Generated token count. */
  outputTokens: number;
  /** Total token count reported by the provider. */
  totalTokens: number;
  /** Input tokens read from a provider cache. */
  cacheReadTokens: number;
  /** Input tokens written to a provider cache. */
  cacheWriteTokens: number;
  /** Reported cost in United States dollars. */
  costUsd: number;
}

/** Model identifier with an optional endpoint selector. */
export interface ModelRef {
  id: string;
  provider?: string;
}

/** Functional category shown for a tool call. */
export type ToolKind = "read" | "edit" | "search" | "execute" | "fetch" | "connector" | "other";

/** Model-facing definition and execution policy for a tool. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: unknown;
  kind: ToolKind;
  /** Runs the whole containing batch sequentially when set to `sequential`; all other batches run in parallel. */
  execution?: "parallel" | "sequential";
}

/** A model-requested tool invocation. */
export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
  /** Opaque provider echo data only. */
  providerMeta?: unknown;
}
