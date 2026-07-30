import { describe, expect, it, vi } from "vitest";

import type { RunEventData } from "#harness/events/index.js";
import { runLoop } from "#harness/loop/index.js";
import { InMemoryRunStore } from "#harness/memory/index.js";
import type { TurnRecord } from "#harness/ports/index.js";
import { createBlockingElicitation, InterruptManager } from "#harness/run/index.js";
import { FakeContextSession, FauxModelPort } from "#harness/testing/index.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};
const by = { principalId: "principal-1", displayName: "Nelson" };
const now = "2026-07-19T12:00:00.000Z";

function context() {
  return new FakeContextSession({
    sessionId: "session-1",
    scopeChain: [],
    standing: { instructions: "", rules: [], skillIndex: [] },
    tools: [],
    policySnapshot: {},
    snapshotHash: "snapshot-1",
  });
}

async function parked(
  event = createBlockingElicitation("elicit-1", {
    type: "approval_required",
    callId: "call-1",
    approvalId: "approval-1",
    reason: "Approve the connector call?",
  }),
  expiresAt = "2026-07-20T12:00:00.000Z",
) {
  const store = new InMemoryRunStore({ now: () => now });
  await store.createRun({
    id: "run-1",
    threadRef: "thread-1",
    sessionId: "session-1",
    state: "running",
    trigger: "message",
    turnCount: 0,
  });
  const turn: TurnRecord = {
    runId: "run-1",
    index: 0,
    model: { id: "test/model" },
    message: {
      role: "assistant",
      blocks: [
        { type: "text", text: "I need permission." },
        { type: "toolCall", callId: "call-1", name: "connector", input: { q: "trema" } },
      ],
    },
    toolResults: [],
    pendingToolCall: { callId: "call-1", elicitationId: event.elicitationId },
    stopReason: "paused",
    usage,
  };
  await store.commitTurn({
    turn,
    state: event.kind === "approval" ? "awaiting_approval" : "awaiting_input",
    events: [event, { type: "segment-end", reason: "paused" }],
    elicitation: { runId: "run-1", event, expiresAt },
  });
  return { store, turn, event };
}

describe("interrupts", () => {
  it("normalizes connector, ask-user, and hook confirmation gates", () => {
    const sources = [
      createBlockingElicitation("approval", {
        type: "approval_required",
        callId: "call-1",
        approvalId: "approval-1",
        reason: "Approve?",
      }),
      createBlockingElicitation("question", {
        type: "ask_user",
        callId: "call-2",
        prompt: "Which environment?",
        options: [{ id: "staging", label: "Staging" }],
      }),
      createBlockingElicitation("hook", {
        type: "confirmation",
        callId: "call-3",
        prompt: "Run this command?",
      }),
    ];

    expect(sources.map(({ kind }) => kind)).toEqual(["approval", "choice", "confirmation"]);
    expect(sources.every(({ blocking }) => blocking)).toBe(true);
  });

  it("parks, resolves through the context session, and requests resume", async () => {
    const fixture = await parked();
    const session = context();
    const enqueueResume = vi.fn(async () => undefined);
    const manager = new InterruptManager({
      store: fixture.store,
      context: session,
      now: () => now,
      isParticipant: () => true,
      enqueueResume,
    });

    expect(
      await manager.resolve({
        elicitationId: "elicit-1",
        optionId: "approve",
        decision: "approved",
        scope: "run",
        by,
      }),
    ).toBe("resolved");
    expect(session.calls).toContainEqual({
      method: "resolveApproval",
      args: ["session-1", "approval-1", "approved", "run", by],
    });
    expect(enqueueResume).toHaveBeenCalledOnce();
    expect((await fixture.store.listEvents("run-1")).map(({ event }) => event.type)).toEqual([
      "elicitation",
      "segment-end",
      "elicitation-resolved",
    ]);
    expect((await fixture.store.getRun("run-1"))?.runGrants).toEqual(["connector"]);
  });

  it("feeds denial back as a denied tool result and continues the loop", async () => {
    const fixture = await parked(
      createBlockingElicitation("elicit-1", {
        type: "confirmation",
        callId: "call-1",
        prompt: "Proceed?",
      }),
    );
    const manager = new InterruptManager({
      store: fixture.store,
      context: context(),
      now: () => now,
      isParticipant: () => true,
      enqueueResume: async () => undefined,
    });
    await manager.resolve({
      elicitationId: "elicit-1",
      optionId: "deny",
      decision: "denied",
      by,
      reason: "production changes require a maintenance window",
    });
    const model = new FauxModelPort([
      {
        events: [] as RunEventData[],
        result: {
          message: { role: "assistant", blocks: [{ type: "text", text: "I will not do that." }] },
          toolCalls: [],
          stopReason: "stop",
          usage,
        },
      },
    ]);
    const execute = vi.fn();

    await runLoop({
      runId: "run-1",
      threadRef: "thread-1",
      model: { id: "test/model" },
      standing: { instructions: "", rules: [], skillIndex: [] },
      threadMessages: [],
      tools: [
        {
          name: "connector",
          title: "Connector",
          description: "Connector call",
          schema: {},
          kind: "connector",
        },
      ],
      modelPort: model,
      store: fixture.store,
      toolExecutor: { execute },
      abort: new AbortController().signal,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(model.turnRequests[0]?.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      status: "denied",
      blocks: [
        {
          type: "text",
          text: "denied by Nelson: production changes require a maintenance window",
        },
      ],
    });
    expect((await fixture.store.listEvents("run-1")).map(({ event }) => event)).toContainEqual({
      type: "tool-result",
      callId: "call-1",
      status: "denied",
      summary: "denied by Nelson: production changes require a maintenance window",
    });
    expect((await fixture.store.listTurns("run-1"))[0]).toMatchObject({
      stopReason: "toolUse",
    });
  });

  it("feeds an answered choice back as text", async () => {
    const fixture = await parked(
      createBlockingElicitation("elicit-1", {
        type: "ask_user",
        callId: "call-1",
        prompt: "Which environment?",
        options: [{ id: "staging", label: "Staging" }],
      }),
    );
    await fixture.store.resolveElicitation("elicit-1", {
      optionId: "staging",
      decision: "answered",
      scope: "once",
      by,
      at: now,
    });
    const model = new FauxModelPort([
      {
        events: [] as RunEventData[],
        result: {
          message: { role: "assistant", blocks: [{ type: "text", text: "Checking staging." }] },
          toolCalls: [],
          stopReason: "stop",
          usage,
        },
      },
    ]);

    await runLoop({
      runId: "run-1",
      threadRef: "thread-1",
      model: { id: "test/model" },
      standing: { instructions: "", rules: [], skillIndex: [] },
      threadMessages: [],
      tools: [],
      modelPort: model,
      store: fixture.store,
      toolExecutor: { execute: vi.fn() },
      abort: new AbortController().signal,
    });

    expect(model.turnRequests[0]?.messages.at(-1)).toEqual({
      role: "toolResult",
      toolCallId: "call-1",
      status: "ok",
      blocks: [{ type: "text", text: "staging" }],
    });
  });

  it("makes double resolution idempotent", async () => {
    const fixture = await parked();
    const session = context();
    const enqueueResume = vi.fn(async () => undefined);
    const manager = new InterruptManager({
      store: fixture.store,
      context: session,
      now: () => now,
      isParticipant: () => true,
      enqueueResume,
    });
    const input = {
      elicitationId: "elicit-1",
      optionId: "approve",
      decision: "approved" as const,
      by,
    };

    const outcomes = await Promise.all([manager.resolve(input), manager.resolve(input)]);
    expect(outcomes.sort()).toEqual(["already-resolved", "resolved"]);
    expect(session.calls.filter(({ method }) => method === "resolveApproval")).toHaveLength(1);
    expect(enqueueResume).toHaveBeenCalledOnce();
  });

  it("expires a parked run as stale and refuses to resume it", async () => {
    const fixture = await parked(undefined, "2026-07-18T12:00:00.000Z");
    const manager = new InterruptManager({
      store: fixture.store,
      context: context(),
      now: () => now,
      isParticipant: () => true,
      enqueueResume: async () => undefined,
    });

    expect(await manager.expire("elicit-1")).toBe("resolved");
    expect((await fixture.store.getRun("run-1"))?.state).toBe("stale");
    expect((await fixture.store.listEvents("run-1")).at(-1)?.event).toMatchObject({
      type: "elicitation-resolved",
      optionId: "expired",
    });
    await expect(
      manager.resolve({
        elicitationId: "elicit-1",
        optionId: "approve",
        decision: "approved",
        by,
      }),
    ).resolves.toBe("already-resolved");
  });
});
