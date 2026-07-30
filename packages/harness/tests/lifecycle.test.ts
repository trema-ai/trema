import { describe, expect, it, vi } from "vitest";
import { ThreadDispatchLock } from "#harness/dispatch/index.js";
import type { LoopResult } from "#harness/loop/index.js";
import { InMemoryEngine, InMemoryRunStore } from "#harness/memory/index.js";
import { InfrastructureAbortError, RunLifecycle } from "#harness/run/index.js";
import { FakeContextSession } from "#harness/testing/index.js";

const usage = {
  inputTokens: 2,
  outputTokens: 3,
  totalTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
};
const author = { principalId: "principal-1", displayName: "Nelson" };

function fixture() {
  let id = 0;
  const store = new InMemoryRunStore({ now: () => "2026-07-19T12:00:00.000Z" });
  const engine = new InMemoryEngine();
  const context = new FakeContextSession({
    sessionId: "session-1",
    scopeChain: [],
    standing: { instructions: "", rules: [], skillIndex: [] },
    tools: [],
    policySnapshot: {},
    snapshotHash: "snapshot-1",
  });
  const sleep = vi.fn(async () => undefined);
  const lifecycle = new RunLifecycle({
    store,
    engine,
    context,
    lock: new ThreadDispatchLock(),
    createId: () => `run-${++id}`,
    now: () => "2026-07-19T12:00:00.000Z",
    sleep,
    maxAutoRetries: 2,
  });
  return { store, engine, context, lifecycle, sleep };
}

describe("RunLifecycle", () => {
  it("commits lifecycle states and events and reports the session", async () => {
    const subject = fixture();
    const run = await subject.lifecycle.create({
      threadRef: "thread-1",
      trigger: "message",
      sessionId: "session-1",
    });
    await subject.lifecycle.start(run.id);
    await subject.lifecycle.finish({
      runId: run.id,
      outcome: "completed",
      usage,
      messages: [{ role: "assistant", blocks: [{ type: "text", text: "done" }] }],
    });

    expect(await subject.store.getRun(run.id)).toMatchObject({ state: "completed", usage });
    expect((await subject.store.listEvents(run.id)).map(({ event }) => event)).toEqual([
      { type: "run-started", trigger: "message" },
      { type: "run-finished", outcome: "completed", usage },
    ]);
    expect(subject.context.calls.map(({ method }) => method)).toEqual(["reportMessages", "close"]);
  });

  it("records a second start for a run its worker died on, without a state change", async () => {
    const subject = fixture();
    const run = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });
    await subject.lifecycle.start(run.id);

    await subject.lifecycle.start(run.id, "resume");

    expect(await subject.store.getRun(run.id)).toMatchObject({ state: "running" });
    expect((await subject.store.listEvents(run.id)).map(({ event }) => event)).toEqual([
      { type: "run-started", trigger: "message" },
      { type: "run-started", trigger: "resume" },
    ]);
  });

  it("promotes a reply arriving after the loop boundary to a follow-up", async () => {
    const subject = fixture();
    const run = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });
    await subject.lifecycle.start(run.id);
    await subject.store.enqueueSteering(run.id, {
      id: "intent-late",
      author,
      message: { role: "user", blocks: [{ type: "text", text: "one more thing" }] },
    });

    await subject.lifecycle.finish({ runId: run.id, outcome: "completed", usage });

    expect(await subject.store.drainSteering(run.id)).toEqual([]);
    expect(await subject.store.drainFollowUps("thread-1")).toMatchObject([{ id: "intent-late" }]);
  });

  it("treats abort as cancellation only when a stop fact exists", async () => {
    const subject = fixture();
    const stopped = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });
    const cancelled: LoopResult = {
      status: "finished",
      outcome: "cancelled",
      stopReason: "aborted",
      turns: 0,
      usage,
    };
    const execution = subject.lifecycle.execute(stopped.id, async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve());
      });
      return cancelled;
    });
    await Promise.resolve();
    await subject.lifecycle.stop("stop-1", stopped.id, author);
    await expect(execution).resolves.toEqual(cancelled);
    expect((await subject.store.getRun(stopped.id))?.state).toBe("cancelled");

    const dead = await subject.lifecycle.create({ threadRef: "thread-2", trigger: "message" });
    await expect(subject.lifecycle.execute(dead.id, async () => cancelled)).rejects.toBeInstanceOf(
      InfrastructureAbortError,
    );
    expect((await subject.store.getRun(dead.id))?.state).toBe("running");
  });

  it("creates bounded retries that reference the failed run and honor retry-after", async () => {
    const subject = fixture();
    const failed = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });
    await subject.lifecycle.start(failed.id);
    await subject.lifecycle.finish({
      runId: failed.id,
      outcome: "failed",
      usage,
      errorMessage: "overloaded",
    });

    const retry = await subject.lifecycle.retry({
      runId: failed.id,
      automatic: true,
      retryAfterMs: 2500,
    });

    expect(subject.sleep).toHaveBeenCalledWith(2500);
    expect(retry).toMatchObject({
      state: "queued",
      trigger: "retry",
      retryOfRunId: failed.id,
      retryAttempt: 1,
    });
    expect((await subject.store.listEvents(failed.id)).at(-1)?.event).toEqual({
      type: "data",
      name: "run-retry",
      data: { automatic: true, attempt: 1, retryAfterMs: 2500 },
    });
  });

  it("automatically retries retryable model errors and honors retry-after", async () => {
    const subject = fixture();
    const run = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });
    const loop = vi
      .fn<(abort: AbortSignal, runId: string) => Promise<LoopResult>>()
      .mockResolvedValueOnce({
        status: "finished",
        outcome: "failed",
        stopReason: "error",
        turns: 1,
        usage,
        error: { message: "rate limited", retryable: true, retryAfterMs: 1200 },
      })
      .mockResolvedValueOnce({
        status: "finished",
        outcome: "completed",
        stopReason: "stop",
        turns: 1,
        usage,
      });

    await subject.lifecycle.execute(run.id, loop);
    await subject.engine.idle();

    expect(subject.sleep).toHaveBeenCalledWith(1200);
    expect(await subject.store.getRun("run-1")).toMatchObject({
      state: "failed",
      error: "rate limited",
    });
    expect(await subject.store.getRun("run-2")).toMatchObject({
      state: "completed",
      trigger: "retry",
      retryOfRunId: "run-1",
      retryAttempt: 1,
    });
    expect(loop.mock.calls.map(([, runId]) => runId)).toEqual(["run-1", "run-2"]);
  });

  it("does not automatically retry non-retryable model errors", async () => {
    const subject = fixture();
    const run = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });

    await subject.lifecycle.execute(run.id, async () => ({
      status: "finished",
      outcome: "failed",
      stopReason: "error",
      turns: 1,
      usage,
      error: { message: "invalid request", retryable: false },
    }));

    expect(await subject.store.getRun("run-1")).toMatchObject({ state: "failed" });
    expect(await subject.store.getRun("run-2")).toBeUndefined();
  });

  it("bounds successive automatic retries", async () => {
    const subject = fixture();
    const run = await subject.lifecycle.create({ threadRef: "thread-1", trigger: "message" });
    const loop = vi.fn(
      async (): Promise<LoopResult> => ({
        status: "finished",
        outcome: "failed",
        stopReason: "error",
        turns: 1,
        usage,
        error: { message: "overloaded", retryable: true },
      }),
    );

    await subject.lifecycle.execute(run.id, loop);
    await subject.engine.idle();

    expect(loop).toHaveBeenCalledTimes(3);
    expect(await subject.store.getRun("run-3")).toMatchObject({
      state: "failed",
      retryOfRunId: "run-2",
      retryAttempt: 2,
    });
    expect(await subject.store.getRun("run-4")).toBeUndefined();
  });
});
