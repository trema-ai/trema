import { describe, expect, it } from "vitest";

import { IngressWorkTracker } from "#server/services/messaging/ingress/index.js";

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
