import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IngressWorkTracker,
  SlackIngressService,
} from "#server/services/messaging/ingress/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("IngressWorkTracker", () => {
  it("drains every task that was accepted before shutdown", async () => {
    const tracker = new IngressWorkTracker();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    tracker.defer(pending);

    const draining = tracker.drain(1_000);
    expect(tracker.size).toBe(1);
    release();

    await expect(draining).resolves.toBe(true);
    expect(tracker.size).toBe(0);
  });

  it("reports a bounded drain timeout without discarding the task", async () => {
    const tracker = new IngressWorkTracker();
    let release!: () => void;
    tracker.defer(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    await expect(tracker.drain(0)).resolves.toBe(false);
    expect(tracker.size).toBe(1);
    release();
    await expect(tracker.drain(1_000)).resolves.toBe(true);
  });
});

describe("SlackIngressService", () => {
  it("cancels a scheduled retry when an earlier recovery succeeds", async () => {
    vi.useFakeTimers();
    const defer = vi.fn();
    const findMany = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient inbox query failure"))
      .mockResolvedValue([]);
    const service = new SlackIngressService({
      db: {
        slackIngressDelivery: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
          findMany,
        },
      } as never,
      defer,
      env: {} as never,
    });

    await expect(service.recoverPending()).rejects.toThrow("transient inbox query failure");
    await expect(service.recoverPending()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(defer).not.toHaveBeenCalled();
  });
});
