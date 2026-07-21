import { describe, expect, it, vi } from "vitest";
import type { MessageIntent } from "#/dispatch/index.js";
import { InputDispatcher, ThreadDispatchLock } from "#/dispatch/index.js";
import { InMemoryRunStore } from "#/memory/index.js";
import type { RunRecord, RunStore } from "#/ports/index.js";

const clock = { now: () => "2026-07-19T12:00:00.000Z" };
const author = { principalId: "principal-1", displayName: "Nelson" };
const message = { role: "user" as const, blocks: [{ type: "text" as const, text: "hello" }] };

function fixture(store: RunStore = new InMemoryRunStore(clock)) {
  let nextId = 1;
  const createRun = vi.fn(async (intent: MessageIntent): Promise<RunRecord> => {
    const run: RunRecord = {
      id: `run-${nextId++}`,
      threadRef: intent.threadRef,
      state: "queued",
      trigger: "message",
      turnCount: 0,
    };
    await store.createRun(run);
    return run;
  });
  const resolve = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const retryRun: RunRecord = {
    id: "run-retry",
    threadRef: "thread-1",
    state: "queued",
    trigger: "retry",
    turnCount: 0,
  };
  const retry = vi.fn(async (): Promise<RunRecord> => retryRun);
  const feedback = vi.fn(async () => undefined);
  const lock = new ThreadDispatchLock();
  const dispatcher = new InputDispatcher({
    store,
    lock,
    createRun,
    resolve,
    stop,
    retry,
    feedback,
  });
  return { store, lock, dispatcher, createRun, resolve, stop, retry, feedback };
}

describe("InputDispatcher", () => {
  it("serializes simultaneous replies so only one creates a run", async () => {
    const subject = fixture();
    const results = await Promise.all([
      subject.dispatcher.dispatch({
        type: "message",
        intentId: "intent-1",
        threadRef: "thread-1",
        author,
        message,
      }),
      subject.dispatcher.dispatch({
        type: "message",
        intentId: "intent-2",
        threadRef: "thread-1",
        author,
        message,
      }),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["new-run", "steer"]);
    expect(subject.createRun).toHaveBeenCalledOnce();
    expect(await subject.store.drainSteering("run-1")).toMatchObject([{ id: "intent-2" }]);
  });

  it("queues a steer on a parked run without changing its state", async () => {
    const subject = fixture();
    await subject.store.createRun({
      id: "run-parked",
      threadRef: "thread-1",
      state: "awaiting_approval",
      trigger: "message",
      turnCount: 1,
    });

    const result = await subject.dispatcher.dispatch({
      type: "message",
      intentId: "intent-1",
      threadRef: "thread-1",
      author,
      message,
    });

    expect(result).toEqual({ outcome: "steer", runId: "run-parked" });
    expect((await subject.store.getRun("run-parked"))?.state).toBe("awaiting_approval");
  });

  it("applies a duplicate intent exactly once", async () => {
    const subject = fixture();
    const intent = {
      type: "message" as const,
      intentId: "intent-1",
      threadRef: "thread-1",
      author,
      message,
    };

    expect((await subject.dispatcher.dispatch(intent)).outcome).toBe("new-run");
    expect(await subject.dispatcher.dispatch(intent)).toEqual({ outcome: "duplicate" });
    expect(subject.createRun).toHaveBeenCalledOnce();
  });

  it("checks conversational resolution before steering", async () => {
    const subject = fixture();
    await subject.store.createRun({
      id: "run-parked",
      threadRef: "thread-1",
      state: "awaiting_input",
      trigger: "message",
      turnCount: 1,
    });
    const resolve = vi.fn(async () => undefined);
    const dispatcher = new InputDispatcher({
      store: subject.store,
      lock: subject.lock,
      createRun: subject.createRun,
      resolve,
      stop: subject.stop,
      retry: async () => {
        throw new Error("not scripted");
      },
      feedback: subject.feedback,
      classifyResolution: (intent, run) => ({
        type: "resolve",
        intentId: intent.intentId,
        threadRef: intent.threadRef,
        runId: run.id,
        elicitationId: "elicit-1",
        optionId: "yes",
        decision: "answered",
        by: intent.author,
      }),
    });

    expect(
      await dispatcher.dispatch({
        type: "message",
        intentId: "intent-1",
        threadRef: "thread-1",
        author,
        message,
      }),
    ).toEqual({ outcome: "resolve", runId: "run-parked" });
    expect(resolve).toHaveBeenCalledOnce();
    expect(await subject.store.drainSteering("run-parked")).toEqual([]);
  });

  it("routes stop, retry, and feedback intents to their targets", async () => {
    const subject = fixture();

    expect(
      await subject.dispatcher.dispatch({
        type: "stop",
        intentId: "stop-1",
        threadRef: "thread-1",
        runId: "run-1",
        by: author,
      }),
    ).toEqual({ outcome: "stop", runId: "run-1" });
    expect(
      await subject.dispatcher.dispatch({
        type: "retry",
        intentId: "retry-1",
        threadRef: "thread-1",
        runId: "run-1",
        by: author,
      }),
    ).toMatchObject({ outcome: "retry", run: { id: "run-retry" } });
    expect(
      await subject.dispatcher.dispatch({
        type: "feedback",
        intentId: "feedback-1",
        threadRef: "thread-1",
        runId: "run-1",
        value: "up",
        by: author,
      }),
    ).toEqual({ outcome: "feedback", runId: "run-1" });
    expect(subject.stop).toHaveBeenCalledOnce();
    expect(subject.retry).toHaveBeenCalledOnce();
    expect(subject.feedback).toHaveBeenCalledOnce();
  });
});
