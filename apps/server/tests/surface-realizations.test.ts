import type { RealizedSegment, RenderPlan, SurfaceRef } from "@trema/surfaces";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "#server/lib/db/index.js";
import {
  PrismaSurfaceRealizationStore,
  SurfaceRealizationConflictError,
} from "#server/services/surfaces/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("surface realizations", () => {
  const db = createPrismaClient(databaseUrl);
  const ref: SurfaceRef = {
    surface: "slack",
    locationRef: "channel-1",
    threadRef: "thread-1",
  };
  let now = new Date("2026-07-31T12:00:00.000Z");
  let orgId = "";
  let store: PrismaSurfaceRealizationStore;

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org" CASCADE`;
    const org = await db.org.create({ data: { name: "Renderer org" } });
    orgId = org.id;
    await db.agentRun.create({
      data: {
        id: "run-1",
        orgId,
        threadRef: "conversation-1",
        state: "running",
        trigger: "message",
        lastEventSeq: 4,
      },
    });
    now = new Date("2026-07-31T12:00:00.000Z");
    store = new PrismaSurfaceRealizationStore({ db, orgId, clock: { now: () => now } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("allows only one concurrent worker to claim a run and surface", async () => {
    const claims = await Promise.all([
      store.claim("run-1", ref, "worker-a", 30_000),
      store.claim("run-1", ref, "worker-b", 30_000),
    ]);

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(await db.surfaceRealization.count()).toBe(1);
  });

  it("lets a replacement worker claim an expired lease", async () => {
    const first = await store.claim("run-1", ref, "worker-a", 30_000);
    expect(first?.lease?.owner).toBe("worker-a");
    expect(await store.claim("run-1", ref, "worker-b", 30_000)).toBeUndefined();

    now = new Date("2026-07-31T12:00:31.000Z");
    const replacement = await store.claim("run-1", ref, "worker-b", 30_000);
    expect(replacement?.id).toBe(first?.id);
    expect(replacement?.lease?.owner).toBe("worker-b");
    expect(await store.renew(first!.id, "worker-a", 30_000)).toBe(false);
  });

  it("persists the cursor, stable message refs, metadata, and version for restart", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const segments: RealizedSegment[] = [
      {
        id: "run-1:segment:0",
        index: 0,
        messages: [
          {
            id: "run-1:segment:0:message:0",
            index: 0,
            remoteRef: "171234.0001",
            text: "Hello",
            contentHash: "f55c314b",
            finalized: false,
            metadata: { mode: "stream" },
          },
        ],
      },
    ];

    const committed = await store.commit({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      renderedThroughSeq: 3,
      segments,
      presentation: { dialect: "mrkdwn" },
    });
    expect(committed).toMatchObject({
      renderedThroughSeq: 3,
      segments,
      presentation: { dialect: "mrkdwn" },
      version: 1,
    });

    expect(await store.release(claimed!.id, "worker-a")).toBe(true);
    const resumed = await store.claim("run-1", ref, "worker-b", 30_000);
    expect(resumed).toMatchObject({
      id: claimed!.id,
      renderedThroughSeq: 3,
      segments,
      version: 1,
      lease: { owner: "worker-b" },
    });
  });

  it("preserves presentation state when a later commit omits it", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const first = await store.commit({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      renderedThroughSeq: 1,
      segments: [],
      presentation: { dialect: "mrkdwn" },
    });
    const second = await store.commit({
      id: first.id,
      owner: "worker-a",
      expectedVersion: 1,
      renderedThroughSeq: 2,
      segments: [],
    });

    expect(second.presentation).toEqual({ dialect: "mrkdwn" });
  });

  it("rejects stale or future cursor commits", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const committed = await store.commit({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      renderedThroughSeq: 2,
      segments: [],
    });

    await expect(
      store.commit({
        id: committed.id,
        owner: "worker-a",
        expectedVersion: 0,
        renderedThroughSeq: 3,
        segments: [],
      }),
    ).rejects.toBeInstanceOf(SurfaceRealizationConflictError);
    await expect(
      store.commit({
        id: committed.id,
        owner: "worker-a",
        expectedVersion: 1,
        renderedThroughSeq: 1,
        segments: [],
      }),
    ).rejects.toBeInstanceOf(SurfaceRealizationConflictError);
    await expect(
      store.commit({
        id: committed.id,
        owner: "worker-a",
        expectedVersion: 1,
        renderedThroughSeq: 5,
        segments: [],
      }),
    ).rejects.toBeInstanceOf(SurfaceRealizationConflictError);
  });

  it("reconciles to the run cursor after event-log truncation", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const committed = await store.commit({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      renderedThroughSeq: 3,
      segments: [],
    });
    await db.agentRun.update({ where: { id: "run-1" }, data: { lastEventSeq: 1 } });

    const reconciled = await store.commit({
      id: committed.id,
      owner: "worker-a",
      expectedVersion: 1,
      renderedThroughSeq: 1,
      segments: [],
    });

    expect(reconciled).toMatchObject({ renderedThroughSeq: 1, version: 2 });
  });

  it("preserves the cursor across failure and makes retry timing claimable", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const committed = await store.commit({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      renderedThroughSeq: 2,
      segments: [],
    });
    const failed = await store.recordFailure({
      id: committed.id,
      owner: "worker-a",
      expectedVersion: 1,
      code: "rate_limited",
      nextRetryAt: new Date("2026-07-31T12:01:00.000Z"),
    });

    expect(failed).toMatchObject({
      renderedThroughSeq: 2,
      version: 2,
      retry: {
        attempt: 1,
        terminal: false,
        nextAt: "2026-07-31T12:01:00.000Z",
        lastErrorCode: "rate_limited",
      },
    });
    expect(await store.claim("run-1", ref, "worker-b", 30_000)).toBeUndefined();

    now = new Date("2026-07-31T12:01:00.000Z");
    const retried = await store.claim("run-1", ref, "worker-b", 30_000);
    expect(retried).toMatchObject({ renderedThroughSeq: 2, retry: { attempt: 1 } });
  });

  it("persists an unacknowledged plan across failure and clears it on commit", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const plan: RenderPlan = {
      fromCursor: 0,
      toCursor: 1,
      operations: [
        {
          id: "run-1:segment:0:message:0:create",
          type: "create",
          messageId: "run-1:segment:0:message:0",
          segmentId: "run-1:segment:0",
          segmentIndex: 0,
          messageIndex: 0,
          content: { text: "Hello", parts: [] },
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
              text: "Hello",
              contentHash: "f55c314b",
              finalized: false,
            },
          ],
        },
      ],
    };

    const staged = await store.stagePlan({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      plan,
    });
    expect(staged).toMatchObject({ version: 1, pendingPlan: plan });

    const failed = await store.recordFailure({
      id: staged.id,
      owner: "worker-a",
      expectedVersion: 1,
      code: "unavailable",
    });
    expect(failed).toMatchObject({ version: 2, pendingPlan: plan });

    const retried = await store.claim("run-1", ref, "worker-b", 30_000);
    expect(retried).toMatchObject({ version: 2, pendingPlan: plan });
    const committed = await store.commit({
      id: retried!.id,
      owner: "worker-b",
      expectedVersion: 2,
      renderedThroughSeq: 1,
      segments: [
        {
          ...plan.nextSegments[0]!,
          messages: [{ ...plan.nextSegments[0]!.messages[0]!, remoteRef: "remote-1" }],
        },
      ],
    });
    expect(committed).toMatchObject({ renderedThroughSeq: 1, version: 3 });
    expect(committed.pendingPlan).toBeUndefined();
  });

  it("persists a follow-up requirement when a staged plan crosses a truncation", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const changedSegments: RealizedSegment[] = [
      {
        id: "run-1:segment:0",
        index: 0,
        messages: [
          {
            id: "run-1:segment:0:message:0",
            index: 0,
            remoteRef: "remote-1",
            text: "Changed",
            contentHash: "changed",
            finalized: false,
          },
        ],
      },
    ];
    const staged = await store.stagePlan({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      plan: {
        fromCursor: 0,
        toCursor: 2,
        operations: [
          {
            id: "run-1:segment:0:message:0:create",
            type: "create",
            messageId: "run-1:segment:0:message:0",
            segmentId: "run-1:segment:0",
            segmentIndex: 0,
            messageIndex: 0,
            content: { text: "Changed", parts: [] },
            finalized: false,
          },
        ],
        nextSegments: changedSegments,
      },
    });
    await db.agentRun.update({ where: { id: "run-1" }, data: { lastEventSeq: 1 } });

    const truncated = await store.commit({
      id: staged.id,
      owner: "worker-a",
      expectedVersion: 1,
      renderedThroughSeq: 1,
      segments: changedSegments,
    });
    expect(truncated).toMatchObject({
      renderedThroughSeq: 1,
      reconciliationRequired: true,
      version: 2,
    });

    const correction: RenderPlan = {
      fromCursor: 1,
      toCursor: 1,
      operations: [
        {
          id: "run-1:segment:0:message:0:replace:1",
          type: "replace",
          messageId: "run-1:segment:0:message:0",
          segmentId: "run-1:segment:0",
          segmentIndex: 0,
          messageIndex: 0,
          remoteRef: "remote-1",
          content: { text: "Original", parts: [] },
        },
      ],
      nextSegments: [
        {
          ...changedSegments[0]!,
          messages: [
            {
              ...changedSegments[0]!.messages[0]!,
              text: "Original",
              contentHash: "original",
            },
          ],
        },
      ],
    };
    const correctionStaged = await store.stagePlan({
      id: truncated.id,
      owner: "worker-a",
      expectedVersion: 2,
      plan: correction,
    });
    const reconciled = await store.commit({
      id: correctionStaged.id,
      owner: "worker-a",
      expectedVersion: 3,
      renderedThroughSeq: 1,
      segments: correction.nextSegments,
    });
    expect(reconciled).toMatchObject({
      renderedThroughSeq: 1,
      reconciliationRequired: false,
      version: 4,
    });
  });

  it("does not reclaim a realization after a terminal delivery failure", async () => {
    const claimed = await store.claim("run-1", ref, "worker-a", 30_000);
    const failed = await store.recordFailure({
      id: claimed!.id,
      owner: "worker-a",
      expectedVersion: 0,
      code: "revoked",
      terminal: true,
    });

    expect(failed.retry).toEqual({ attempt: 1, terminal: true, lastErrorCode: "revoked" });
    now = new Date("2026-08-01T12:00:00.000Z");
    expect(await store.claim("run-1", ref, "worker-b", 30_000)).toBeUndefined();
  });
});
