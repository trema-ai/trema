import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Principal } from "#server/generated/prisma/client.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { resolveRunAccess } from "#server/services/runs/access.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("run read access", () => {
  const db = createPrismaClient(databaseUrl);
  let orgId = "";
  /** Holds `admin` at the org scope and nothing else. */
  let admin: Principal;
  /** Holds `member` at the org scope and nothing else. */
  let member: Principal;
  /** Holds `viewer` directly on the shared scope and nothing else. */
  let sharedViewer: Principal;
  /** Owns the personal scope; no grants at all. */
  let alice: Principal;
  /** An agent-kind principal; agents hold no control-plane role. */
  let agent: Principal;
  let sharedRunId = "";
  let personalRunId = "";
  let sessionlessRunId = "";

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org" CASCADE`;
    const org = await db.org.create({ data: { name: "Run access org" } });
    orgId = org.id;

    const orgScope = await db.scope.create({ data: { orgId, kind: "org", name: "Org" } });
    const sharedScope = await db.scope.create({ data: { orgId, kind: "shared", name: "Shared" } });

    async function principal(kind: "human" | "agent", displayName: string): Promise<Principal> {
      return db.principal.create({ data: { orgId, kind, displayName } });
    }
    admin = await principal("human", "Admin");
    member = await principal("human", "Member");
    sharedViewer = await principal("human", "Shared viewer");
    alice = await principal("human", "Alice");
    agent = await principal("agent", "Agent");
    await db.grant.create({
      data: { orgId, principalId: admin.id, scopeId: orgScope.id, role: "admin" },
    });
    await db.grant.create({
      data: { orgId, principalId: member.id, scopeId: orgScope.id, role: "member" },
    });
    await db.grant.create({
      data: { orgId, principalId: sharedViewer.id, scopeId: sharedScope.id, role: "viewer" },
    });
    const personalScope = await db.scope.create({
      data: { orgId, kind: "personal", name: "Alice", ownerId: alice.id },
    });

    async function run(scopeId: string | null): Promise<string> {
      const id = `run-${randomUUID()}`;
      let sessionId: string | null = null;
      if (scopeId !== null) {
        const session = await db.contextSession.create({
          data: {
            orgId,
            scopeId,
            surface: "web",
            locationRef: "member-1",
            mode: "service",
            actingPrincipalId: agent.id,
            standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
            policySnapshot: {},
            snapshotHash: "snapshot-1",
            tokenHash: randomUUID(),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        sessionId = session.id;
      }
      await db.agentRun.create({
        data: {
          id,
          orgId,
          threadRef: `thread-${id}`,
          state: "completed",
          trigger: "message",
          ...(sessionId === null ? {} : { sessionId }),
        },
      });
      return id;
    }
    sharedRunId = await run(sharedScope.id);
    personalRunId = await run(personalScope.id);
    sessionlessRunId = await run(null);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("gives a scope reader full access to a shared-scope run, rows included", async () => {
    const verdict = await resolveRunAccess({
      db,
      orgId,
      principal: sharedViewer,
      runId: sharedRunId,
    });

    expect(verdict.access).toBe("full");
    if (verdict.access !== "full") return;
    // The verdict carries what it fetched, so a caller never re-reads the rows.
    expect(verdict.run.id).toBe(sharedRunId);
    expect(verdict.session?.id).toBe(verdict.run.sessionId);
    expect(verdict.scope?.id).toBe(verdict.session?.scopeId);
    expect(verdict.scope?.kind).toBe("shared");
  });

  it("inherits org roles into shared scopes: admins and members see the run", async () => {
    const asAdmin = await resolveRunAccess({ db, orgId, principal: admin, runId: sharedRunId });
    const asMember = await resolveRunAccess({ db, orgId, principal: member, runId: sharedRunId });

    expect(asAdmin.access).toBe("full");
    expect(asMember.access).toBe("full");
  });

  it("gives a personal-scope run's owner full access", async () => {
    const verdict = await resolveRunAccess({ db, orgId, principal: alice, runId: personalRunId });

    expect(verdict.access).toBe("full");
  });

  it("gives an org admin metadata, never content, on another person's run", async () => {
    const verdict = await resolveRunAccess({ db, orgId, principal: admin, runId: personalRunId });

    expect(verdict.access).toBe("metadata");
    if (verdict.access !== "metadata") return;
    expect(verdict.run.id).toBe(personalRunId);
    expect(verdict.scope?.kind).toBe("personal");
  });

  it("hides another person's run from a plain member entirely", async () => {
    const verdict = await resolveRunAccess({ db, orgId, principal: member, runId: personalRunId });

    expect(verdict).toEqual({ access: "none" });
  });

  it("answers none for a run that does not exist", async () => {
    const verdict = await resolveRunAccess({ db, orgId, principal: admin, runId: "run-missing" });

    expect(verdict).toEqual({ access: "none" });
  });

  it("denies a sessionless run by default, keeping the audit view for admins", async () => {
    // No real trigger produces a sessionless run; one appears only after its
    // scope (and with it the session) was deleted. Nobody can hold read at a
    // scope that is gone, so only the audit-grade org roles see anything.
    const asAdmin = await resolveRunAccess({
      db,
      orgId,
      principal: admin,
      runId: sessionlessRunId,
    });
    const asMember = await resolveRunAccess({
      db,
      orgId,
      principal: member,
      runId: sessionlessRunId,
    });

    expect(asAdmin).toEqual(
      expect.objectContaining({ access: "metadata", session: null, scope: null }),
    );
    expect(asMember).toEqual({ access: "none" });
  });

  it("treats a run that lost its session as sessionless, even for the old owner", async () => {
    // Simulates the anomaly directly: the schema refuses to delete a session
    // (or its scope) out from under a run, so an orphaned run only exists
    // from a write outside dispatch. Once the session reference is gone the
    // scope is unknowable, and the old owner is nobody special.
    await db.agentRun.update({
      where: { orgId_id: { orgId, id: personalRunId } },
      data: { sessionId: null },
    });

    const asAdmin = await resolveRunAccess({ db, orgId, principal: admin, runId: personalRunId });
    const asAlice = await resolveRunAccess({ db, orgId, principal: alice, runId: personalRunId });

    expect(asAdmin.access).toBe("metadata");
    expect(asAlice).toEqual({ access: "none" });
  });

  it("gives an agent principal nothing, anywhere", async () => {
    for (const runId of [sharedRunId, personalRunId, sessionlessRunId]) {
      expect(await resolveRunAccess({ db, orgId, principal: agent, runId })).toEqual({
        access: "none",
      });
    }
  });

  it("refuses a principal from another organization before touching the run", async () => {
    const verdict = await resolveRunAccess({
      db,
      orgId,
      principal: { id: admin.id, orgId: "other-org", kind: "human" },
      runId: sharedRunId,
    });

    expect(verdict).toEqual({ access: "none" });
  });
});
