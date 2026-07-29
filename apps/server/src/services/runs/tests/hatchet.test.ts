import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RUN_EXECUTION_TIMEOUT,
  defineRunTask,
} from "#server/services/runs/hatchet.js";

describe("run task", () => {
  it("overrides Hatchet's one-minute default for long model runs", () => {
    const task = vi.fn(() => ({ runNoWait: vi.fn() }));
    const hatchet = { task } as unknown as HatchetClient;

    defineRunTask(hatchet, async () => ({ status: "finished" }));

    expect(task).toHaveBeenCalledWith(
      expect.objectContaining({ executionTimeout: DEFAULT_RUN_EXECUTION_TIMEOUT }),
    );
    expect(DEFAULT_RUN_EXECUTION_TIMEOUT).toBe("30m");
  });

  it("honors an explicit execution timeout", () => {
    const task = vi.fn(() => ({ runNoWait: vi.fn() }));
    const hatchet = { task } as unknown as HatchetClient;

    defineRunTask(hatchet, async () => ({ status: "finished" }), {
      executionTimeout: "5m",
    });

    expect(task).toHaveBeenCalledWith(expect.objectContaining({ executionTimeout: "5m" }));
  });
});
