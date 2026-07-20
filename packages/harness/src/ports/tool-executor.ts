import type { ToolCall, ToolDef } from "../core/index.js";

export interface ToolExecutionResult {
  callId: string;
  status: "ok" | "error" | "denied";
  summary: string;
  output: unknown;
  outputRef?: string;
}

export interface ToolExecutor {
  execute(call: ToolCall, definition: ToolDef): Promise<ToolExecutionResult>;
}
