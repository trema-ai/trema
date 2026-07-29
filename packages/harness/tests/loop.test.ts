import { describe, expect, it, vi } from "vitest";

import type { ToolCall, TranscriptMessage, Usage } from "#harness/core/index.js";
import type { RunEventData } from "#harness/events/index.js";
import { runLoop } from "#harness/loop/loop.js";
import { InMemoryRunStore } from "#harness/memory/index.js";
import type { Clock, ToolExecutor, TurnResult } from "#harness/ports/index.js";
import type { FauxTurnScript } from "#harness/testing/index.js";
import { FauxModelPort } from "#harness/testing/index.js";

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
    output: JSON.stringify({ received: call.input }),
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
        status: "ok",
        blocks: [{ type: "text", text: '{"received":{"q":"trema"}}' }],
      },
    ]);
  });

  it("loads live typed tools after discovery and retains their keys", async () => {
    const fixture = await setup([
      {
        events: [],
        result: result("I will find the right tool", "toolUse", [
          { callId: "search-1", name: "search_tools", input: { query: "create issue" } },
        ]),
      },
      {
        events: [],
        result: result("I will create it", "toolUse", [
          { callId: "connector-1", name: "github_create_issue", input: { title: "Bug" } },
        ]),
      },
      { events: [], result: result("done") },
    ]);
    fixture.execute.mockImplementation(async (call: ToolCall) => ({
      callId: call.callId,
      status: "ok",
      summary: `${call.name} completed`,
      output: "{}",
      ...(call.name === "search_tools" ? { activatedToolKeys: ["github:create_issue"] } : {}),
    }));
    const input = loopInput(fixture);
    input.tools = [
      {
        key: "context:search_tools",
        name: "search_tools",
        title: "Search tools",
        description: "Find a tool",
        schema: {},
        kind: "search",
      },
    ];
    const connectorTool = {
      key: "github:create_issue",
      name: "github_create_issue",
      title: "Create issue",
      description: "Create an issue",
      schema: { type: "object" },
      kind: "connector" as const,
    };
    fixture.executor.resolveTools = async (keys) =>
      keys.includes(connectorTool.key) ? [connectorTool] : [];

    await runLoop(input);

    expect(fixture.model.turnRequests.map(({ tools }) => tools.map(({ name }) => name))).toEqual([
      ["search_tools"],
      ["search_tools", "github_create_issue"],
      ["search_tools", "github_create_issue"],
    ]);
    expect(fixture.execute.mock.calls.map(([call]) => call.name)).toEqual([
      "search_tools",
      "github_create_issue",
    ]);
  });

  it("reconstructs active keys from committed tool results", async () => {
    const fixture = await setup([{ events: [], result: result("resumed") }]);
    await fixture.store.commitTurn({
      turn: {
        runId: "run-1",
        index: 0,
        model: { id: "test/model" },
        message: {
          role: "assistant",
          blocks: [
            {
              type: "toolCall",
              callId: "search-1",
              name: "search_tools",
              input: { query: "create issue" },
            },
          ],
        },
        toolResults: [
          {
            role: "toolResult",
            toolCallId: "search-1",
            status: "ok",
            blocks: [{ type: "text", text: "{}" }],
            activatedToolKeys: ["github:create_issue"],
          },
        ],
        stopReason: "toolUse",
        usage,
      },
    });
    const input = loopInput(fixture);
    const connectorTool = {
      key: "github:create_issue",
      name: "github_create_issue",
      title: "Create issue",
      description: "Create an issue",
      schema: {},
      kind: "connector" as const,
    };
    fixture.executor.resolveTools = async (keys) =>
      keys.includes(connectorTool.key) ? [connectorTool] : [];

    await runLoop(input);

    expect(fixture.model.turnRequests[0]?.tools.map(({ name }) => name)).toEqual([
      "lookup",
      "github_create_issue",
    ]);
  });

  it("bounds the active live-tool working set", async () => {
    const keys = Array.from({ length: 13 }, (_, index) => `connector:tool_${index}`);
    const fixture = await setup([
      {
        events: [],
        result: result("discover", "toolUse", [{ callId: "search-1", name: "lookup", input: {} }]),
      },
      { events: [], result: result("done") },
    ]);
    fixture.execute.mockResolvedValue({
      callId: "search-1",
      status: "ok",
      summary: "found",
      output: "{}",
      activatedToolKeys: keys,
    });
    const input = loopInput(fixture);
    const connectorTools = keys.map((key, index) => ({
      key,
      name: `tool_${index}`,
      title: `Tool ${index}`,
      description: `Tool ${index}`,
      schema: {},
      kind: "connector" as const,
    }));
    fixture.executor.resolveTools = async (activeKeys) =>
      connectorTools.filter(({ key }) => activeKeys.includes(key));

    await runLoop(input);

    expect(fixture.model.turnRequests[1]?.tools.map(({ name }) => name)).toEqual([
      "lookup",
      ...Array.from({ length: 12 }, (_, index) => `tool_${index + 1}`),
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
      status: "error",
      blocks: [
        {
          type: "text",
          text: "tool call was not executed because its input may have been truncated",
        },
      ],
    });
  });

  it("finishes model errors as data", async () => {
    const error = { message: "provider failed", retryable: true, retryAfterMs: 2500 };
    const fixture = await setup([
      {
        events: [{ type: "error", message: "provider failed", recoverable: true }],
        result: { ...result("", "error"), error },
      },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({
      status: "finished",
      outcome: "failed",
      stopReason: "error",
      error,
    });
    expect((await fixture.store.listEvents("run-1"))[0]?.event).toEqual({
      type: "error",
      message: "provider failed",
      recoverable: true,
    });
  });

  it("discards an aborted turn and its partial events", async () => {
    const fixture = await setup([
      {
        events: [{ type: "text-delta", blockId: "text-1", delta: "partial" }],
        result: result("partial", "aborted"),
      },
    ]);

    const loopResult = await runLoop(loopInput(fixture));

    expect(loopResult).toMatchObject({ outcome: "cancelled", turns: 0 });
    expect(await fixture.store.listTurns("run-1")).toEqual([]);
    expect(await fixture.store.listEvents("run-1")).toEqual([]);
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
    const fixture = await setup([
      { events: [], result: result("Calling tools", "toolUse", calls) },
    ]);
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
    // biome-ignore lint/correctness/useYield: fixture is a deliberately empty event stream that only performs a side effect
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

  it("replays steering-delivered messages when a parked run resumes", async () => {
    const elicitation: Extract<RunEventData, { type: "elicitation" }> = {
      type: "elicitation",
      elicitationId: "elicit-1",
      kind: "approval",
      prompt: "Proceed?",
      reference: { callId: "call-2" },
      options: [{ id: "approve", label: "Approve" }],
      blocking: true,
    };
    const fixture = await setup([]);
    await fixture.store.enqueueSteering("run-1", {
      id: "steer-open",
      author,
      message: message("user", "check staging"),
    });
    // biome-ignore lint/correctness/useYield: fixture is a deliberately empty event stream that only performs a side effect
    async function* firstEvents(): AsyncIterable<RunEventData> {
      await fixture.store.enqueueSteering("run-1", {
        id: "steer-mid",
        author,
        message: message("user", "also check production"),
      });
    }
    fixture.model = new FauxModelPort([
      {
        events: firstEvents(),
        result: result("looking", "toolUse", [{ callId: "call-1", name: "lookup", input: {} }]),
      },
      {
        events: [elicitation],
        result: {
          message: {
            role: "assistant",
            blocks: [
              { type: "text", text: "I need approval" },
              { type: "toolCall", callId: "call-2", name: "lookup", input: {} },
            ],
          },
          toolCalls: [{ callId: "call-2", name: "lookup", input: {} }],
          stopReason: "paused",
          usage,
        },
      },
      { events: [], result: result("both are healthy") },
    ]);

    const paused = await runLoop(loopInput(fixture));
    expect(paused).toMatchObject({ status: "paused", elicitation });
    await fixture.store.resolveElicitation("elicit-1", {
      optionId: "approve",
      decision: "approved",
      scope: "once",
      by: author,
      at: clock.now(),
    });

    // A resume is a fresh execution reading the log; nothing survives in memory.
    const resumed = await runLoop(loopInput(fixture));

    expect(resumed).toMatchObject({ status: "finished", outcome: "completed" });
    expect(fixture.model.turnRequests[2]?.messages).toEqual([
      message("user", "start"),
      message("user", "check staging"),
      message("assistant", "looking"),
      {
        role: "toolResult",
        toolCallId: "call-1",
        status: "ok",
        blocks: [{ type: "text", text: '{"received":{}}' }],
      },
      message("user", "also check production"),
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "I need approval" },
          { type: "toolCall", callId: "call-2", name: "lookup", input: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        status: "ok",
        blocks: [{ type: "text", text: '{"received":{}}' }],
      },
    ]);
  });

  it("drains follow-ups only after the run would otherwise end", async () => {
    const fixture = await setup([]);
    // biome-ignore lint/correctness/useYield: fixture is a deliberately empty event stream that only performs a side effect
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
    // The answer is a finished segment and the follow-up is a message the run
    // absorbed: both are facts of the log, so the thread can be read back from
    // it without knowing what was queued.
    const events = (await fixture.store.listEvents("run-1")).map(({ event }) => event);
    expect(events).toEqual([
      { type: "segment-end", reason: "completed" },
      { type: "steering", author, text: "one more thing" },
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
    const fixture = await setup([{ events: [], result: result("looked", "toolUse", [toolCall]) }]);
    const shouldStop = vi.fn(() => true);

    const loopResult = await runLoop(loopInput(fixture, { shouldStop }));

    expect(loopResult).toMatchObject({ status: "finished", turns: 1, stopReason: "toolUse" });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(shouldStop).toHaveBeenCalledOnce();
    expect(fixture.model.turnRequests).toHaveLength(1);
  });
});
