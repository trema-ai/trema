import type { ImageBlock, TextBlock, ToolCall, ToolDef } from "../core/index.js";

export interface ToolExecutionResult {
  callId: string;
  status: "ok" | "error" | "denied";
  summary: string;
  output: string | Array<TextBlock | ImageBlock>;
  outputRef?: string;
}

export interface ToolExecutionOptions {
  approvalId?: string;
}

export interface ToolExecutor {
  execute(
    call: ToolCall,
    definition: ToolDef,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionResult>;
}
