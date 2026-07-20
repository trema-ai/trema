import type { ImageBlock, TextBlock, ToolCall, ToolDef } from "../core/index.js";

/** Durable result of one tool call. */
export interface ToolExecutionResult {
  callId: string;
  status: "ok" | "error" | "denied";
  summary: string;
  /** Full transcript output, which can exceed the event summary. */
  output: string | Array<TextBlock | ImageBlock>;
  /** Optional reference to externally stored full output. */
  outputRef?: string;
}

/** Additional authority supplied when executing a tool call. */
export interface ToolExecutionOptions {
  approvalId?: string;
}

/** Executes tool calls after harness policy hooks allow them. */
export interface ToolExecutor {
  /** Returns failures as results; thrown errors become error results in the run loop. */
  execute(
    call: ToolCall,
    definition: ToolDef,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionResult>;
}
