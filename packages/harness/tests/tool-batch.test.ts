import { describe, expect, it } from "vitest";

import type { ImageBlock, TextBlock, ToolCall, ToolDef } from "#/core/index.js";
import { executeToolBatch } from "#/loop/tool-batch.js";
import type { ToolExecutionResult, ToolExecutor } from "#/ports/index.js";

const calls: ToolCall[] = [
  { callId: "call-1", name: "first", input: { value: 1 } },
  { callId: "call-2", name: "second", input: { value: 2 } },
];

const tools: ToolDef[] = calls.map(({ name }) => ({
  name,
  title: name,
  description: `${name} tool`,
  schema: {},
  kind: "execute",
}));

function ok(callId: string, summary = callId): ToolExecutionResult {
  return { callId, status: "ok", summary, output: `full output for ${callId}` };
}

describe("executeToolBatch", () => {
  it("runs in parallel but returns results in assistant order", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const completionOrder: string[] = [];
    const executor: ToolExecutor = {
      execute: async (call) => {
        if (call.callId === "call-1") await firstCanFinish;
        completionOrder.push(call.callId);
        if (call.callId === "call-2") releaseFirst?.();
        return ok(call.callId);
      },
    };

    const batch = await executeToolBatch({ calls, tools, executor });

    expect(completionOrder).toEqual(["call-2", "call-1"]);
    expect(batch.results.map(({ callId }) => callId)).toEqual(["call-1", "call-2"]);
    expect(batch.messages.map(({ toolCallId }) => toolCallId)).toEqual(["call-1", "call-2"]);
    expect(batch.messages[0]).toEqual({
      role: "toolResult",
      toolCallId: "call-1",
      status: "ok",
      blocks: [{ type: "text", text: "full output for call-1" }],
    });
    expect(
      batch.events.flatMap((event) => (event.type === "tool-result" ? [event.callId] : [])),
    ).toEqual(["call-1", "call-2"]);
  });

  it("runs the whole batch sequentially when any definition demands it", async () => {
    const order: string[] = [];
    const executor: ToolExecutor = {
      execute: async (call) => {
        order.push(`${call.callId}:start`);
        await Promise.resolve();
        order.push(`${call.callId}:end`);
        return ok(call.callId);
      },
    };
    const sequentialTools: ToolDef[] = [tools[0]!, { ...tools[1]!, execution: "sequential" }];

    await executeToolBatch({ calls, tools: sequentialTools, executor });
    expect(order).toEqual(["call-1:start", "call-1:end", "call-2:start", "call-2:end"]);
  });

  it("keeps block output in the transcript but out of the run event", async () => {
    const output: Array<TextBlock | ImageBlock> = [
      { type: "text", text: "full text" },
      { type: "image", data: "base64-data", mediaType: "image/png" },
    ];
    const batch = await executeToolBatch({
      calls: [calls[0]!],
      tools,
      executor: {
        execute: async (call) => ({
          callId: call.callId,
          status: "ok",
          summary: "short summary",
          output,
          outputRef: "output-1",
        }),
      },
    });

    expect(batch.messages[0]?.blocks).toBe(output);
    expect(batch.events).toContainEqual({
      type: "tool-result",
      callId: "call-1",
      status: "ok",
      summary: "short summary",
      outputRef: "output-1",
    });
  });

  it("turns blocks into error results and executes rewritten calls", async () => {
    const executed: ToolCall[] = [];
    const executor: ToolExecutor = {
      execute: async (call) => {
        executed.push(call);
        return ok(call.callId, JSON.stringify(call.input));
      },
    };
    const batch = await executeToolBatch({
      calls,
      tools,
      executor,
      beforeToolCall: ({ call }) =>
        call.callId === "call-1"
          ? { action: "block", summary: "blocked by policy" }
          : { action: "execute", call: { ...call, input: { value: 42 } } },
    });

    expect(executed).toEqual([{ ...calls[1]!, input: { value: 42 } }]);
    expect(batch.results).toMatchObject([
      { callId: "call-1", status: "error", summary: "blocked by policy" },
      { callId: "call-2", status: "ok", summary: '{"value":42}' },
    ]);
  });

  it("records safe fallbacks when hooks throw", async () => {
    const executor: ToolExecutor = { execute: async (call) => ok(call.callId, "original") };
    const beforeFailure = await executeToolBatch({
      calls: [calls[0]!],
      tools,
      executor,
      beforeToolCall: () => {
        throw new Error("before boom");
      },
    });
    const afterFailure = await executeToolBatch({
      calls: [calls[0]!],
      tools,
      executor,
      afterToolCall: () => {
        throw new Error("after boom");
      },
    });

    expect(beforeFailure.results[0]).toMatchObject({
      status: "error",
      summary: "beforeToolCall hook failed: before boom",
    });
    expect(beforeFailure.events).toContainEqual({
      type: "error",
      message: "beforeToolCall hook failed: before boom",
      recoverable: true,
    });
    expect(afterFailure.results[0]).toMatchObject({ status: "ok", summary: "original" });
    expect(afterFailure.events).toContainEqual({
      type: "error",
      message: "afterToolCall hook failed: after boom",
      recoverable: true,
    });
  });

  it("turns executor failures into data", async () => {
    const batch = await executeToolBatch({
      calls: [calls[0]!],
      tools,
      executor: {
        execute: () => {
          throw new Error("executor boom");
        },
      },
    });

    expect(batch.results[0]).toMatchObject({
      status: "error",
      summary: "tool execution failed: executor boom",
      output: "tool execution failed: executor boom",
    });
  });

  it("executes only the assistant-ordered prefix before a policy elicitation", async () => {
    const pauseCalls = [...calls, { callId: "call-3", name: "third", input: { value: 3 } }];
    const pauseTools = pauseCalls.map(({ name }) => ({
      name,
      title: name,
      description: `${name} tool`,
      schema: {},
      kind: "execute" as const,
    }));
    const checked: string[] = [];
    const executed: string[] = [];
    const elicitation = {
      type: "elicitation" as const,
      elicitationId: "elicit-2",
      kind: "approval" as const,
      prompt: "Approve second?",
      options: [{ id: "approve", label: "Approve" }],
      blocking: true,
    };
    const batch = await executeToolBatch({
      calls: pauseCalls,
      tools: pauseTools,
      executor: {
        execute: async (call) => {
          executed.push(call.callId);
          return ok(call.callId);
        },
      },
      beforeToolCall: ({ call }) => {
        checked.push(call.callId);
        return call.callId === "call-2"
          ? { action: "elicit", event: elicitation }
          : { action: "execute" };
      },
    });

    expect(checked).toEqual(["call-1", "call-2"]);
    expect(executed).toEqual(["call-1"]);
    expect(batch.results.map(({ callId }) => callId)).toEqual(["call-1"]);
    expect(batch.pendingElicitation).toEqual(elicitation);
    expect(batch.pendingToolCall).toEqual({ callId: "call-2", elicitationId: "elicit-2" });
  });

  it("emits each sequential tool result before starting the next call", async () => {
    const observed: string[] = [];
    await executeToolBatch({
      calls,
      tools: tools.map((tool) => ({ ...tool, execution: "sequential" })),
      executor: {
        execute: async (call) => {
          if (call.callId === "call-2") {
            expect(observed).toEqual(["call-1"]);
          }
          return ok(call.callId);
        },
      },
      onEvent: (event) => {
        if (event.type === "tool-result") observed.push(event.callId);
      },
    });

    expect(observed).toEqual(["call-1", "call-2"]);
  });
});
