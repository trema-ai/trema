import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { type Principal, Prisma, type Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { orgRouter } from "#server/rpc/org.js";
import { runsRouter } from "#server/rpc/runs.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("run reads", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "run-read-integration-secret-at-least-32-characters",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  });
  const auth = createAuth({ db, env });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function signUp(name: string) {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name, email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function createOrg() {
    const signedUp = await signUp("Run Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Run Org" },
      { context: signedUp.context },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "agent" },
    });
    return { ...signedUp, ...membership, orgScope, agent };
  }

  async function addMember(orgId: string, orgScopeId: string, role: Role, name: string) {
    const signedUp = await signUp(name);
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: signedUp.user.id,
        displayName: name,
        email: signedUp.user.email,
      },
    });
    await db.grant.create({
      data: { orgId, principalId: principal.id, scopeId: orgScopeId, role },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...signedUp, principal };
  }

  async function personalScope(orgId: string, owner: Principal) {
    return db.scope.create({
      data: { orgId, kind: "personal", name: owner.displayName, ownerId: owner.id },
    });
  }

  async function openSession(orgId: string, scopeId: string, agent: Principal) {
    return db.contextSession.create({
      data: {
        orgId,
        scopeId,
        surface: "web",
        locationRef: "member-1",
        scopeChain: [scopeId],
        agentPrincipalId: agent.id,
        standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
        policySnapshot: {},
        snapshotHash: "snapshot-hash-1",
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  async function createRun(options: {
    orgId: string;
    sessionId: string;
    threadRef: string;
    createdAt?: Date;
    state?:
      | "queued"
      | "running"
      | "awaiting_approval"
      | "awaiting_input"
      | "completed"
      | "failed"
      | "cancelled"
      | "stale";
    trigger?: "message" | "api" | "schedule" | "retry" | "resume";
  }) {
    return db.agentRun.create({
      data: {
        id: `run-${randomUUID()}`,
        orgId: options.orgId,
        threadRef: options.threadRef,
        state: options.state ?? "completed",
        trigger: options.trigger ?? "message",
        sessionId: options.sessionId,
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      },
    });
  }

  async function appendEvents(orgId: string, runId: string, events: unknown[]) {
    let seq = 0;
    for (const event of events) {
      seq += 1;
      await db.runEvent.create({
        data: { orgId, runId, seq, at: new Date(), event: event as object },
      });
    }
    await db.agentRun.update({
      where: { orgId_id: { orgId, id: runId } },
      data: { lastEventSeq: seq },
    });
  }

  function steering(principalId: string, text: string) {
    return { type: "steering", author: { principalId, displayName: "Alice" }, text };
  }

  /** An org with Alice (a member owning a personal scope) and a run of hers. */
  async function setup() {
    const org = await createOrg();
    const alice = await addMember(org.org.id, org.orgScope.id, "member", "Alice");
    const bob = await addMember(org.org.id, org.orgScope.id, "member", "Bob");
    const scope = await personalScope(org.org.id, alice.principal);
    const session = await openSession(org.org.id, scope.id, org.agent);
    const run = await createRun({
      orgId: org.org.id,
      sessionId: session.id,
      threadRef: "web:alice",
    });
    return { org, alice, bob, scope, session, run };
  }

  describe("GET /runs", () => {
    it("lists discoverable runs newest first at the caller's permitted depth", async () => {
      const { org, alice, bob, session, run } = await setup();
      const newer = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:alice",
        createdAt: new Date(run.createdAt.getTime() + 1000),
        state: "running",
        trigger: "api",
      });

      const owned = await call(runsRouter.list, {}, { context: alice.context });
      expect(owned.runs).toEqual([
        expect.objectContaining({
          access: "full",
          id: newer.id,
          surface: "web",
          locationRef: "member-1",
        }),
        expect.objectContaining({ access: "full", id: run.id }),
      ]);

      const audited = await call(runsRouter.list, {}, { context: org.context });
      expect(audited.runs).toEqual([
        expect.objectContaining({ access: "metadata", id: newer.id }),
        expect.objectContaining({ access: "metadata", id: run.id }),
      ]);
      expect(audited.runs[0]).not.toHaveProperty("surface");
      expect(audited.runs[0]).not.toHaveProperty("threadRef");

      const hidden = await call(runsRouter.list, {}, { context: bob.context });
      expect(hidden).toEqual({ runs: [] });
    });

    it("filters the recent index by state and trigger", async () => {
      const { org, alice, session, run } = await setup();
      const running = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:alice",
        createdAt: new Date(run.createdAt.getTime() + 1000),
        state: "running",
        trigger: "api",
      });

      const listed = await call(
        runsRouter.list,
        { state: "running", trigger: "api" },
        { context: alice.context },
      );

      expect(listed.runs.map(({ id }) => id)).toEqual([running.id]);
    });

    it("applies the limit after removing runs the caller cannot discover", async () => {
      const { org, bob, run } = await setup();
      const scope = await personalScope(org.org.id, bob.principal);
      const session = await openSession(org.org.id, scope.id, org.agent);
      const visible = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:bob",
        createdAt: new Date(run.createdAt.getTime() - 1000),
      });

      const listed = await call(runsRouter.list, { limit: 1 }, { context: bob.context });

      expect(listed.runs.map(({ id }) => id)).toEqual([visible.id]);
    });
  });

  describe("GET /runs/{id}", () => {
    it("gives the owner the full record: grant snapshot and queued input included", async () => {
      const { org, alice, scope, run } = await setup();
      await db.runQueuedInput.create({
        data: {
          id: "intent-steer-1",
          orgId: org.org.id,
          kind: "steering",
          runId: run.id,
          threadRef: run.threadRef,
          message: { role: "user", blocks: [{ type: "text", text: "Also check the migration." }] },
          author: { principalId: alice.principal.id, displayName: "Alice" },
        },
      });
      // A follow-up queues on the thread, not the run, and is still this run's
      // pending input: it waits behind it.
      await db.runQueuedInput.create({
        data: {
          id: "intent-follow-1",
          orgId: org.org.id,
          kind: "follow_up",
          threadRef: run.threadRef,
          message: { role: "user", blocks: [{ type: "text", text: "Then restart the worker." }] },
          author: { principalId: alice.principal.id, displayName: "Alice" },
        },
      });

      const read = await call(runsRouter.get, { id: run.id }, { context: alice.context });

      expect(read).toMatchObject({
        access: "full",
        id: run.id,
        state: "completed",
        trigger: "message",
        threadRef: "web:alice",
        surface: "web",
        locationRef: "member-1",
        turnCount: 0,
        error: null,
        retryOfRunId: null,
        retryAttempt: null,
      });
      if (read.access !== "full") return;
      expect(read.grantSnapshot).toEqual({
        scopeChain: [scope.id],
        snapshotHash: "snapshot-hash-1",
      });
      expect(read.queuedInput.map(({ id, kind, text }) => ({ id, kind, text }))).toEqual([
        { id: "intent-steer-1", kind: "steering", text: "Also check the migration." },
        { id: "intent-follow-1", kind: "follow_up", text: "Then restart the worker." },
      ]);
      expect(read.queuedInput[0]?.author).toEqual({
        principalId: alice.principal.id,
        displayName: "Alice",
      });
      expect(read.queuedInput[1]!.position).toBeGreaterThan(read.queuedInput[0]!.position);
    });

    it("gives an org owner audit metadata on a member's run: tool names, no content", async () => {
      const { org, alice, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "Check my calendar."),
        { type: "tool-start", callId: "c1", name: "read_calendar", title: "Read", kind: "read" },
        { type: "tool-result", callId: "c1", status: "ok", summary: "3 events" },
        { type: "tool-start", callId: "c2", name: "send_email", title: "Send", kind: "connector" },
        { type: "tool-start", callId: "c3", name: "read_calendar", title: "Read", kind: "read" },
      ]);

      const read = await call(runsRouter.get, { id: run.id }, { context: org.context });

      expect(read).toMatchObject({
        access: "metadata",
        id: run.id,
        state: "completed",
        trigger: "message",
        turnCount: 0,
      });
      if (read.access !== "metadata") return;
      expect(read.toolNames).toEqual(["read_calendar", "send_email"]);
      // Never content: no thread, no surface, no queued input, no snapshot.
      expect(read).not.toHaveProperty("threadRef");
      expect(read).not.toHaveProperty("surface");
      expect(read).not.toHaveProperty("locationRef");
      expect(read).not.toHaveProperty("queuedInput");
      expect(read).not.toHaveProperty("grantSnapshot");
      expect(read).not.toHaveProperty("error");
      expect(JSON.stringify(read)).not.toContain("Check my calendar.");
    });

    it("hides another member's personal run exactly like a missing one", async () => {
      const { bob, run } = await setup();

      await expect(
        call(runsRouter.get, { id: run.id }, { context: bob.context }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
      await expect(
        call(runsRouter.get, { id: "run-missing" }, { context: bob.context }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
    });
  });

  describe("GET /runs/{id}/events", () => {
    it("pages the log with the after cursor", async () => {
      const { org, alice, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "Check the deploy."),
        { type: "text-start", blockId: "b1" },
        { type: "text-delta", blockId: "b1", delta: "Deployed." },
        { type: "text-end", blockId: "b1" },
      ]);

      const first = await call(
        runsRouter.events,
        { id: run.id, limit: 2 },
        { context: alice.context },
      );
      expect(first.events.map(({ seq }) => seq)).toEqual([1, 2]);
      expect(first).toMatchObject({ cursor: 2, hasMore: true, malformed: 0 });

      const second = await call(
        runsRouter.events,
        { id: run.id, after: first.cursor, limit: 2 },
        { context: alice.context },
      );
      expect(second.events.map(({ seq }) => seq)).toEqual([3, 4]);
      expect(second.hasMore).toBe(true);

      const last = await call(
        runsRouter.events,
        { id: run.id, after: second.cursor, limit: 2 },
        { context: alice.context },
      );
      expect(last.events.map(({ seq }) => seq)).toEqual([5]);
      expect(last).toMatchObject({ cursor: 5, hasMore: false });

      const empty = await call(
        runsRouter.events,
        { id: run.id, after: 5 },
        { context: alice.context },
      );
      expect(empty).toMatchObject({ events: [], cursor: 5, hasMore: false });
    });

    it("passes an unknown event type through as recorded", async () => {
      const { org, alice, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        { type: "telemetry-blip", detail: { spanId: "s1" } },
      ]);

      const page = await call(runsRouter.events, { id: run.id }, { context: alice.context });

      expect(page.malformed).toBe(0);
      expect(page.events[1]?.event).toEqual({ type: "telemetry-blip", detail: { spanId: "s1" } });
    });

    it("skips and counts a malformed known event without failing the page", async () => {
      const { org, alice, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        // A steering event with no author and a non-string text: known type,
        // invalid payload.
        { type: "steering", text: 42 },
        { type: "text-start", blockId: "b1" },
      ]);

      const page = await call(runsRouter.events, { id: run.id }, { context: alice.context });

      expect(page.malformed).toBe(1);
      expect(page.events.map(({ seq }) => seq)).toEqual([1, 3]);
      // The cursor still covers the skipped row, so paging never sticks on it.
      expect(page.cursor).toBe(3);
    });

    it("refuses the log to a metadata viewer as if the run were missing", async () => {
      const { org, run } = await setup();

      await expect(
        call(runsRouter.events, { id: run.id }, { context: org.context }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
    });
  });

  describe("GET /threads/{threadRef}/runs", () => {
    it("lists the thread's runs in order with derived opening messages", async () => {
      const { org, alice, session, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "First question."),
      ]);
      const second = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:alice",
        createdAt: new Date(run.createdAt.getTime() + 1000),
      });
      await appendEvents(org.org.id, second.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "Second question."),
      ]);
      // A run nobody messaged: its log opens with no steering.
      const scheduled = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:alice",
        createdAt: new Date(run.createdAt.getTime() + 2000),
      });
      await appendEvents(org.org.id, scheduled.id, [
        { type: "run-started", trigger: "schedule" },
        { type: "text-start", blockId: "b1" },
      ]);

      const listed = await call(
        runsRouter.listByThread,
        { threadRef: "web:alice" },
        { context: alice.context },
      );

      expect(listed.runs.map(({ id }) => id)).toEqual([run.id, second.id, scheduled.id]);
      expect(listed.runs.map(({ openingMessage }) => openingMessage)).toEqual([
        {
          author: { principalId: alice.principal.id, displayName: "Alice" },
          text: "First question.",
        },
        {
          author: { principalId: alice.principal.id, displayName: "Alice" },
          text: "Second question.",
        },
        null,
      ]);
    });

    it("bounds the list to the thread's most recent runs, still in run order", async () => {
      const { org, alice, session, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "Oldest question."),
      ]);
      const later: string[] = [];
      for (const offset of [1000, 2000]) {
        const created = await createRun({
          orgId: org.org.id,
          sessionId: session.id,
          threadRef: "web:alice",
          createdAt: new Date(run.createdAt.getTime() + offset),
        });
        await appendEvents(org.org.id, created.id, [
          { type: "run-started", trigger: "message" },
          steering(alice.principal.id, `Question at ${offset}.`),
        ]);
        later.push(created.id);
      }

      const listed = await call(
        runsRouter.listByThread,
        { threadRef: "web:alice", limit: 2 },
        { context: alice.context },
      );

      // The oldest run falls off the bound; the survivors keep run order.
      expect(listed.runs.map(({ id }) => id)).toEqual(later);
      expect(listed.runs.map(({ openingMessage }) => openingMessage?.text)).toEqual([
        "Question at 1000.",
        "Question at 2000.",
      ]);
    });

    it("derives the opening message across an unknown leading event type", async () => {
      const { org, alice, run } = await setup();
      // A newer server's additive event lands between run-started and the
      // opening steering: unknown types skip, they never terminate.
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        { type: "attachment-noted", ref: "a1" },
        steering(alice.principal.id, "Behind the unknown."),
      ]);

      const listed = await call(
        runsRouter.listByThread,
        { threadRef: "web:alice" },
        { context: alice.context },
      );

      expect(listed.runs[0]?.openingMessage).toMatchObject({ text: "Behind the unknown." });
    });

    it("keeps listing the thread when one run's log holds a malformed event", async () => {
      const { org, alice, session, run } = await setup();
      // A recorded event that is JSON null: deriving from it throws, which
      // must cost this run its opening message — never the run, or the rest
      // of the thread.
      await appendEvents(org.org.id, run.id, [Prisma.JsonNull]);
      const second = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:alice",
        createdAt: new Date(run.createdAt.getTime() + 1000),
      });
      await appendEvents(org.org.id, second.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "Still here."),
      ]);
      // A steering payload that derives without throwing but is shaped wrong
      // for the response: it must cost the opening message, not the list.
      const third = await createRun({
        orgId: org.org.id,
        sessionId: session.id,
        threadRef: "web:alice",
        createdAt: new Date(run.createdAt.getTime() + 2000),
      });
      await appendEvents(org.org.id, third.id, [
        { type: "run-started", trigger: "message" },
        { type: "steering", text: 42 },
      ]);

      const listed = await call(
        runsRouter.listByThread,
        { threadRef: "web:alice" },
        { context: alice.context },
      );

      expect(listed.runs.map(({ id }) => id)).toEqual([run.id, second.id, third.id]);
      expect(listed.runs[0]?.openingMessage).toBeNull();
      expect(listed.runs[1]?.openingMessage).toMatchObject({ text: "Still here." });
      expect(listed.runs[2]?.openingMessage).toBeNull();
    });

    it("filters invisible runs down to an empty thread", async () => {
      const { org, alice, bob, run } = await setup();
      await appendEvents(org.org.id, run.id, [
        { type: "run-started", trigger: "message" },
        steering(alice.principal.id, "A private question."),
      ]);

      // The org owner holds audit metadata on the run, which is not enough to
      // appear in a content read; a plain member holds nothing. Both see the
      // same empty thread they would see for a threadRef that never existed.
      for (const context of [org.context, bob.context]) {
        const listed = await call(runsRouter.listByThread, { threadRef: "web:alice" }, { context });
        expect(listed).toEqual({ runs: [] });
      }
    });
  });
});
