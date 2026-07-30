import type { RunEventData, ToolCall, TranscriptMessage, TurnResult, Usage } from "@trema/harness";
import { InMemoryEngine, InMemoryRunStore, RunLifecycle, ThreadDispatchLock } from "@trema/harness";
import { FakeContextSession, FauxModelPort, type FauxTurnScript } from "@trema/harness/testing";
import { describe, expect, it } from "vitest";

import { createRunDriver, type RunExecutionPlan } from "#server/services/runs/driver.js";
import { deriveRunMessages, deriveThreadMessages } from "#server/services/runs/history.js";

const now = "2026-07-19T12:00:00.000Z";
const author = { principalId: "principal-1", displayName: "Nelson" };
const usage: Usage = {
  inputTokens: 2,
  outputTokens: 2,
  totalTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

function user(text: string): TranscriptMessage {
  return { role: "user", blocks: [{ type: "text", text }] };
}

function assistant(...texts: string[]): TranscriptMessage {
  return { role: "assistant", blocks: texts.map((text) => ({ type: "text", text })) };
}

/** The events a model port streams for one block of text, in recorded order. */
function textEvents(blockId: string, text: string): RunEventData[] {
  return [
    { type: "text-start", blockId },
    { type: "text-delta", blockId, delta: text },
    { type: "text-end", blockId },
  ];
}

function turn(text: string, toolCalls: ToolCall[] = []): TurnResult {
  return {
    message: assistant(text),
    toolCalls,
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    usage,
  };
}

/**
 * Records a real run log by executing the harness loop against a scripted port.
 *
 * The derivation reads what the loop actually writes, so the fixtures are
 * recorded rather than hand-shaped: an ordering change in the loop shows up
 * here as a failing assertion instead of a silently stale expectation.
 */
async function recordRun(options: {
  store: InMemoryRunStore;
  threadRef: string;
  opening?: string;
  turns: FauxTurnScript[];
  threadMessages?: TranscriptMessage[];
}): Promise<{ runId: string; events: RunEventData[]; modelPort: FauxModelPort }> {
  const engine = new InMemoryEngine();
  const modelPort = new FauxModelPort(options.turns);
  const lifecycle = new RunLifecycle({
    store: options.store,
    engine,
    context: new FakeContextSession({
      sessionId: "session-1",
      scopeChain: [],
      standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
      tools: [],
      policySnapshot: {},
      snapshotHash: "snapshot-1",
    }),
    lock: new ThreadDispatchLock(),
    createId: () => `run-${Math.random().toString(36).slice(2, 10)}`,
    now: () => now,
  });
  const plan = async (): Promise<RunExecutionPlan> => ({
    model: { id: "test/model" },
    modelPort,
    standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
    tools: [
      { name: "lookup", title: "Lookup", description: "Look it up", schema: {}, kind: "search" },
    ],
    threadMessages: options.threadMessages ?? [],
  });
  const driver = createRunDriver({
    store: options.store,
    lifecycle,
    toolExecutor: {
      execute: async (call) => ({
        callId: call.callId,
        status: "ok",
        summary: `${call.name} completed`,
        output: "{}",
      }),
    },
    plan,
  });

  const run = await lifecycle.create({ threadRef: options.threadRef, trigger: "message" });
  if (options.opening !== undefined) {
    await options.store.enqueueSteering(run.id, {
      id: `intent-${run.id}`,
      author,
      message: user(options.opening),
    });
  }
  await driver.execute(run.id);
  const events = (await options.store.listEvents(run.id)).map(({ event }) => event);
  return { runId: run.id, events, modelPort };
}

describe("deriveRunMessages", () => {
  it("keeps the opening message and the final text of a recorded run", async () => {
    const store = new InMemoryRunStore({ now: () => now });
    const recorded = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "What broke the deploy?",
      turns: [{ events: textEvents("text-1", "The migration timed out."), result: turn("done") }],
    });

    expect(recorded.events.map(({ type }) => type)).toEqual([
      "run-started",
      "steering",
      "text-start",
      "text-delta",
      "text-end",
      "run-finished",
    ]);
    expect(deriveRunMessages(recorded.events)).toEqual([
      user("What broke the deploy?"),
      assistant("The migration timed out."),
    ]);
  });

  it("drops the narration a tool call interrupted and keeps the answer", async () => {
    const store = new InMemoryRunStore({ now: () => now });
    const call = { callId: "call-1", name: "lookup", input: { q: "deploy" } };
    const recorded = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "What broke the deploy?",
      turns: [
        {
          events: [
            ...textEvents("text-1", "Let me look."),
            {
              type: "tool-start",
              callId: call.callId,
              name: "lookup",
              title: "Lookup",
              kind: "search",
            },
            { type: "tool-input", callId: call.callId, input: call.input },
          ],
          result: turn("Let me look.", [call]),
        },
        { events: textEvents("text-2", "The migration timed out."), result: turn("answer") },
      ],
    });

    expect(deriveRunMessages(recorded.events)).toEqual([
      user("What broke the deploy?"),
      assistant("The migration timed out."),
    ]);
  });

  it("joins several final text parts into one assistant message", async () => {
    const store = new InMemoryRunStore({ now: () => now });
    const recorded = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "Summarize.",
      turns: [
        {
          events: [
            ...textEvents("text-1", "First point."),
            ...textEvents("text-2", "Second point."),
          ],
          result: turn("done"),
        },
      ],
    });

    expect(deriveRunMessages(recorded.events)).toEqual([
      user("Summarize."),
      assistant("First point.", "Second point."),
    ]);
  });

  it("keeps a follow-up the run absorbed, and the answer before it", async () => {
    const store = new InMemoryRunStore({ now: () => now });
    // The follow-up is queued while the first turn streams, so the loop finds
    // it where it drains one: after the run would otherwise have ended.
    async function* answerAndQueueFollowUp(): AsyncIterable<RunEventData> {
      await store.enqueueFollowUp("thread-1", {
        id: "intent-follow-1",
        author,
        message: user("And the migration?"),
      });
      yield* textEvents("text-1", "The deploy timed out.");
    }
    const recorded = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "What broke the deploy?",
      turns: [
        { events: answerAndQueueFollowUp(), result: turn("done") },
        { events: textEvents("text-2", "It ran twice."), result: turn("done") },
      ],
    });

    // The absorbed message is in the log exactly once, as the steering event
    // that says where the run took it in.
    expect(recorded.events.filter(({ type }) => type === "steering")).toEqual([
      { type: "steering", author, text: "What broke the deploy?" },
      { type: "steering", author, text: "And the migration?" },
    ]);
    expect(recorded.events.map(({ type }) => type)).toEqual([
      "run-started",
      "steering",
      "text-start",
      "text-delta",
      "text-end",
      "segment-end",
      "steering",
      "text-start",
      "text-delta",
      "text-end",
      "run-finished",
    ]);
    expect(deriveRunMessages(recorded.events)).toEqual([
      user("What broke the deploy?"),
      assistant("The deploy timed out."),
      user("And the migration?"),
      assistant("It ran twice."),
    ]);
  });

  it("counts only pre-turn-one steering as the opening message", () => {
    const events: RunEventData[] = [
      { type: "run-started", trigger: "message" },
      { type: "steering", author, text: "Check staging." },
      ...textEvents("text-1", "Checking staging."),
      { type: "steering", author, text: "Production too." },
      ...textEvents("text-2", "Both are healthy."),
      { type: "run-finished", outcome: "completed", usage },
    ];

    expect(deriveRunMessages(events)).toEqual([
      user("Check staging."),
      assistant("Both are healthy."),
    ]);
  });

  it("carries a run that never got a message, and one that never answered", () => {
    const scheduled: RunEventData[] = [
      { type: "run-started", trigger: "schedule" },
      ...textEvents("text-1", "Nightly report ready."),
      { type: "run-finished", outcome: "completed", usage },
    ];
    const failed: RunEventData[] = [
      { type: "run-started", trigger: "message" },
      { type: "steering", author, text: "What broke the deploy?" },
      ...textEvents("text-1", "Let me look."),
      { type: "error", message: "model unavailable", recoverable: false },
      { type: "run-finished", outcome: "failed", usage, errorMessage: "model unavailable" },
    ];

    expect(deriveRunMessages(scheduled)).toEqual([assistant("Nightly report ready.")]);
    // A retry is a new run with nothing queued on it, so the failed run's
    // message has to survive; its half-written narration must not.
    expect(deriveRunMessages(failed)).toEqual([user("What broke the deploy?")]);
    expect(deriveRunMessages([])).toEqual([]);
  });

  it("skips unknown event types", () => {
    const events = [
      { type: "run-started", trigger: "message" },
      { type: "steering", author, text: "Hello." },
      { type: "handshake", greeting: "from a newer writer" },
      ...textEvents("text-1", "Hi."),
    ] as RunEventData[];

    expect(deriveRunMessages(events)).toEqual([user("Hello."), assistant("Hi.")]);
  });
});

describe("deriveThreadMessages", () => {
  it("gives a second run on the thread the first run's exchange", async () => {
    const store = new InMemoryRunStore({ now: () => now });
    const first = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "What broke the deploy?",
      turns: [{ events: textEvents("text-1", "The migration timed out."), result: turn("done") }],
    });

    const threadMessages = deriveThreadMessages([first]);
    const second = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "How long did it hang?",
      threadMessages,
      turns: [{ events: textEvents("text-2", "Eleven minutes."), result: turn("done") }],
    });

    expect(threadMessages).toEqual([
      user("What broke the deploy?"),
      assistant("The migration timed out."),
    ]);
    // The loop assembles thread history first and drains this run's opening
    // message at the turn boundary, so the model sees the whole conversation.
    expect(second.modelPort.turnRequests[0]?.messages).toEqual([
      user("What broke the deploy?"),
      assistant("The migration timed out."),
      user("How long did it hang?"),
    ]);
    expect(deriveThreadMessages([first, second])).toEqual([
      user("What broke the deploy?"),
      assistant("The migration timed out."),
      user("How long did it hang?"),
      assistant("Eleven minutes."),
    ]);
  });

  it("gives the next run a follow-up the prior run absorbed, once and in order", async () => {
    const store = new InMemoryRunStore({ now: () => now });
    async function* answerAndQueueFollowUp(): AsyncIterable<RunEventData> {
      await store.enqueueFollowUp("thread-1", {
        id: "intent-follow-1",
        author,
        message: user("And the migration?"),
      });
      yield* textEvents("text-1", "The deploy timed out.");
    }
    const first = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "What broke the deploy?",
      turns: [
        { events: answerAndQueueFollowUp(), result: turn("done") },
        { events: textEvents("text-2", "It ran twice."), result: turn("done") },
      ],
    });

    const threadMessages = deriveThreadMessages([first]);
    const second = await recordRun({
      store,
      threadRef: "thread-1",
      opening: "Why twice?",
      threadMessages,
      turns: [{ events: textEvents("text-3", "A retry."), result: turn("done") }],
    });

    expect(second.modelPort.turnRequests[0]?.messages).toEqual([
      user("What broke the deploy?"),
      assistant("The deploy timed out."),
      user("And the migration?"),
      assistant("It ran twice."),
      user("Why twice?"),
    ]);
  });

  it("preserves run order and contributes nothing for an empty log", () => {
    const runs = [
      { runId: "run-1", events: [] },
      {
        runId: "run-2",
        events: [
          { type: "run-started" as const, trigger: "message" as const },
          { type: "steering" as const, author, text: "Second." },
        ],
      },
      {
        runId: "run-3",
        events: [
          { type: "run-started" as const, trigger: "message" as const },
          { type: "steering" as const, author, text: "Third." },
        ],
      },
    ];

    expect(deriveThreadMessages(runs)).toEqual([user("Second."), user("Third.")]);
  });
});
