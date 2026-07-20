import { describe, expect, it, vi } from "vitest";

import type { ToolCall, TranscriptMessage, Usage } from "../src/core/index.js";
import type { RunEventData } from "../src/events/index.js";
import { InMemoryRunStore } from "../src/memory/index.js";
import { FauxModelPort } from "../src/testing/index.js";
import type { FauxTurnScript } from "../src/testing/index.js";
import type { Clock, ToolExecutor, TurnResult } from "../src/ports/index.js";
import { runLoop } from "../src/loop/loop.js";

const usage: Usage = {
  inputTokens: 2,
  outputTokens: 3,
  totalTokens: 5,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};
const clock: Clock = { now: () => "2026-07-19T12:00:00.000Z" };
const author = { principalId: "principal-1", displayName: "Nelson" };

function message(role: TranscriptMessage["role"], text: string): TranscriptMessage {
  return { role, blocks: [{ type: "text", text }] };
}

function result(
  text: string,
  stopReason: TurnResult["stopReason"] = "stop",
  toolCalls: ToolCall[] = [],
): TurnResult {
  return { message: message("assistant", text), toolCalls, stopReason, usage };
}

async function setup(turns: FauxTurnScript[]): Promise<{
  store: InMemoryRunStore;
  model: FauxModelPort;
  executor: ToolExecutor;
  execute: ReturnType<typeof vi.fn>;
}> {
  const store = new InMemoryRunStore(clock);
  await store.createRun({
    id: "run-1",
    threadRef: "thread-1",
    state: "queued",
    trigger: "message",
    turnCount: 0,
  });
  const execute = vi.fn(async (call: ToolCall) => ({
    callId: call.callId,
    status: "ok" as const,
    summary: `${call.name} completed`,
    output: { received: call.input },
  }));
  return { store, model: new FauxModelPort(turns), executor: { execute }, execute };
}

function loopInput(
  fixture: Awaited<ReturnType<typeof setup>>,
  hooks: Parameters<typeof runLoop>[0]["hooks"] = {},
): Parameters<typeof runLoop>[0] {
  return {
    runId: "run-1",
    threadRef: "thread-1",
    model: { id: "test/model" },
    standing: {
      instructions: "Be useful.",
      rules: [{ id: "rule-1", type: "instruction", content: "Be concise." }],
      skillIndex: [{ name: "search", description: "Search the corpus" }],
    },
    threadMessages: [message("user", "start")],
    tools: [
      {
        name: "lookup",
        title: "Lookup",
        description: "Look something up",
        schema: {},
        kind: "search",
      },
    ],
    modelPort: fixture.model,
    store: fixture.store,
    toolExecutor: fixture.executor,
    abort: new AbortController().signal,
    hooks,
  };
}

describe("runLoop", () => {
  it("finishes a happy-path response and assembles standing context deterministically", async () => {
    const fixture = await setup([{ events: [], result: result("done") }]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({
      status: "finished",
      outcome: "completed",
      stopReason: "stop",
      turns: 1,
      usage,
    });
    expect(fixture.model.turnRequests[0]?.instructions).toBe(
      "Be useful.\n\nRules:\n[instruction:rule-1] Be concise.\n\nSkills:\n- search: Search the corpus",
    );
    expect(fixture.model.turnRequests[0]?.messages).toEqual([message("user", "start")]);
    expect(await fixture.store.listTurns("run-1")).toHaveLength(1);
  });

  it("appends stream events before requesting the next event", async () => {
    const fixture = await setup([]);
    const first: RunEventData = { type: "text-start", blockId: "text-1" };
    const second: RunEventData = { type: "text-delta", blockId: "text-1", delta: "live" };
    async function* events(): AsyncIterable<RunEventData> {
      yield first;
      expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toEqual([first]);
      yield second;
      expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toEqual([
        first,
        second,
      ]);
    }
    fixture.model = new FauxModelPort([{ events: events(), result: result("live") }]);

    await runLoop(loopInput(fixture));

    expect((await fixture.store.listEvents("run-1")).map(({ seq }) => seq)).toEqual([1, 2]);
  });

  it("feeds ordered tool results into a later model turn", async () => {
    const toolCall = { callId: "call-1", name: "lookup", input: { q: "trema" } };
    const fixture = await setup([
      { events: [], result: result("I will look", "toolUse", [toolCall]) },
      { events: [], result: result("found it") },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({ status: "finished", turns: 2 });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.model.turnRequests[1]?.messages).toEqual([
      message("user", "start"),
      message("assistant", "I will look"),
      {
        role: "toolResult",
        toolCallId: "call-1",
        blocks: [{ type: "text", text: "lookup completed" }],
        providerMeta: { status: "ok", output: { received: { q: "trema" } } },
      },
    ]);
  });

  it("never executes tool calls from a length-truncated turn", async () => {
    const toolCall = { callId: "call-1", name: "lookup", input: { partial: "{" } };
    const fixture = await setup([
      { events: [], result: result("truncated", "length", [toolCall]) },
      { events: [], result: result("recovered") },
    ]);

    await runLoop(loopInput(fixture));

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.model.turnRequests[1]?.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      blocks: [
        {
          type: "text",
          text: "tool call was not executed because its input may have been truncated",
        },
      ],
    });
  });

  it("finishes model errors as data", async () => {
    const fixture = await setup([
      {
        events: [{ type: "error", message: "provider failed", recoverable: true }],
        result: result("", "error"),
      },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({ status: "finished", outcome: "failed", stopReason: "error" });
    expect((await fixture.store.listEvents("run-1"))[0]?.event).toEqual({
      type: "error",
      message: "provider failed",
      recoverable: true,
    });
  });

  it("returns paused on a pending blocking elicitation", async () => {
    const elicitation: Extract<RunEventData, { type: "elicitation" }> = {
      type: "elicitation",
      elicitationId: "elicit-1",
      kind: "approval",
      prompt: "Proceed?",
      reference: { callId: "call-2" },
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      blocking: true,
    };
    const fixture = await setup([
      {
        events: [elicitation],
        result: result("Need approval", "paused", [
          { callId: "call-1", name: "lookup", input: {} },
          { callId: "call-2", name: "lookup", input: {} },
          { callId: "call-3", name: "lookup", input: {} },
        ]),
      },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({ status: "paused", stopReason: "paused", elicitation });
    expect(fixture.execute.mock.calls.map(([call]) => call.callId)).toEqual(["call-1"]);
    expect(await fixture.store.listTurns("run-1")).toMatchObject([
      {
        stopReason: "paused",
        pendingToolCall: { callId: "call-2", elicitationId: "elicit-1" },
        toolResults: [{ role: "toolResult", toolCallId: "call-1" }],
      },
    ]);
    expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toContainEqual({
      type: "segment-end",
      reason: "paused",
    });
  });

  it("persists the executed prefix and pending call for a beforeToolCall pause", async () => {
    const calls = [
      { callId: "call-1", name: "lookup", input: { order: 1 } },
      { callId: "call-2", name: "lookup", input: { order: 2 } },
      { callId: "call-3", name: "lookup", input: { order: 3 } },
    ];
    const elicitation: Extract<RunEventData, { type: "elicitation" }> = {
      type: "elicitation",
      elicitationId: "elicit-hook",
      kind: "confirmation",
      prompt: "Run the second call?",
      reference: { callId: "call-2" },
      options: [{ id: "yes", label: "Yes" }],
      blocking: true,
    };
    const fixture = await setup([{ events: [], result: result("Calling tools", "toolUse", calls) }]);
    const checked: string[] = [];

    const loopResult = await runLoop(
      loopInput(fixture, {
        beforeToolCall: ({ call }) => {
          checked.push(call.callId);
          return call.callId === "call-2"
            ? { action: "elicit", event: elicitation }
            : { action: "execute" };
        },
      }),
    );

    expect(loopResult).toMatchObject({ status: "paused", elicitation });
    expect(checked).toEqual(["call-1", "call-2"]);
    expect(fixture.execute.mock.calls.map(([call]) => call.callId)).toEqual(["call-1"]);
    expect(await fixture.store.listTurns("run-1")).toMatchObject([
      {
        stopReason: "paused",
        pendingToolCall: { callId: "call-2", elicitationId: "elicit-hook" },
        toolResults: [{ role: "toolResult", toolCallId: "call-1" }],
      },
    ]);
    expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toEqual([
      {
        type: "tool-result",
        callId: "call-1",
        status: "ok",
        summary: "lookup completed",
      },
      elicitation,
      { type: "segment-end", reason: "paused" },
    ]);
  });

  it("gates the first tool call when a stream elicitation references no known call", async () => {
    const elicitation: Extract<RunEventData, { type: "elicitation" }> = {
      type: "elicitation",
      elicitationId: "elicit-unknown",
      kind: "approval",
      prompt: "Proceed?",
      reference: { callId: "missing-call" },
      options: [{ id: "approve", label: "Approve" }],
      blocking: true,
    };
    const fixture = await setup([
      {
        events: [elicitation],
        result: result("Need approval", "paused", [
          { callId: "call-1", name: "lookup", input: {} },
          { callId: "call-2", name: "lookup", input: {} },
        ]),
      },
    ]);

    await runLoop(loopInput(fixture));

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(await fixture.store.listTurns("run-1")).toMatchObject([
      { pendingToolCall: { callId: "call-1", elicitationId: "elicit-unknown" } },
    ]);
  });

  it("drains and records steering queued during a turn before the next call", async () => {
    const fixture = await setup([]);
    async function* firstEvents(): AsyncIterable<RunEventData> {
      await fixture.store.enqueueSteering("run-1", {
        id: "steer-1",
        author,
        message: message("user", "also check staging"),
      });
    }
    fixture.model = new FauxModelPort([
      { events: firstEvents(), result: result("initial answer") },
      { events: [], result: result("updated answer") },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({ status: "finished", turns: 2 });
    expect(fixture.model.turnRequests[1]?.messages).toContainEqual(
      message("user", "also check staging"),
    );
    expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toContainEqual({
      type: "steering",
      author,
      text: "also check staging",
    });
  });

  it("drains follow-ups only after the run would otherwise end", async () => {
    const fixture = await setup([]);
    async function* firstEvents(): AsyncIterable<RunEventData> {
      await fixture.store.enqueueFollowUp("thread-1", {
        id: "follow-1",
        author,
        message: message("user", "one more thing"),
      });
    }
    fixture.model = new FauxModelPort([
      { events: firstEvents(), result: result("first answer") },
      { events: [], result: result("follow-up answer") },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({ status: "finished", turns: 2 });
    expect(fixture.model.turnRequests[1]?.messages).toEqual([
      message("user", "start"),
      message("assistant", "first answer"),
      message("user", "one more thing"),
    ]);
  });

  it("stops at the maxTurns cap without a shouldStop hook", async () => {
    const toolCall = { callId: "call-1", name: "lookup", input: {} };
    const fixture = await setup([
      { events: [], result: result("looking", "toolUse", [toolCall]) },
      { events: [], result: result("still looking", "toolUse", [toolCall]) },
    ]);

    const loopResult = await runLoop({ ...loopInput(fixture), maxTurns: 2 });

    expect(loopResult).toMatchObject({ status: "finished", turns: 2 });
    expect(fixture.model.turnRequests).toHaveLength(2);
  });

  it("fails as data when the port reports paused without a blocking elicitation", async () => {
    const fixture = await setup([{ events: [], result: result("hmm", "paused") }]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({
      status: "finished",
      outcome: "failed",
      stopReason: "error",
    });
    expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toContainEqual({
      type: "error",
      message: "model port reported paused without a blocking elicitation",
      recoverable: false,
    });
  });

  it("honors a budget stop from shouldStop after the tool batch", async () => {
    const toolCall = { callId: "call-1", name: "lookup", input: {} };
    const fixture = await setup([
      { events: [], result: result("looked", "toolUse", [toolCall]) },
    ]);
    const shouldStop = vi.fn(() => true);

    const loopResult = await runLoop(loopInput(fixture, { shouldStop }));

    expect(loopResult).toMatchObject({ status: "finished", turns: 1, stopReason: "toolUse" });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(shouldStop).toHaveBeenCalledOnce();
    expect(fixture.model.turnRequests).toHaveLength(1);
  });
});
