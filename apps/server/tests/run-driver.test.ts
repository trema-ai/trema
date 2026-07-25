import type { RunRecord, ToolDef } from "@trema/harness";
import { InMemoryEngine, InMemoryRunStore, RunLifecycle, ThreadDispatchLock } from "@trema/harness";
import { FakeContextSession, FauxModelPort } from "@trema/harness/testing";
import { describe, expect, it, vi } from "vitest";
import { drainWorker, InFlightRuns } from "#/services/runs/drain.js";
import { createRunDriver, type RunExecutionPlan } from "#/services/runs/driver.js";
import { concurrencyKey, HatchetEngine } from "#/services/runs/hatchet.js";
import { narrowTools } from "#/services/runs/plan.js";

const now = "2026-07-19T12:00:00.000Z";
const usage = {
  inputTokens: 2,
  outputTokens: 2,
  totalTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

function snapshot() {
  return {
    sessionId: "session-1",
    mode: "service" as const,
    scopeChain: [],
    standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
    tools: [],
    policySnapshot: {},
    snapshotHash: "snapshot-1",
  };
}

function fixture(turns = 1) {
  const store = new InMemoryRunStore({ now: () => now });
  const engine = new InMemoryEngine();
  const context = new FakeContextSession(snapshot());
  const lifecycle = new RunLifecycle({
    store,
    engine,
    context,
    lock: new ThreadDispatchLock(),
    createId: () => "run-1",
    now: () => now,
  });
  const modelPort = new FauxModelPort(
    Array.from({ length: turns }, (_, index) => ({
      events: [
        { type: "text-start" as const, blockId: `text-${index}` },
        { type: "text-delta" as const, blockId: `text-${index}`, delta: "done" },
        { type: "text-end" as const, blockId: `text-${index}` },
      ],
      result: {
        message: { role: "assistant" as const, blocks: [{ type: "text" as const, text: "done" }] },
        toolCalls: [],
        stopReason: "stop" as const,
        usage,
      },
    })),
  );
  const plan = vi.fn(
    async (): Promise<RunExecutionPlan> => ({
      model: { id: "test/model" },
      standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
      tools: [],
      threadMessages: [],
    }),
  );
  const driver = createRunDriver({
    store,
    lifecycle,
    modelPort,
    toolExecutor: {
      execute: async (call) => ({
        callId: call.callId,
        status: "error",
        summary: "unavailable",
        output: "unavailable",
      }),
    },
    plan,
  });
  return { store, engine, context, lifecycle, driver, plan };
}

async function queueRun(subject: ReturnType<typeof fixture>): Promise<RunRecord> {
  const run = await subject.lifecycle.create({
    threadRef: "thread-1",
    trigger: "api",
    sessionId: "session-1",
  });
  await subject.store.enqueueSteering(run.id, {
    id: "intent-1",
    author: { principalId: "principal-1" },
    message: { role: "user", blocks: [{ type: "text", text: "Do the thing." }] },
  });
  return run;
}

describe("run driver", () => {
  it("loads the run from the store and finishes it", async () => {
    const subject = fixture();
    const run = await queueRun(subject);

    const result = await subject.driver.execute(run.id);

    expect(result).toMatchObject({ status: "finished" });
    expect((await subject.store.getRun(run.id))?.state).toBe("completed");
    expect((await subject.store.listEvents(run.id)).map(({ event }) => event.type)).toEqual([
      "run-started",
      "steering",
      "text-start",
      "text-delta",
      "text-end",
      "run-finished",
    ]);
    expect(subject.plan).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }));
  });

  it("does nothing for a run the store does not have", async () => {
    const subject = fixture();
    expect(await subject.driver.execute("missing-run")).toEqual({ status: "unknown" });
  });

  it("does nothing for a run that already reached a terminal state", async () => {
    const subject = fixture();
    const run = await queueRun(subject);
    await subject.driver.execute(run.id);

    expect(await subject.driver.execute(run.id)).toEqual({
      status: "skipped",
      state: "completed",
    });
  });

  it("re-enters a run its worker died on without a second row", async () => {
    const subject = fixture(2);
    const run = await queueRun(subject);
    await subject.lifecycle.start(run.id);

    const result = await subject.driver.execute(run.id);

    expect(result).toMatchObject({ status: "finished" });
    const events = (await subject.store.listEvents(run.id)).map(({ event }) => event.type);
    expect(events.filter((type) => type === "run-started")).toHaveLength(2);
    expect(await subject.store.findActiveRun("thread-1")).toBeUndefined();
  });

  it("records a run that cannot start as a failed run", async () => {
    const subject = fixture();
    const run = await queueRun(subject);
    subject.plan.mockRejectedValueOnce(new Error("context session is closed: session-1"));

    const result = await subject.driver.execute(run.id);

    expect(result).toEqual({
      status: "start-failed",
      error: "context session is closed: session-1",
    });
    expect(await subject.store.getRun(run.id)).toMatchObject({
      state: "failed",
      error: "context session is closed: session-1",
    });
    expect((await subject.store.listEvents(run.id)).map(({ event }) => event.type)).toEqual([
      "run-started",
      "error",
      "run-finished",
    ]);
  });

  it("resumes a parked run with the resume trigger", async () => {
    const subject = fixture();
    const run = await queueRun(subject);
    await subject.lifecycle.start(run.id);
    await subject.store.commitTurn({
      turn: {
        runId: run.id,
        index: 0,
        model: { id: "test/model" },
        message: { role: "assistant", blocks: [{ type: "text", text: "waiting" }] },
        toolResults: [],
        stopReason: "paused",
        usage,
      },
      state: "awaiting_input",
    });

    const result = await subject.driver.execute(run.id);

    expect(result).toMatchObject({ status: "finished" });
    const started = (await subject.store.listEvents(run.id))
      .map(({ event }) => event)
      .filter((event) => event.type === "run-started");
    expect(started.at(-1)).toMatchObject({ trigger: "resume" });
  });
});

describe("Hatchet engine", () => {
  it("carries only the run id and a thread-scoped concurrency key", async () => {
    const runNoWait = vi.fn(async () => undefined);
    const engine = new HatchetEngine({ trigger: { runNoWait }, orgId: "org-1" });

    await engine.enqueue({
      runId: "run-1",
      threadRef: "thread-1",
      run: async () => {
        throw new Error("the engine must not run the closure");
      },
    });

    expect(runNoWait).toHaveBeenCalledWith({
      runId: "run-1",
      concurrencyKey: concurrencyKey("org-1", "thread-1"),
    });
  });

  it("keys concurrency per organization so tenants never share a thread", () => {
    expect(concurrencyKey("org-1", "thread-1")).not.toBe(concurrencyKey("org-2", "thread-1"));
  });
});

describe("worker drain", () => {
  it("reports a clean drain when the current turns finish in time", async () => {
    const inFlight = new InFlightRuns();
    const result = await drainWorker({
      stop: async () => undefined,
      inFlight,
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ outcome: "drained", abandoned: [] });
  });

  it("abandons the turns still running when the grace period ends", async () => {
    const inFlight = new InFlightRuns();
    let release: (() => void) | undefined;
    const started = inFlight.track("run-1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const result = await drainWorker({
      stop: () => started,
      inFlight,
      timeoutMs: 5,
    });

    expect(result).toEqual({ outcome: "abandoned", abandoned: ["run-1"] });
    release?.();
    await started;
    expect(inFlight.size).toBe(0);
  });

  it("reports runs still tracked when the stop resolves without them", async () => {
    const inFlight = new InFlightRuns();
    let release: (() => void) | undefined;
    const started = inFlight.track("run-1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const result = await drainWorker({
      // A stop that resolves early did not actually wait for the executions.
      stop: async () => undefined,
      inFlight,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ outcome: "abandoned", abandoned: ["run-1"] });
    release?.();
    await started;
  });

  it("reports a failed stop with the runs still in flight", async () => {
    const inFlight = new InFlightRuns();
    let release: (() => void) | undefined;
    const started = inFlight.track("run-1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const result = await drainWorker({
      stop: async () => {
        throw new Error("engine unreachable");
      },
      inFlight,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ outcome: "stop-failed", abandoned: ["run-1"] });
    release?.();
    await started;
  });

  it("keeps a run in flight until its last overlapping execution settles", async () => {
    const inFlight = new InFlightRuns();
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const first = inFlight.track("run-1", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const second = inFlight.track("run-1", async () => {
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    });

    releaseFirst?.();
    await first;
    expect(inFlight.list()).toEqual(["run-1"]);

    releaseSecond?.();
    await second;
    expect(inFlight.size).toBe(0);
  });
});

describe("tool allowlist", () => {
  const tools: ToolDef[] = [
    { name: "read_calendar", title: "Calendar", description: "", schema: {}, kind: "connector" },
    { name: "send_email", title: "Email", description: "", schema: {}, kind: "connector" },
  ];

  it("passes every resolved tool through when the allowlist is empty", () => {
    expect(narrowTools(tools, [])).toEqual(tools);
  });

  it("keeps only the intersection", () => {
    expect(narrowTools(tools, ["read_calendar"]).map(({ name }) => name)).toEqual([
      "read_calendar",
    ]);
  });

  it("never widens beyond what the session resolved", () => {
    expect(narrowTools(tools, ["delete_everything"])).toEqual([]);
    expect(narrowTools([], ["read_calendar"])).toEqual([]);
  });
});
