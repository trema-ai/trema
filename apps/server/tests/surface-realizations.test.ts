import type { RealizedSegment, SurfaceRef } from "@trema/surfaces";
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
        renderedThroughSeq: 5,
        segments: [],
      }),
    ).rejects.toBeInstanceOf(SurfaceRealizationConflictError);
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
