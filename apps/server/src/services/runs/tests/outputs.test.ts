import type { ToolCall, ToolDef, ToolExecutionResult, ToolExecutor } from "@trema/harness";
import { describe, expect, it } from "vitest";

import {
  renderToolOutputBlocks,
  TOOL_OUTPUT_IMAGE_BYTE_CAP,
  TOOL_OUTPUT_TEXT_BYTE_CAP,
  withToolOutputRefs,
} from "#server/services/runs/outputs.js";

const call: ToolCall = { callId: "call-1", name: "lookup", input: { q: "deploy" } };

const definition: ToolDef = {
  name: "lookup",
  title: "Lookup",
  description: "Look it up",
  schema: {},
  kind: "search",
};

function executorReturning(result: Omit<ToolExecutionResult, "callId">): ToolExecutor {
  return { execute: async ({ callId }) => ({ callId, ...result }) };
}

describe("withToolOutputRefs", () => {
  it("mints the call id as the ref for a result with a body", async () => {
    const executor = withToolOutputRefs(
      executorReturning({ status: "ok", summary: "lookup completed", output: '{"rows": 3}' }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBe("call-1");
  });

  it("mints for an error whose message body is the output", async () => {
    const executor = withToolOutputRefs(
      executorReturning({ status: "error", summary: "lookup failed", output: "stack trace here" }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBe("call-1");
  });

  it("mints for block output carrying an image", async () => {
    const executor = withToolOutputRefs(
      executorReturning({
        status: "ok",
        summary: "rendered",
        output: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
      }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBe("call-1");
  });

  it("mints nothing for an empty string output", async () => {
    const executor = withToolOutputRefs(
      executorReturning({ status: "ok", summary: "done", output: "" }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBeUndefined();
  });

  it("mints nothing for a denial with no body", async () => {
    const executor = withToolOutputRefs(
      executorReturning({ status: "denied", summary: "denied by Alice", output: "" }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBeUndefined();
  });

  it("mints nothing for blocks with no content", async () => {
    const executor = withToolOutputRefs(
      executorReturning({ status: "ok", summary: "done", output: [{ type: "text", text: "" }] }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBeUndefined();
  });

  it("keeps a ref the wrapped executor already set", async () => {
    const executor = withToolOutputRefs(
      executorReturning({ status: "ok", summary: "done", output: "body", outputRef: "custom-ref" }),
    );
    const result = await executor.execute(call, definition);
    expect(result.outputRef).toBe("custom-ref");
  });
});

describe("renderToolOutputBlocks", () => {
  it("returns text under the cap unmarked", () => {
    const blocks = renderToolOutputBlocks({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [{ type: "text", text: "small output" }],
      status: "ok",
    });
    expect(blocks).toEqual([{ kind: "text", text: "small output", truncated: false }]);
  });

  it("cuts oversized text at the byte cap and says so", () => {
    const blocks = renderToolOutputBlocks({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [{ type: "text", text: "x".repeat(TOOL_OUTPUT_TEXT_BYTE_CAP + 10) }],
      status: "ok",
    });
    expect(blocks).toEqual([
      { kind: "text", text: "x".repeat(TOOL_OUTPUT_TEXT_BYTE_CAP), truncated: true },
    ]);
  });

  it("never splits a multi-byte character at the cap", () => {
    // Each snowman is 3 bytes; the cap lands mid-character, and the cut backs
    // off to the previous boundary rather than emitting a broken sequence.
    const text = "☃".repeat(Math.ceil(TOOL_OUTPUT_TEXT_BYTE_CAP / 3) + 5);
    const [block] = renderToolOutputBlocks({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [{ type: "text", text }],
      status: "ok",
    });
    if (block?.kind !== "text") throw new Error("expected a text block");
    expect(block.truncated).toBe(true);
    expect(Buffer.byteLength(block.text, "utf8")).toBeLessThanOrEqual(TOOL_OUTPUT_TEXT_BYTE_CAP);
    expect(block.text).not.toContain("�");
    expect([...block.text].every((char) => char === "☃")).toBe(true);
  });

  it("returns an image under the cap with its data", () => {
    const blocks = renderToolOutputBlocks({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
      status: "ok",
    });
    expect(blocks).toEqual([
      { kind: "image", mediaType: "image/png", data: "aGk=", omitted: false },
    ]);
  });

  it("omits an oversized image honestly, keeping its media type", () => {
    const blocks = renderToolOutputBlocks({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [
        { type: "image", mediaType: "image/png", data: "A".repeat(TOOL_OUTPUT_IMAGE_BYTE_CAP + 1) },
      ],
      status: "ok",
    });
    expect(blocks).toEqual([{ kind: "image", mediaType: "image/png", data: null, omitted: true }]);
  });

  it("keeps mixed content in transcript order and skips foreign block types", () => {
    const blocks = renderToolOutputBlocks({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [
        { type: "text", text: "before" },
        { type: "thinking", text: "never stored on tool results" },
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "text", text: "after" },
      ],
      status: "ok",
    });
    expect(blocks).toEqual([
      { kind: "text", text: "before", truncated: false },
      { kind: "image", mediaType: "image/png", data: "aGk=", omitted: false },
      { kind: "text", text: "after", truncated: false },
    ]);
  });
});
