import { randomUUID } from "node:crypto";

import type { ModelPort, RunEventData, RunState, TranscriptMessage, Usage } from "@trema/harness";
import { runLoop } from "@trema/harness";
import { FauxModelPort } from "@trema/harness/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "#server/lib/db/index.js";
import { readThreadMessages } from "#server/services/runs/history.js";
import { createSessionRunPlan } from "#server/services/runs/plan.js";
import { PrismaRunStore } from "#server/services/runs/store.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const author = { principalId: "principal-1", displayName: "Nelson" };
const usage: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0001,
};
const modelPort: ModelPort = {
  streamTurn: () => {
    throw new Error("the plan under test never streams a turn");
  },
  complete: () => {
    throw new Error("the plan under test never completes");
  },
};

function user(text: string): TranscriptMessage {
  return { role: "user", blocks: [{ type: "text", text }] };
}

function assistant(text: string): TranscriptMessage {
  return { role: "assistant", blocks: [{ type: "text", text }] };
}

integration("thread history", () => {
  const db = createPrismaClient(databaseUrl);
  let orgId = "";
  let sessionId = "";
  let store: PrismaRunStore;

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org" CASCADE`;
    const org = await db.org.create({ data: { name: "Thread history org" } });
    orgId = org.id;
    const scope = await db.scope.create({ data: { orgId, kind: "org", name: "Org" } });
    const principal = await db.principal.create({
      data: { orgId, kind: "agent", displayName: "Agent" },
    });
    const session = await db.contextSession.create({
      data: {
        orgId,
        scopeId: scope.id,
        surface: "web",
        locationRef: "member-1",
        mode: "service",
        actingPrincipalId: principal.id,
        standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
        policySnapshot: {},
        snapshotHash: "snapshot-1",
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    sessionId = session.id;
    store = new PrismaRunStore({ db, orgId });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  /** A run with the log a completed message run leaves behind. */
  async function recordRun(options: {
    id: string;
    opening: string;
    answer?: string;
    /** Records an error after the text and finishes the run failed. */
    error?: string;
    state?: RunState;
    threadRef?: string;
  }): Promise<void> {
    const threadRef = options.threadRef ?? "web:member-1";
    await store.createRun({
      id: options.id,
      threadRef,
      state: "queued",
      trigger: "message",
      turnCount: 0,
      sessionId,
    });
    await store.transitionRun({
      runId: options.id,
      state: "running",
      event: { type: "run-started", trigger: "message" },
    });
    const events: RunEventData[] = [{ type: "steering", author, text: options.opening }];
    if (options.answer !== undefined) {
      events.push(
        { type: "text-start", blockId: `${options.id}-text` },
        { type: "text-delta", blockId: `${options.id}-text`, delta: options.answer },
        { type: "text-end", blockId: `${options.id}-text` },
      );
    }
    if (options.error !== undefined) {
      events.push({ type: "error", message: options.error, recoverable: true });
    }
    for (const event of events) await store.appendEvent(options.id, event);
    const state = options.state ?? (options.error === undefined ? "completed" : "failed");
    if (state === "running") return;
    await store.transitionRun({
      runId: options.id,
      state,
      event: {
        type: "run-finished",
        outcome: state === "completed" ? "completed" : "failed",
        usage,
        ...(options.error === undefined ? {} : { errorMessage: options.error }),
      },
      usage,
    });
  }

  async function queueRun(id: string, threadRef = "web:member-1") {
    const run = {
      id,
      threadRef,
      state: "queued" as const,
      trigger: "message" as const,
      turnCount: 0,
      sessionId,
    };
    await store.createRun(run);
    return run;
  }

  it("gives a second run on the thread the first run's exchange", async () => {
    await recordRun({ id: "run-1", opening: "What broke the deploy?", answer: "A timeout." });
    const second = await queueRun("run-2");

    const plan = await createSessionRunPlan({
      db,
      orgId,
      resolveModel: async () => ({ model: { id: "test/model" }, modelPort }),
    })(second);

    expect(plan.threadMessages).toEqual([user("What broke the deploy?"), assistant("A timeout.")]);
  });

  it("keeps the newest runs within the cap, in run order", async () => {
    await recordRun({ id: "run-1", opening: "First.", answer: "One." });
    await recordRun({ id: "run-2", opening: "Second.", answer: "Two." });
    await recordRun({ id: "run-3", opening: "Third.", answer: "Three." });
    const fourth = await queueRun("run-4");

    const plan = await createSessionRunPlan({
      db,
      orgId,
      resolveModel: async () => ({ model: { id: "test/model" }, modelPort }),
      threadHistoryRuns: 2,
    })(fourth);

    expect(plan.threadMessages).toEqual([
      user("Second."),
      assistant("Two."),
      user("Third."),
      assistant("Three."),
    ]);
  });

  it("reads only prior terminal runs of the same thread", async () => {
    await recordRun({ id: "run-1", opening: "Same thread.", answer: "Answered." });
    await recordRun({ id: "run-2", opening: "Other thread.", threadRef: "web:member-2" });
    await recordRun({ id: "run-3", opening: "Still running.", state: "running" });
    await recordRun({ id: "run-4", opening: "The run being planned.", state: "running" });

    const messages = await readThreadMessages({
      db,
      orgId,
      threadRef: "web:member-1",
      runId: "run-4",
    });

    expect(messages).toEqual([user("Same thread."), assistant("Answered.")]);
  });

  it("replays a resumed run's own opening message after the thread's record", async () => {
    await recordRun({ id: "run-1", opening: "What broke the deploy?", answer: "A timeout." });
    const second = await queueRun("run-2");
    await store.enqueueSteering("run-2", {
      id: "intent-1",
      author,
      message: user("Retry the deploy."),
    });
    await store.transitionRun({
      runId: "run-2",
      state: "running",
      event: { type: "run-started", trigger: "message" },
    });
    const scripted = new FauxModelPort([
      {
        events: [
          {
            type: "elicitation",
            elicitationId: "elicit-1",
            kind: "approval",
            prompt: "Redeploy?",
            options: [{ id: "approve", label: "Approve" }],
            blocking: true,
          },
        ],
        result: {
          message: assistant("May I redeploy?"),
          toolCalls: [],
          stopReason: "paused",
          usage,
        },
      },
      {
        events: [],
        result: { message: assistant("It is green."), toolCalls: [], stopReason: "stop", usage },
      },
    ]);
    const plan = createSessionRunPlan({
      db,
      orgId,
      resolveModel: async () => ({ model: { id: "test/model" }, modelPort: scripted }),
    });
    // Each execution plans afresh and reads the log: nothing is carried over.
    const execute = async () => {
      const run = await store.getRun(second.id);
      if (run === undefined) throw new Error("the run under test disappeared");
      const planned = await plan(run);
      return runLoop({
        runId: run.id,
        threadRef: run.threadRef,
        model: planned.model,
        standing: planned.standing,
        threadMessages: planned.threadMessages,
        tools: [],
        modelPort: planned.modelPort,
        store,
        toolExecutor: {
          execute: () => {
            throw new Error("the run under test calls no tools");
          },
        },
        abort: new AbortController().signal,
      });
    };

    expect(await execute()).toMatchObject({ status: "paused" });
    expect(await execute()).toMatchObject({ status: "finished", outcome: "completed" });

    expect(scripted.turnRequests[1]?.messages).toEqual([
      user("What broke the deploy?"),
      assistant("A timeout."),
      user("Retry the deploy."),
      assistant("May I redeploy?"),
    ]);
  });

  it("carries a failed run's message and not its half-written answer", async () => {
    // A retry is a new run with nothing queued on it, so the message has to
    // survive the failure — the narration the error interrupted must not.
    await recordRun({ id: "run-1", opening: "Retry me.", answer: "Let me look.", error: "boom" });

    const messages = await readThreadMessages({
      db,
      orgId,
      threadRef: "web:member-1",
      runId: "run-2",
    });

    expect(messages).toEqual([user("Retry me.")]);
  });
});
