import type { ToolExecutionResult, ToolExecutor, TranscriptMessage } from "@trema/harness";

/** The most bytes of one text block the output read returns before cutting. */
export const TOOL_OUTPUT_TEXT_BYTE_CAP = 256 * 1024;

/** The largest base64 image payload the output read returns inline. */
export const TOOL_OUTPUT_IMAGE_BYTE_CAP = 2 * 1024 * 1024;

/**
 * One rendered block of a resolved tool output. Text is cut at the byte cap
 * with the cut declared; an image over its cap keeps its media type but ships
 * no data — omission is a stated fact, never a silent one.
 */
export type RenderedOutputBlock =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; mediaType: string; data: string | null; omitted: boolean };

/** Whether the result carries a body at all: any non-empty text, or any image. */
function hasFullOutput(result: ToolExecutionResult): boolean {
  if (typeof result.output === "string") return result.output.length > 0;
  return result.output.some((block) => block.type !== "text" || block.text.length > 0);
}

/**
 * Wraps an executor so every result carrying a full output gets an
 * `outputRef`. The ref is the call id: unique within the run, and exactly the
 * key `Turn.toolResults` stores the full message under — resolution is a
 * lookup against the transcript, not a blob store. A result with no body (an
 * empty output, a bare refusal) stays unaddressed: there is nothing to expand.
 */
export function withToolOutputRefs(executor: ToolExecutor): ToolExecutor {
  return {
    async execute(call, definition, options) {
      const result = await executor.execute(call, definition, options);
      if (result.outputRef !== undefined || !hasFullOutput(result)) return result;
      return { ...result, outputRef: result.callId };
    },
  };
}

/**
 * Cuts UTF-8 text at a byte budget without splitting a character: the cut
 * backs off any continuation bytes (0b10xxxxxx) to the previous boundary.
 */
function truncateUtf8(text: string, capBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= capBytes) return { text, truncated: false };
  let end = capBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Renders a stored tool-result message by content type, under the caps. A
 * toolResult message only ever stores text and image blocks
 * (`toToolResultMessage` in the harness); any other block type is skipped
 * rather than guessed at.
 */
export function renderToolOutputBlocks(message: TranscriptMessage): RenderedOutputBlock[] {
  return message.blocks.flatMap((block): RenderedOutputBlock[] => {
    if (block.type === "text") {
      return [{ kind: "text", ...truncateUtf8(block.text, TOOL_OUTPUT_TEXT_BYTE_CAP) }];
    }
    if (block.type === "image") {
      return Buffer.byteLength(block.data, "utf8") <= TOOL_OUTPUT_IMAGE_BYTE_CAP
        ? [{ kind: "image", mediaType: block.mediaType, data: block.data, omitted: false }]
        : [{ kind: "image", mediaType: block.mediaType, data: null, omitted: true }];
    }
    return [];
  });
}
