import { describe, expect, it } from "vitest";
import { InMemoryEngine } from "#harness/memory/in-memory-engine.js";
import { InMemoryRunStore } from "#harness/memory/in-memory-run-store.js";
import type { Clock, TurnRecord } from "#harness/ports/index.js";

const clock: Clock = { now: () => "2026-07-19T12:00:00.000Z" };

describe("InMemoryRunStore", () => {
  it("assigns a dense per-run sequence under concurrent appends", async () => {
    const store = new InMemoryRunStore(clock);
    await store.createRun({
      id: "run-1",
      threadRef: "thread-1",
      state: "queued",
      trigger: "message",
      turnCount: 0,
    });

    const appended = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.appendEvent("run-1", { type: "data", name: "test", data: index }),
      ),
    );

    expect(appended.map(({ seq }) => seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect((await store.listEvents("run-1")).map(({ seq }) => seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
  });

  it("keeps live events from an uncommitted turn out of replay", async () => {
    const store = new InMemoryRunStore(clock);
    await store.createRun({
      id: "run-1",
      threadRef: "thread-1",
      state: "queued",
      trigger: "message",
      turnCount: 0,
    });

    await store.appendEvent("run-1", { type: "text-delta", blockId: "text-1", delta: "partial" });

    expect(await store.listTurns("run-1")).toEqual([]);
    expect((await store.listEvents("run-1")).map(({ event }) => event)).toEqual([
      { type: "text-delta", blockId: "text-1", delta: "partial" },
    ]);

    const turn: TurnRecord = {
      runId: "run-1",
      index: 0,
      model: { id: "test/model" },
      message: { role: "assistant", blocks: [{ type: "text", text: "complete" }] },
      toolResults: [],
      stopReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    };
    await store.commitTurn({ turn });

    expect(await store.listTurns("run-1")).toEqual([turn]);
    expect(await store.listEvents("run-1")).toHaveLength(1);
  });
});

describe("InMemoryEngine", () => {
  it("runs tasks for one thread serially", async () => {
    const engine = new InMemoryEngine();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await engine.enqueue({
      runId: "run-1",
      threadRef: "thread-1",
      run: async () => {
        order.push("first:start");
        await firstCanFinish;
        order.push("first:end");
      },
    });
    await engine.enqueue({
      runId: "run-2",
      threadRef: "thread-1",
      run: async () => {
        order.push("second:start");
        order.push("second:end");
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    await engine.idle();
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows different threads to run concurrently", async () => {
    const engine = new InMemoryEngine();
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = (runId: string, threadRef: string) =>
      engine.enqueue({
        runId,
        threadRef,
        run: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (active === 2) release?.();
          await barrier;
          active -= 1;
        },
      });

    await Promise.all([task("run-1", "thread-1"), task("run-2", "thread-2")]);
    await engine.idle();
    expect(maximumActive).toBe(2);
  });

  it("does not let a failed task block its thread, and idle reports the failure", async () => {
    const engine = new InMemoryEngine();
    const order: string[] = [];

    await engine.enqueue({
      runId: "run-1",
      threadRef: "thread-1",
      run: async () => {
        order.push("first");
        throw new Error("task failed");
      },
    });
    await engine.enqueue({
      runId: "run-2",
      threadRef: "thread-1",
      run: async () => {
        order.push("second");
      },
    });

    await expect(engine.idle()).rejects.toThrow("task failed");
    expect(order).toEqual(["first", "second"]);
  });
});
