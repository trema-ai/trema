export type TranscriptRole = "user" | "assistant" | "toolResult";

interface TranscriptBlockBase {
  providerMeta?: unknown;
}

export interface TextBlock extends TranscriptBlockBase {
  type: "text";
  text: string;
}

export interface ThinkingBlock extends TranscriptBlockBase {
  type: "thinking";
  text: string;
}

export interface ToolCallBlock extends TranscriptBlockBase {
  type: "toolCall";
  callId: string;
  name: string;
  input: unknown;
}

export interface ImageBlock extends TranscriptBlockBase {
  type: "image";
  data: string;
  mediaType: string;
}

export type TranscriptBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

export interface TranscriptMessage {
  role: TranscriptRole;
  blocks: TranscriptBlock[];
  toolCallId?: string;
  providerMeta?: unknown;
}
