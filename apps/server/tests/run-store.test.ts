import type { RunRecord, TurnRecord } from "@trema/harness";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "#/lib/db/index.js";
import { PrismaRunStore } from "#/services/runs/store.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0001,
};
const author = { principalId: "principal-1", displayName: "Nelson" };

integration("Prisma run store", () => {
  const db = createPrismaClient(databaseUrl);
  const clock = { now: () => "2026-07-19T12:00:00.000Z" };
  let orgId = "";
  let store: PrismaRunStore;

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org" CASCADE`;
    const org = await db.org.create({ data: { name: "Run store org" } });
    orgId = org.id;
    store = new PrismaRunStore({ db, orgId, clock });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  function record(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      id: "run-1",
      threadRef: "thread-1",
      state: "queued",
      trigger: "message",
      turnCount: 0,
      ...overrides,
    };
  }

  function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
    return {
      runId: "run-1",
      index: 0,
      model: { id: "test/model" },
      message: { role: "assistant", blocks: [{ type: "text", text: "done" }] },
      toolResults: [],
      stopReason: "stop",
      usage,
      ...overrides,
    };
  }

  it("assigns a dense per-run sequence under concurrent appends", async () => {
    await store.createRun(record());

    const appended = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.appendEvent("run-1", { type: "data", name: "test", data: index }),
      ),
    );

    const expected = Array.from({ length: 50 }, (_, index) => index + 1);
    expect([...appended.map(({ seq }) => seq)].sort((a, b) => a - b)).toEqual(expected);
    expect((await store.listEvents("run-1")).map(({ seq }) => seq)).toEqual(expected);
    expect(await store.eventCursor("run-1")).toBe(50);
  });

  it("keeps the sequence dense when several runs append at once", async () => {
    await store.createRun(record());
    await store.createRun(record({ id: "run-2", threadRef: "thread-2" }));

    await Promise.all(
      ["run-1", "run-2"].flatMap((runId) =>
        Array.from({ length: 10 }, (_, index) =>
          store.appendEvent(runId, { type: "data", name: "test", data: index }),
        ),
      ),
    );

    for (const runId of ["run-1", "run-2"]) {
      expect((await store.listEvents(runId)).map(({ seq }) => seq)).toEqual(
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
    }
  });

  it("rejects an event that repeats an assigned sequence number", async () => {
    await store.createRun(record());
    const appended = await store.appendEvent("run-1", { type: "data", name: "test", data: 1 });

    await expect(
      db.runEvent.create({
        data: {
          orgId,
          runId: "run-1",
          seq: appended.seq,
          at: new Date(clock.now()),
          event: { type: "data", name: "duplicate", data: 2 },
        },
      }),
    ).rejects.toThrow();
    expect(await store.listEvents("run-1")).toHaveLength(1);
  });

  it("commits a turn, its state change, and its events together", async () => {
    await store.createRun(record());
    await store.transitionRun({
      runId: "run-1",
      state: "running",
      event: { type: "run-started", trigger: "message" },
    });

    await store.commitTurn({
      turn: turn({
        stopReason: "paused",
        pendingToolCall: { callId: "call-1", elicitationId: "elicit-1" },
      }),
      state: "awaiting_approval",
      events: [
        {
          type: "elicitation",
          elicitationId: "elicit-1",
          kind: "approval",
          prompt: "Approve?",
          reference: { callId: "call-1", approvalId: "approval-1" },
          options: [{ id: "approve", label: "Approve" }],
          blocking: true,
        },
        { type: "segment-end", reason: "paused" },
      ],
      elicitation: {
        runId: "run-1",
        event: {
          type: "elicitation",
          elicitationId: "elicit-1",
          kind: "approval",
          prompt: "Approve?",
          reference: { callId: "call-1", approvalId: "approval-1" },
          options: [{ id: "approve", label: "Approve" }],
          blocking: true,
        },
        expiresAt: "2026-07-20T12:00:00.000Z",
      },
    });

    const stored = await store.getRun("run-1");
    expect(stored).toMatchObject({ state: "awaiting_approval", turnCount: 1 });
    expect((await store.listEvents("run-1")).map(({ event }) => event.type)).toEqual([
      "run-started",
      "elicitation",
      "segment-end",
    ]);
    expect((await store.listTurns("run-1"))[0]).toMatchObject({
      index: 0,
      stopReason: "paused",
      pendingToolCall: { callId: "call-1", elicitationId: "elicit-1" },
    });
    expect(await store.getElicitation("elicit-1")).toMatchObject({
      runId: "run-1",
      expiresAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("writes neither the turn nor its events when the state change is illegal", async () => {
    await store.createRun(record());

    await expect(
      store.commitTurn({
        turn: turn(),
        state: "completed",
        events: [{ type: "turn-finished", turn: 0, stopReason: "stop", usage }],
      }),
    ).rejects.toThrow("illegal run state transition: queued -> completed");

    expect(await store.listTurns("run-1")).toEqual([]);
    expect(await store.listEvents("run-1")).toEqual([]);
    expect(await store.eventCursor("run-1")).toBe(0);
  });

  it("rejects a turn that does not follow the last committed turn", async () => {
    await store.createRun(record());
    await store.commitTurn({ turn: turn() });

    await expect(store.commitTurn({ turn: turn({ index: 0 }) })).rejects.toThrow(
      "turn index 0 is not next for run run-1",
    );
    await expect(store.commitTurn({ turn: turn({ index: 2 }) })).rejects.toThrow(
      "turn index 2 is not next for run run-1",
    );
  });

  it("claims an intent identifier once", async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.recordIntent("intent-1")),
    );
    expect(claims.filter((claim) => claim === "recorded")).toHaveLength(1);
    expect(claims.filter((claim) => claim === "duplicate")).toHaveLength(4);
  });

  it("drains steering in enqueue order and promotes it to a thread follow-up", async () => {
    await store.createRun(record());
    const message = (text: string) => ({
      role: "user" as const,
      blocks: [{ type: "text" as const, text }],
    });
    await store.enqueueSteering("run-1", { id: "intent-1", author, message: message("first") });
    await store.enqueueSteering("run-1", { id: "intent-2", author, message: message("second") });

    expect(await store.hasSteering("run-1")).toBe(true);
    const drained = await store.drainSteering("run-1");
    expect(drained.map(({ id }) => id)).toEqual(["intent-1", "intent-2"]);
    expect(await store.hasSteering("run-1")).toBe(false);

    for (const queued of drained) await store.enqueueFollowUp("thread-1", queued);
    expect((await store.drainFollowUps("thread-1")).map(({ id }) => id)).toEqual([
      "intent-1",
      "intent-2",
    ]);
    expect(await store.drainFollowUps("thread-1")).toEqual([]);
  });

  it("resolves one elicitation once and records the run grant", async () => {
    await store.createRun(record());
    await store.transitionRun({ runId: "run-1", state: "running" });
    const elicitation = {
      type: "elicitation" as const,
      elicitationId: "elicit-1",
      kind: "approval" as const,
      prompt: "Approve?",
      reference: { callId: "call-1", approvalId: "approval-1" },
      options: [{ id: "approve", label: "Approve" }],
      blocking: true,
    };
    await store.commitTurn({
      turn: turn({
        message: {
          role: "assistant",
          blocks: [{ type: "toolCall", callId: "call-1", name: "deployments", input: {} }],
        },
        stopReason: "paused",
        pendingToolCall: { callId: "call-1", elicitationId: "elicit-1" },
      }),
      state: "awaiting_approval",
      elicitation: { runId: "run-1", event: elicitation },
    });

    const resolution = {
      optionId: "approve",
      decision: "approved" as const,
      scope: "run" as const,
      by: author,
      at: clock.now(),
    };
    expect(await store.resolveElicitation("elicit-1", resolution)).toBe("resolved");
    expect(await store.resolveElicitation("elicit-1", resolution)).toBe("already-resolved");
    expect((await store.getRun("run-1"))?.runGrants).toEqual(["deployments"]);
    expect((await store.listEvents("run-1")).at(-1)?.event).toMatchObject({
      type: "elicitation-resolved",
      optionId: "approve",
    });
  });

  it("marks a parked run stale when its elicitation expires", async () => {
    await store.createRun(record());
    await store.transitionRun({ runId: "run-1", state: "running" });
    await store.commitTurn({
      turn: turn({
        stopReason: "paused",
        pendingToolCall: { callId: "call-1", elicitationId: "elicit-1" },
      }),
      state: "awaiting_input",
      elicitation: {
        runId: "run-1",
        event: {
          type: "elicitation",
          elicitationId: "elicit-1",
          kind: "choice",
          prompt: "Which one?",
          reference: { callId: "call-1" },
          options: [{ id: "a", label: "A" }],
          blocking: true,
        },
        expiresAt: "2026-07-19T13:00:00.000Z",
      },
    });

    expect(await store.expireElicitation("elicit-1", author, clock.now())).toBe("resolved");
    expect((await store.getRun("run-1"))?.state).toBe("stale");
    expect(await store.expireElicitation("elicit-1", author, clock.now())).toBe("already-resolved");
  });

  it("discards events after a cursor and reuses the freed sequence numbers", async () => {
    await store.createRun(record());
    await store.appendEvent("run-1", { type: "text-start", blockId: "text-1" });
    const cursor = await store.eventCursor("run-1");
    await store.appendEvent("run-1", { type: "text-delta", blockId: "text-1", delta: "partial" });

    await store.discardEventsAfter("run-1", cursor);

    expect((await store.listEvents("run-1")).map(({ event }) => event.type)).toEqual([
      "text-start",
    ]);
    const reappended = await store.appendEvent("run-1", { type: "text-end", blockId: "text-1" });
    expect(reappended.seq).toBe(cursor + 1);
  });

  it("returns the latest active run for a thread and ignores terminal runs", async () => {
    await store.createRun(record());
    await store.transitionRun({ runId: "run-1", state: "running" });
    await store.transitionRun({ runId: "run-1", state: "completed" });
    expect(await store.findActiveRun("thread-1")).toBeUndefined();

    await store.createRun(record({ id: "run-2" }));
    expect(await store.findActiveRun("thread-1")).toMatchObject({ id: "run-2" });
  });
});
