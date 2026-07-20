import type {
  RunEventData,
  ToolCall,
  ToolDef,
  TranscriptBlock,
  TranscriptMessage,
} from "@trema/harness";
import type { ProviderMetadata, TextStreamPart } from "ai";

import { modelErrorData } from "./errors.js";

type TextBlock = Extract<TranscriptBlock, { type: "text" }>;
type ThinkingBlock = Extract<TranscriptBlock, { type: "thinking" }>;
type ToolCallBlock = Extract<TranscriptBlock, { type: "toolCall" }>;

export interface ChunkState {
  readonly message: TranscriptMessage;
  readonly toolCalls: ToolCall[];
  readonly text: Map<string, TextBlock>;
  readonly reasoning: Map<string, ThinkingBlock>;
  readonly calls: Map<string, ToolCallBlock>;
}

export function createChunkState(): ChunkState {
  return {
    message: { role: "assistant", blocks: [] },
    toolCalls: [],
    text: new Map(),
    reasoning: new Map(),
    calls: new Map(),
  };
}

function setProviderMeta(target: { providerMeta?: unknown }, metadata?: ProviderMetadata): void {
  if (metadata !== undefined) target.providerMeta = metadata;
}

function toolStart(callId: string, name: string, tools: readonly ToolDef[]): RunEventData {
  const definition = tools.find((tool) => tool.name === name);
  return {
    type: "tool-start",
    callId,
    name,
    title: definition?.title ?? name,
    kind: definition?.kind ?? "other",
  };
}

/**
 * Maps AI SDK v7 `streamText().fullStream` parts to run events. The SDK's
 * UI-stream vocabulary names the final-arguments chunk `tool-input-available`;
 * its full-stream counterpart is `tool-call`. `custom` is the full-stream
 * counterpart used for data parts. Step/finish parts are consumed by the port
 * and intentionally emit nothing.
 */
export function chunkToEvents(
  part: TextStreamPart<any>,
  tools: readonly ToolDef[],
  state: ChunkState,
): RunEventData[] {
  switch (part.type) {
    case "text-start": {
      const block: TextBlock = { type: "text", text: "" };
      setProviderMeta(block, part.providerMetadata);
      state.text.set(part.id, block);
      state.message.blocks.push(block);
      return [{ type: "text-start", blockId: part.id }];
    }
    case "text-delta": {
      const block = state.text.get(part.id);
      if (block !== undefined) {
        block.text += part.text;
        setProviderMeta(block, part.providerMetadata);
      }
      return [{ type: "text-delta", blockId: part.id, delta: part.text }];
    }
    case "text-end": {
      const block = state.text.get(part.id);
      if (block !== undefined) setProviderMeta(block, part.providerMetadata);
      return [{ type: "text-end", blockId: part.id }];
    }
    case "reasoning-start": {
      const block: ThinkingBlock = { type: "thinking", text: "" };
      setProviderMeta(block, part.providerMetadata);
      state.reasoning.set(part.id, block);
      state.message.blocks.push(block);
      return [{ type: "reasoning-start", blockId: part.id }];
    }
    case "reasoning-delta": {
      const block = state.reasoning.get(part.id);
      if (block !== undefined) {
        block.text += part.text;
        setProviderMeta(block, part.providerMetadata);
      }
      return [{ type: "reasoning-delta", blockId: part.id, delta: part.text }];
    }
    case "reasoning-end": {
      const block = state.reasoning.get(part.id);
      if (block !== undefined) setProviderMeta(block, part.providerMetadata);
      return [{ type: "reasoning-end", blockId: part.id }];
    }
    case "tool-input-start": {
      const block: ToolCallBlock = {
        type: "toolCall",
        callId: part.id,
        name: part.toolName,
        input: undefined,
      };
      setProviderMeta(block, part.providerMetadata);
      state.calls.set(part.id, block);
      state.message.blocks.push(block);
      state.toolCalls.push({ callId: part.id, name: part.toolName, input: undefined });
      return [toolStart(part.id, part.toolName, tools)];
    }
    case "tool-input-delta":
      return [{ type: "tool-input-delta", callId: part.id, delta: part.delta }];
    case "tool-call": {
      let block = state.calls.get(part.toolCallId);
      const events: RunEventData[] = [];
      if (block === undefined) {
        block = {
          type: "toolCall",
          callId: part.toolCallId,
          name: part.toolName,
          input: part.input,
        };
        state.calls.set(part.toolCallId, block);
        state.message.blocks.push(block);
        state.toolCalls.push({ callId: part.toolCallId, name: part.toolName, input: part.input });
        events.push(toolStart(part.toolCallId, part.toolName, tools));
      }
      block.input = part.input;
      setProviderMeta(block, part.providerMetadata);
      const call = state.toolCalls.find((candidate) => candidate.callId === part.toolCallId);
      if (call !== undefined) {
        call.input = part.input;
        if (part.providerMetadata !== undefined) call.providerMeta = part.providerMetadata;
      }
      events.push({ type: "tool-input", callId: part.toolCallId, input: part.input });
      return events;
    }
    case "custom":
      return [{ type: "data", name: part.kind, data: part.providerMetadata ?? null }];
    case "error": {
      const error = modelErrorData(part.error);
      return [{ type: "error", message: error.message, recoverable: error.retryable }];
    }
    case "abort":
      return [{ type: "error", message: part.reason ?? "Model request aborted", recoverable: false }];
    case "start":
    case "start-step":
    case "finish-step":
    case "finish":
    case "tool-input-end":
    case "source":
    case "file":
    case "reasoning-file":
    case "tool-result":
    case "tool-error":
    case "tool-output-denied":
    case "tool-approval-request":
    case "tool-approval-response":
    case "raw":
      return [];
  }
}
