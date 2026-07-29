import type { ImageBlock, TextBlock, ToolCall, ToolDef } from "#harness/core/index.js";
import type { RunEventData } from "#harness/events/index.js";

/** Durable result of one tool call. */
export interface ToolExecutionResult {
  callId: string;
  status: "ok" | "error" | "denied";
  summary: string;
  /** Full transcript output, which can exceed the event summary. */
  output: string | Array<TextBlock | ImageBlock>;
  /** Optional reference to externally stored full output. */
  outputRef?: string;
  /** Stable live definitions to expose on the next model turn. */
  activatedToolKeys?: string[];
}

/** Additional authority supplied when executing a tool call. */
export interface ToolExecutionOptions {
  approvalId?: string;
}

/** A server-side gate's decision before a tool can execute. */
export type ToolPreparationResult =
  | { action: "execute"; call?: ToolCall }
  | { action: "block"; summary: string; output?: unknown }
  | { action: "elicit"; event: Extract<RunEventData, { type: "elicitation" }> };

/** Executes tool calls after harness policy hooks allow them. */
export interface ToolExecutor {
  /**
   * Resolves stable tool keys against the executor's current authority.
   *
   * The loop calls this before each model turn, so removed or changed tools
   * take effect without reopening a run.
   */
  resolveTools?(keys: readonly string[]): Promise<ToolDef[]> | ToolDef[];
  /**
   * Applies execution-side policy before any call in the batch runs.
   *
   * Returning an elicitation parks the exact call. On resume the harness passes
   * the resolved approval through `options`, without involving the model.
   */
  prepare?(
    call: ToolCall,
    definition: ToolDef,
    options?: ToolExecutionOptions,
  ): Promise<ToolPreparationResult> | ToolPreparationResult;
  /** Returns failures as results; thrown errors become error results in the run loop. */
  execute(
    call: ToolCall,
    definition: ToolDef,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionResult>;
}
