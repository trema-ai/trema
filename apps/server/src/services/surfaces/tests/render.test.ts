import type { Projection } from "@trema/projection";
import {
  type ApplyResult,
  type CapabilityDescriptor,
  type RenderOperation,
  type RenderPlan,
  type SurfaceApplyContext,
  type SurfaceDriver,
  SurfaceDriverError,
  type SurfaceEvent,
  type SurfaceRealization,
  type SurfaceRef,
} from "@trema/surfaces";
import { describe, expect, it, vi } from "vitest";
import { renderSurface, type SurfaceRealizationStore } from "#server/services/surfaces/render.js";
import type {
  CommitRealizationInput,
  RecordRenderFailureInput,
  RecordRenderStopInput,
  StageRenderPlanInput,
} from "#server/services/surfaces/store.js";
import { SurfaceRealizationConflictError } from "#server/services/surfaces/store.js";

const ref = {
  surface: "slack",
  locationRef: "T1:C1",
  threadRef: "1800000000.000001",
} as const satisfies SurfaceRef;

const capabilities = {
  mutation: "edit",
  streaming: "delta",
  dialect: "mrkdwn",
  affordances: {
    buttons: true,
    forms: false,
    reactions: true,
    presence: true,
    threads: true,
    files: true,
  },
  budgets: { messageChars: 11_500, flushIntervalMs: 600, firstPaintMs: 3_000 },
  quirks: { blocksOnlyAtFinal: true },
} as const satisfies CapabilityDescriptor;

function projection(text: string, lastSeq = 1): Projection {
  return {
    runId: "run-1",
    status: "running",
    segments: [
      {
        index: 0,
        parts: [{ kind: "text", id: "text-1", status: "streaming", markdown: text }],
      },
    ],
    unknownEvents: 0,
    lastSeq,
  };
}

class MemoryStore implements SurfaceRealizationStore {
  current: SurfaceRealization = {
    id: "realization-1",
    orgId: "org-1",
    runId: "run-1",
    ref,
    renderedThroughSeq: 0,
    segments: [],
    presentation: {},
    reconciliationRequired: false,
    version: 0,
    retry: { attempt: 0, terminal: false },
  };
  released = 0;
  renewed = 0;
  renewalResult = true;

  async claim(): Promise<SurfaceRealization | undefined> {
    if (this.current.retry.terminal || this.current.presentation.stoppedByUser === true) {
      return undefined;
    }
    this.current = {
      ...this.current,
      lease: { owner: "worker-1", until: "2026-08-01T12:00:30.000Z" },
    };
    return this.current;
  }

  async stagePlan(input: StageRenderPlanInput): Promise<SurfaceRealization> {
    expect(input.expectedVersion).toBe(this.current.version);
    this.current = { ...this.current, pendingPlan: input.plan, version: this.current.version + 1 };
    return this.current;
  }

  async commit(input: CommitRealizationInput): Promise<SurfaceRealization> {
    expect(input.expectedVersion).toBe(this.current.version);
    const { pendingPlan: _pending, ...withoutPending } = this.current;
    this.current = {
      ...withoutPending,
      renderedThroughSeq: input.renderedThroughSeq,
      segments: input.segments,
      presentation: input.presentation ?? this.current.presentation,
      reconciliationRequired: false,
      version: this.current.version + 1,
      retry: { attempt: 0, terminal: false },
    };
    return this.current;
  }

  async recordFailure(input: RecordRenderFailureInput): Promise<SurfaceRealization> {
    expect(input.expectedVersion).toBe(this.current.version);
    const { lease: _lease, ...current } = this.current;
    this.current = {
      ...current,
      version: this.current.version + 1,
      retry: {
        attempt: this.current.retry.attempt + 1,
        terminal: input.terminal ?? false,
        lastErrorCode: input.code,
        ...(input.nextRetryAt === undefined ? {} : { nextAt: input.nextRetryAt.toISOString() }),
      },
    };
    return this.current;
  }

  async recordStopped(input: RecordRenderStopInput): Promise<SurfaceRealization> {
    expect(input.expectedVersion).toBe(this.current.version);
    const { pendingPlan: _pending, lease: _lease, ...current } = this.current;
    this.current = {
      ...current,
      presentation: { ...this.current.presentation, stoppedByUser: true },
      reconciliationRequired: false,
      version: this.current.version + 1,
      retry: { attempt: 0, terminal: false },
    };
    return this.current;
  }

  async renew(): Promise<boolean> {
    this.renewed += 1;
    return this.renewalResult;
  }

  async release(_id: string, owner: string): Promise<boolean> {
    if (this.current.lease?.owner !== owner) return false;
    this.released += 1;
    const { lease: _lease, ...current } = this.current;
    this.current = current;
    return true;
  }
}

function fakeDriver(
  apply: (operations: RenderOperation[], context: SurfaceApplyContext) => Promise<ApplyResult>,
): SurfaceDriver {
  return {
    capabilities,
    apply,
    async presence() {},
    normalize(_event: unknown, _ref: SurfaceRef): SurfaceEvent | null {
      return null;
    },
  };
}

function createdResult(operations: RenderOperation[]): ApplyResult {
  return {
    appliedOperationIds: operations.map(({ id }) => id),
    messages: operations.map((operation) => ({
      messageId: operation.messageId,
      ...(operation.type === "create"
        ? { remoteRef: "1800000001.000001", metadata: { mode: "stream" } }
        : {}),
    })),
  };
}

const baseInput = {
  ref,
  owner: "worker-1",
  canonicalRunUrl: "https://trema.test/runs/run-1",
  requestRunStop: async () => "recorded" as const,
} as const;

describe("renderSurface", () => {
  it("stages, applies, and persists one Slack realization without replay duplicates", async () => {
    const store = new MemoryStore();
    const apply = vi.fn(async (operations: RenderOperation[]) => createdResult(operations));
    const driver = fakeDriver(apply);

    const first = await renderSurface({
      ...baseInput,
      store,
      driver,
      projection: projection("Hello"),
    });
    const replay = await renderSurface({
      ...baseInput,
      store,
      driver,
      projection: projection("Hello"),
    });

    expect(first).toMatchObject({ status: "rendered", operations: 1 });
    expect(replay).toMatchObject({ status: "noop" });
    if (first.status !== "rendered" || replay.status !== "noop") {
      throw new Error("unexpected render result");
    }
    expect(first.realization).not.toHaveProperty("lease");
    expect(replay.realization).not.toHaveProperty("lease");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.current).toMatchObject({
      renderedThroughSeq: 1,
      presentation: { dialect: "mrkdwn" },
      segments: [
        {
          messages: [
            {
              remoteRef: "1800000001.000001",
              metadata: { mode: "stream" },
            },
          ],
        },
      ],
    });
    expect(store.current).not.toHaveProperty("pendingPlan");
  });

  it("returns a released realization when only the durable cursor advances", async () => {
    const store = new MemoryStore();
    const result = await renderSurface({
      ...baseInput,
      store,
      driver: fakeDriver(async (operations) => createdResult(operations)),
      projection: {
        runId: "run-1",
        status: "running",
        segments: [],
        unknownEvents: 1,
        lastSeq: 1,
      },
    });

    expect(result).toMatchObject({ status: "rendered", operations: 0 });
    if (result.status !== "rendered") throw new Error(`unexpected result: ${result.status}`);
    expect(result.realization).not.toHaveProperty("lease");
    expect(store.current).not.toHaveProperty("lease");
  });

  it("renews its lease while a remote batch runs longer than the original TTL", async () => {
    const store = new MemoryStore();
    const result = await renderSurface({
      ...baseInput,
      store,
      driver: fakeDriver(async (operations) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return createdResult(operations);
      }),
      projection: projection("Hello"),
      leaseTtlMs: 15,
    });

    expect(result).toMatchObject({ status: "rendered", operations: 1 });
    expect(store.renewed).toBeGreaterThanOrEqual(2);
  });

  it("preserves the staged plan when lease renewal loses ownership", async () => {
    const store = new MemoryStore();
    store.renewalResult = false;

    await expect(
      renderSurface({
        ...baseInput,
        store,
        driver: fakeDriver(async (operations) => createdResult(operations)),
        projection: projection("Hello"),
      }),
    ).rejects.toBeInstanceOf(SurfaceRealizationConflictError);
    expect(store.current).toMatchObject({
      renderedThroughSeq: 0,
      pendingPlan: expect.objectContaining({ fromCursor: 0, toCursor: 1 }),
    });
  });

  it("replays the exact staged operation after worker restart and commits the adopted ref", async () => {
    const store = new MemoryStore();
    const firstPlan: RenderPlan = {
      fromCursor: 0,
      toCursor: 1,
      operations: [
        {
          id: "stable-create-operation",
          type: "create",
          messageId: "run-1:segment:0:message:0",
          segmentId: "run-1:segment:0",
          segmentIndex: 0,
          messageIndex: 0,
          content: {
            text: "Recovered",
            parts: [
              {
                kind: "text",
                id: "text-1",
                status: "streaming",
                markdown: "Recovered",
              },
            ],
          },
          finalized: false,
        },
      ],
      nextSegments: [
        {
          id: "run-1:segment:0",
          index: 0,
          messages: [
            {
              id: "run-1:segment:0:message:0",
              index: 0,
              text: "Recovered",
              contentHash: "hash",
              finalized: false,
            },
          ],
        },
      ],
    };
    store.current = { ...store.current, pendingPlan: firstPlan, version: 2 };
    const apply = vi.fn(async (operations: RenderOperation[]) => createdResult(operations));

    const result = await renderSurface({
      ...baseInput,
      store,
      driver: fakeDriver(apply),
      projection: projection("Recovered"),
    });

    expect(result).toMatchObject({ status: "rendered", operations: 1 });
    expect(apply.mock.calls[0]?.[0][0]?.id).toBe("stable-create-operation");
    expect(store.current.segments[0]?.messages[0]?.remoteRef).toBe("1800000001.000001");
  });

  it("preserves the staged plan and cursor while honoring Slack retry-after", async () => {
    const store = new MemoryStore();
    const error = new SurfaceDriverError("rate_limited", "slow down", {
      retryable: true,
      retryAfterMs: 7_000,
    });
    const now = new Date("2026-08-01T12:00:00.000Z");

    const result = await renderSurface({
      ...baseInput,
      store,
      driver: fakeDriver(async () => {
        throw error;
      }),
      projection: projection("Hello"),
      clock: { now: () => now },
    });

    expect(result).toMatchObject({
      status: "retry_scheduled",
      realization: {
        renderedThroughSeq: 0,
        pendingPlan: expect.objectContaining({ fromCursor: 0, toCursor: 1 }),
        retry: {
          attempt: 1,
          terminal: false,
          lastErrorCode: "rate_limited",
          nextAt: "2026-08-01T12:00:07.000Z",
        },
      },
    });
  });

  it("marks a revoked Slack installation terminal without advancing the cursor", async () => {
    const store = new MemoryStore();
    const result = await renderSurface({
      ...baseInput,
      store,
      driver: fakeDriver(async () => {
        throw new SurfaceDriverError("revoked", "installation revoked", { retryable: false });
      }),
      projection: projection("Hello"),
    });

    expect(result).toMatchObject({
      status: "terminal_failure",
      realization: {
        renderedThroughSeq: 0,
        retry: { terminal: true, lastErrorCode: "revoked" },
      },
    });
  });

  it("turns Slack's native stop into one durable run-stop request", async () => {
    const store = new MemoryStore();
    const requestRunStop = vi.fn(async () => "recorded" as const);

    const result = await renderSurface({
      ...baseInput,
      store,
      requestRunStop,
      driver: fakeDriver(async () => {
        throw new SurfaceDriverError("stopped_by_user", "stopped", { retryable: false });
      }),
      projection: projection("Hello"),
    });

    expect(result).toMatchObject({
      status: "stopped",
      realization: {
        renderedThroughSeq: 0,
        presentation: { stoppedByUser: true },
        retry: { attempt: 0, terminal: false },
      },
    });
    if (result.status !== "stopped") throw new Error(`unexpected result: ${result.status}`);
    expect(result.realization).not.toHaveProperty("pendingPlan");
    expect(requestRunStop).toHaveBeenCalledOnce();
    expect(requestRunStop).toHaveBeenCalledWith({
      intentId: "surface:realization-1:stopped-by-user",
      runId: "run-1",
      ref,
    });
  });

  it("accepts a native stop that loses the race to run completion", async () => {
    const store = new MemoryStore();
    const requestRunStop = vi.fn(async () => "already_terminal" as const);

    const result = await renderSurface({
      ...baseInput,
      store,
      requestRunStop,
      driver: fakeDriver(async () => {
        throw new SurfaceDriverError("stopped_by_user", "stopped", { retryable: false });
      }),
      projection: projection("Hello"),
    });

    expect(result.status).toBe("stopped");
    expect(requestRunStop).toHaveBeenCalledOnce();
  });

  it("retries the staged Slack stop until its durable intent is recorded", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-08-01T12:00:00.000Z");

    const result = await renderSurface({
      ...baseInput,
      store,
      requestRunStop: async () => {
        throw new Error("database unavailable");
      },
      driver: fakeDriver(async () => {
        throw new SurfaceDriverError("stopped_by_user", "stopped", { retryable: false });
      }),
      projection: projection("Hello"),
      clock: { now: () => now },
    });

    expect(result).toMatchObject({
      status: "retry_scheduled",
      error: { code: "unavailable", retryable: true },
      realization: {
        renderedThroughSeq: 0,
        pendingPlan: expect.objectContaining({ fromCursor: 0, toCursor: 1 }),
        retry: {
          attempt: 1,
          terminal: false,
          lastErrorCode: "unavailable",
        },
      },
    });
  });
});
