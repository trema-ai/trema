import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "#server/lib/db/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

// The AgentRun → ContextSession reference is NO ACTION, not SET NULL: run
// visibility is pinned to the session's grant snapshot, so the session row
// must outlive its runs. NO ACTION checks at end of statement, which lets an
// org delete cascade both sides away while refusing any delete that would
// leave a surviving run without its session.
integration("run session referential integrity", () => {
  const db = createPrismaClient(databaseUrl);
  let orgId = "";
  let scopeId = "";
  let sessionId = "";
  let runId = "";

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org" CASCADE`;
    const org = await db.org.create({ data: { name: "Integrity org" } });
    orgId = org.id;
    const scope = await db.scope.create({ data: { orgId, kind: "org", name: "Org" } });
    scopeId = scope.id;
    const agent = await db.principal.create({
      data: { orgId, kind: "agent", displayName: "Agent" },
    });
    const session = await db.contextSession.create({
      data: {
        orgId,
        scopeId,
        surface: "web",
        locationRef: "member-1",
        agentPrincipalId: agent.id,
        standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
        policySnapshot: {},
        snapshotHash: "snapshot-1",
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    sessionId = session.id;
    runId = `run-${randomUUID()}`;
    await db.agentRun.create({
      data: {
        id: runId,
        orgId,
        threadRef: `thread-${runId}`,
        state: "completed",
        trigger: "message",
        sessionId,
      },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("refuses to delete a session a surviving run still references", async () => {
    await expect(db.contextSession.delete({ where: { id: sessionId } })).rejects.toThrow();

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.sessionId).toBe(sessionId);
  });

  it("refuses to delete a scope whose sessions have surviving runs", async () => {
    // The scope delete cascades into ContextSession; NO ACTION on the run's
    // reference stops the whole statement rather than orphaning the run.
    await expect(db.scope.delete({ where: { id: scopeId } })).rejects.toThrow();

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.sessionId).toBe(sessionId);
  });

  it("lets an org delete cascade runs and sessions away together", async () => {
    await db.org.delete({ where: { id: orgId } });

    expect(await db.agentRun.findUnique({ where: { id: runId } })).toBeNull();
    expect(await db.contextSession.findUnique({ where: { id: sessionId } })).toBeNull();
  });

  it("lets a session go once its runs are gone", async () => {
    await db.agentRun.delete({ where: { id: runId } });

    await expect(db.contextSession.delete({ where: { id: sessionId } })).resolves.toBeDefined();
  });

  it("pins the same organization agent on org, shared, and personal runs", async () => {
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId, kind: "agent" },
    });
    const owner = await db.principal.create({
      data: { orgId, kind: "human", displayName: "Personal owner" },
    });
    const [sharedScope, personalScope] = await Promise.all([
      db.scope.create({ data: { orgId, kind: "shared", name: "Shared" } }),
      db.scope.create({
        data: { orgId, kind: "personal", name: "Personal", ownerId: owner.id },
      }),
    ]);

    for (const scope of [sharedScope, personalScope]) {
      const session = await db.contextSession.create({
        data: {
          orgId,
          scopeId: scope.id,
          surface: "web",
          locationRef: scope.id,
          agentPrincipalId: agent.id,
          requesterPrincipalId: owner.id,
          standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
          policySnapshot: {},
          snapshotHash: `snapshot-${scope.kind}`,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await db.agentRun.create({
        data: {
          id: `run-${scope.kind}-${randomUUID()}`,
          orgId,
          threadRef: `thread-${scope.kind}`,
          state: "completed",
          trigger: "message",
          sessionId: session.id,
        },
      });
    }

    const sessions = await db.contextSession.findMany({
      where: { orgId, agentRuns: { some: {} } },
      include: { scope: { select: { kind: true } } },
    });
    expect(
      sessions
        .map(({ scope, agentPrincipalId }) => [scope.kind, agentPrincipalId] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["org", agent.id],
      ["personal", agent.id],
      ["shared", agent.id],
    ]);
  });
});
