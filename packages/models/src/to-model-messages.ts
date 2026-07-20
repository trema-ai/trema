import type { TranscriptMessage } from "@trema/harness";
import type { ModelMessage } from "ai";

import type { SdkProviderOptions } from "./sdk-operations.js";

type UserParts = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>;
type AssistantParts = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;

function providerOptions(value: unknown): SdkProviderOptions | undefined {
  return value === undefined ? undefined : (value as SdkProviderOptions);
}

function textFromBlocks(message: TranscriptMessage): string {
  return message.blocks
    .filter((block): block is Extract<(typeof message.blocks)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
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
      const blockOptions = providerOptions(message.blocks.find((block) => block.providerMeta !== undefined)?.providerMeta);
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "text", value: textFromBlocks(message) },
          ...(blockOptions ? { providerOptions: blockOptions } : {}),
        }],
        ...(messageOptions ? { providerOptions: messageOptions } : {}),
      };
    }),
  ];
}
