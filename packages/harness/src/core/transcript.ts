/** Author category for a transcript message. */
export type TranscriptRole = "user" | "assistant" | "toolResult";

interface TranscriptBlockBase {
  /** Opaque provider echo data only. */
  providerMeta?: unknown;
}

/** Plain text in a transcript message. */
export interface TextBlock extends TranscriptBlockBase {
  type: "text";
  text: string;
}

/** Provider reasoning retained for later model turns. */
export interface ThinkingBlock extends TranscriptBlockBase {
  type: "thinking";
  text: string;
}

/** Tool invocation retained in an assistant message. */
export interface ToolCallBlock extends TranscriptBlockBase {
  type: "toolCall";
  callId: string;
  name: string;
  input: unknown;
}

/** Base64-encoded image content with its media type. */
export interface ImageBlock extends TranscriptBlockBase {
  type: "image";
  data: string;
  mediaType: string;
}

/** Content block supported by the durable transcript. */
export type TranscriptBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

/** Ordered transcript content for one role. */
export interface TranscriptMessage {
  role: TranscriptRole;
  blocks: TranscriptBlock[];
  /** Associates a tool result with its assistant tool call. */
  toolCallId?: string;
  /** Outcome of a tool result message. */
  status?: "ok" | "error" | "denied";
  /**
   * Stable definitions made available by this tool result.
   *
   * This is harness metadata, not model content. Persisting it with the result
   * lets a retried or resumed loop reconstruct the same active key order.
   */
  activatedToolKeys?: string[];
  /** Opaque provider echo data only. */
  providerMeta?: unknown;
}
