import type { TranscriptMessage } from "@trema/harness";
import type { ModelMessage } from "ai";

import type { SdkProviderOptions } from "./sdk-operations.js";

type UserParts = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>;
type AssistantParts = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
type ToolParts = Extract<ModelMessage, { role: "tool" }>["content"];
type ToolResultOutput = Extract<ToolParts[number], { type: "tool-result" }>["output"];

function providerOptions(value: unknown): SdkProviderOptions | undefined {
  return value === undefined ? undefined : (value as SdkProviderOptions);
}

function textFromBlocks(message: TranscriptMessage): string {
  let text = "";
  for (const block of message.blocks) {
    if (block.type === "text") text += block.text;
    else if (block.type !== "image") throw new Error(`Invalid ${block.type} block in toolResult message`);
  }
  return text;
}

function toolResultOutput(message: TranscriptMessage): ToolResultOutput {
  const text = textFromBlocks(message);
  if (message.status === "error") return { type: "error-text", value: text };
  if (message.status === "denied") {
    return text.length === 0
      ? { type: "execution-denied" }
      : { type: "execution-denied", reason: text };
  }
  if (message.blocks.some((block) => block.type === "image")) {
    return {
      type: "content",
      value: message.blocks.map((block) => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "image") {
          return {
            type: "file",
            data: { type: "data", data: block.data },
            mediaType: block.mediaType,
          };
        }
        throw new Error(`Invalid ${block.type} block in toolResult message`);
      }),
    };
  }
  return { type: "text", value: text };
}

export function toModelMessages(
  instructions: string,
  messages: readonly TranscriptMessage[],
): ModelMessage[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "toolCall") toolNames.set(block.callId, block.name);
    }
  }

  return [
    { role: "system", content: instructions },
    ...messages.map((message): ModelMessage => {
      const messageOptions = providerOptions(message.providerMeta);
      if (message.role === "user") {
        const content: UserParts = [];
        for (const block of message.blocks) {
          const options = providerOptions(block.providerMeta);
          if (block.type === "text") {
            content.push({ type: "text", text: block.text, ...(options ? { providerOptions: options } : {}) });
          } else if (block.type === "image") {
            content.push({
              type: "image",
              image: block.data,
              mediaType: block.mediaType,
              ...(options ? { providerOptions: options } : {}),
            });
          } else {
            throw new Error(`Invalid ${block.type} block in user message`);
          }
        }
        return {
          role: "user",
          content,
          ...(messageOptions ? { providerOptions: messageOptions } : {}),
        };
      }

      if (message.role === "assistant") {
        const content: AssistantParts = [];
        for (const block of message.blocks) {
          const options = providerOptions(block.providerMeta);
          switch (block.type) {
            case "text":
              content.push({ type: "text", text: block.text, ...(options ? { providerOptions: options } : {}) });
              break;
            case "thinking":
              content.push({ type: "reasoning", text: block.text, ...(options ? { providerOptions: options } : {}) });
              break;
            case "toolCall":
              content.push({
                type: "tool-call",
                toolCallId: block.callId,
                toolName: block.name,
                input: block.input,
                ...(options ? { providerOptions: options } : {}),
              });
              break;
            case "image":
              content.push({
                type: "file",
                data: block.data,
                mediaType: block.mediaType,
                ...(options ? { providerOptions: options } : {}),
              });
              break;
          }
        }
        return {
          role: "assistant",
          content,
          ...(messageOptions ? { providerOptions: messageOptions } : {}),
        };
      }

      const toolCallId = message.toolCallId;
      if (toolCallId === undefined) throw new Error("Tool result message is missing toolCallId");
      const toolName = toolNames.get(toolCallId);
      if (toolName === undefined) throw new Error(`Tool result references unknown call: ${toolCallId}`);
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName,
          output: toolResultOutput(message),
        }],
        ...(messageOptions ? { providerOptions: messageOptions } : {}),
      };
    }),
  ];
}
