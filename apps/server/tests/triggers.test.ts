import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { InMemoryEngine } from "@trema/harness";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { intentsRouter } from "#server/rpc/intents.js";
import { orgRouter } from "#server/rpc/org.js";
import { schedulesRouter } from "#server/rpc/schedules.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import type { RunServices } from "#server/services/runs/index.js";
import { createRunServices, startRun } from "#server/services/runs/index.js";
import {
  createSchedule,
  setScheduleStatus,
  tickSchedule,
} from "#server/services/schedules/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("triggers", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "trigger-integration-secret-at-least-32-characters",
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
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    return { context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function setup() {
    const { context } = await signUp("Trigger Owner");
    const membership = await call(orgRouter.create, { name: "Trigger Org" }, { context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context },
    );
    await call(
      bindingsRouter.create,
      { surface: "api", locationRef: "ops", scopeId: orgScope.id },
      { context },
    );

    const engine = new InMemoryEngine();
    const serviceContext = {
      db,
      auth,
      env,
      headers: new Headers({ authorization: `Bearer ${credential.secret}` }),
      runEngineFor: () => engine,
    };
    // The same browser cookie the admin calls carry, plus the engine: what the
    // web composer's requests resolve to.
    const sessionContext = { ...context, runEngineFor: () => engine };
    const owner = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "human" },
    });
    return {
      adminContext: context,
      serviceContext,
      sessionContext,
      engine,
      org: membership.org,
      orgScope,
      owner,
    };
  }

  // No model is configured, so the services compose no driver: these tests
  // assert where a message lands, not what the loop does with it.
  function servicesFor(orgId: string, engine: InMemoryEngine): RunServices {
    return createRunServices({ db, env, orgId, engine });
  }

  describe("POST /intents", () => {
    it("starts a run and reports where the message landed", async () => {
      const { serviceContext } = await setup();

      const accepted = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          intent: { type: "message", text: "Check the deploy." },
          intentId: "key-1",
        },
        { context: serviceContext },
      );

      expect(accepted).toMatchObject({ outcome: "started", threadRef: "api:ops" });
      const run = await db.agentRun.findUniqueOrThrow({ where: { id: accepted.runId! } });
      expect(run).toMatchObject({ state: "queued", trigger: "api", threadRef: "api:ops" });
      expect(run.sessionId).not.toBeNull();
      const queued = await db.runQueuedInput.findMany({ where: { runId: run.id } });
      expect(queued).toHaveLength(1);
      expect(queued[0]?.kind).toBe("steering");
    });

    it("answers a repeated intent id with the run the first call made", async () => {
      const { serviceContext } = await setup();
      const first = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          intent: { type: "message", text: "Check the deploy." },
          intentId: "key-1",
        },
        { context: serviceContext },
      );

      const second = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          intent: { type: "message", text: "Check the deploy." },
          intentId: "key-1",
        },
        { context: serviceContext },
      );

      expect(second).toEqual({ outcome: "duplicate", runId: first.runId, threadRef: "api:ops" });
      expect(await db.agentRun.count()).toBe(1);
    });

    it("steers the active run instead of starting a second one on the thread", async () => {
      const { serviceContext } = await setup();
      const first = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          intent: { type: "message", text: "Check the deploy." },
          intentId: "key-1",
        },
        { context: serviceContext },
      );

      const second = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          intent: { type: "message", text: "And the migration." },
          intentId: "key-2",
        },
        { context: serviceContext },
      );

      expect(second).toEqual({ outcome: "steered", runId: first.runId, threadRef: "api:ops" });
      expect(await db.agentRun.count()).toBe(1);
      expect(await db.runQueuedInput.count({ where: { runId: first.runId } })).toBe(2);
    });

    it("reclaims an intent id whose claiming call died before routing", async () => {
      const { serviceContext, org } = await setup();
      // A claim with no recorded run, old enough that its call cannot still be
      // routing: the crash left the intent id consumed and the message lost.
      await db.runIntent.create({
        data: {
          id: "key-1",
          orgId: org.id,
          createdAt: new Date(Date.now() - 5 * 60_000),
        },
      });

      const accepted = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          intent: { type: "message", text: "Check the deploy." },
          intentId: "key-1",
        },
        { context: serviceContext },
      );

      expect(accepted).toMatchObject({ outcome: "started", threadRef: "api:ops" });
      expect(accepted.runId).not.toBeNull();
      const claim = await db.runIntent.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.id, id: "key-1" } },
      });
      expect(claim.runId).toBe(accepted.runId);
    });

    it("rejects a location that is not bound to a scope", async () => {
      const { serviceContext } = await setup();

      await expect(
        call(
          intentsRouter.submit,
          {
            locationRef: "unbound",
            intent: { type: "message", text: "Anyone there?" },
            intentId: "key-1",
          },
          { context: serviceContext },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("POST /intents (session mode)", () => {
    it("starts a run on the member's own web location, stamped server-side", async () => {
      const { sessionContext, owner } = await setup();

      const accepted = await call(
        intentsRouter.submit,
        {
          intentId: "web-1",
          threadRef: "chat-1",
          intent: { type: "message", text: "Plan my week." },
        },
        { context: sessionContext },
      );

      expect(accepted).toMatchObject({ outcome: "started", threadRef: "chat-1" });
      const run = await db.agentRun.findUniqueOrThrow({ where: { id: accepted.runId! } });
      expect(run).toMatchObject({ trigger: "message", threadRef: "chat-1" });
      // The surface, location, and requester came from the cookie, never the
      // body: the session resolved to the member's own personal scope.
      const session = await db.contextSession.findUniqueOrThrow({
        where: { id: run.sessionId! },
        include: { scope: true },
      });
      expect(session).toMatchObject({ surface: "web", locationRef: owner.id });
      expect(session.scope).toMatchObject({ kind: "personal", ownerId: owner.id });
    });

    it("keeps the caller's own web thread writable across messages", async () => {
      const { sessionContext } = await setup();

      const first = await call(
        intentsRouter.submit,
        { intentId: "web-1", threadRef: "chat-1", intent: { type: "message", text: "Plan." } },
        { context: sessionContext },
      );
      const second = await call(
        intentsRouter.submit,
        { intentId: "web-2", threadRef: "chat-1", intent: { type: "message", text: "More." } },
        { context: sessionContext },
      );

      expect(second).toEqual({ outcome: "steered", runId: first.runId, threadRef: "chat-1" });
    });

    it("hides another member's thread from a session message", async () => {
      const { sessionContext, engine, org } = await setup();
      // Another member's active run on their own web thread: the write path
      // must refuse exactly like the reads — nothing there.
      const member = await db.principal.create({
        data: { orgId: org.id, kind: "human", displayName: "Someone Else" },
      });
      const started = await startRun({
        services: servicesFor(org.id, engine),
        input: {
          intentId: "member-1",
          trigger: "message",
          surface: "web",
          locationRef: member.id,
          requester: { principalId: member.id },
          message: { role: "user", blocks: [{ type: "text", text: "Private errand." }] },
          author: { principalId: member.id, displayName: member.displayName },
          threadRef: "member-chat",
        },
      });

      await expect(
        call(
          intentsRouter.submit,
          {
            intentId: "web-1",
            threadRef: "member-chat",
            intent: { type: "message", text: "Steer their run." },
          },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      // The member's run absorbed nothing: only its own opening message is
      // queued, and no second run appeared on the thread.
      expect(await db.runQueuedInput.count({ where: { runId: started.runId! } })).toBe(1);
      expect(await db.agentRun.count({ where: { orgId: org.id, threadRef: "member-chat" } })).toBe(
        1,
      );
    });

    it("refuses a session body that names a surface or location", async () => {
      const { sessionContext } = await setup();

      for (const body of [{ locationRef: "ops" }, { surface: "api" }]) {
        await expect(
          call(
            intentsRouter.submit,
            {
              intentId: "web-1",
              intent: { type: "message", text: "Plan my week." },
              ...body,
            },
            { context: sessionContext },
          ),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          data: { code: "session_names_location" },
        });
      }
    });

    it("surfaces disabled personal scopes as the structured error", async () => {
      const { adminContext, sessionContext } = await setup();
      await call(scopesRouter.setPersonalPolicy, { enabled: false }, { context: adminContext });

      await expect(
        call(
          intentsRouter.submit,
          { intentId: "web-1", intent: { type: "message", text: "Anyone there?" } },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { code: "personal_scopes_disabled" },
      });
    });

    it("requires a service-mode message to name its location", async () => {
      const { serviceContext } = await setup();

      await expect(
        call(
          intentsRouter.submit,
          { intentId: "key-1", intent: { type: "message", text: "Where to?" } },
          { context: serviceContext },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "location_required" } });
    });
  });

  describe("POST /intents (resolve, stop, retry, feedback)", () => {
    async function startedRun(
      serviceContext: Awaited<ReturnType<typeof setup>>["serviceContext"],
      intentId = "key-1",
    ) {
      const accepted = await call(
        intentsRouter.submit,
        { locationRef: "ops", intent: { type: "message", text: "Check the deploy." }, intentId },
        { context: serviceContext },
      );
      return accepted.runId!;
    }

    it("stops an active run, recording the stop fact before answering", async () => {
      const { serviceContext, sessionContext } = await setup();
      const runId = await startedRun(serviceContext);

      const stopped = await call(
        intentsRouter.submit,
        { intentId: "stop-1", target: { runId }, intent: { type: "stop", runId } },
        { context: sessionContext },
      );

      expect(stopped).toEqual({ outcome: "stopped", runId, threadRef: "api:ops" });
      await expect(db.runStop.findUniqueOrThrow({ where: { runId } })).resolves.toMatchObject({
        intentId: "stop-1",
      });

      // A retried POST returns `duplicate` with the original routing.
      const repeated = await call(
        intentsRouter.submit,
        { intentId: "stop-1", intent: { type: "stop", runId } },
        { context: sessionContext },
      );
      expect(repeated).toEqual({ outcome: "duplicate", runId, threadRef: "api:ops" });
    });

    it("answers a replayed stop as duplicate after the run reached terminal state", async () => {
      const { serviceContext, sessionContext } = await setup();
      const runId = await startedRun(serviceContext);
      const stopped = await call(
        intentsRouter.submit,
        { intentId: "stop-1", intent: { type: "stop", runId } },
        { context: sessionContext },
      );
      expect(stopped.outcome).toBe("stopped");
      // The worker finishes the cancellation; the run is now terminal.
      await db.agentRun.update({ where: { id: runId }, data: { state: "cancelled" } });

      // An at-least-once retry reads back the claim, not the state its own
      // success left behind: `duplicate`, never `run_not_active`.
      const replayed = await call(
        intentsRouter.submit,
        { intentId: "stop-1", intent: { type: "stop", runId } },
        { context: sessionContext },
      );
      expect(replayed).toEqual({ outcome: "duplicate", runId, threadRef: "api:ops" });
    });

    it("refuses a reused intent id whose intent or target differs", async () => {
      const { serviceContext, sessionContext } = await setup();
      const runId = await startedRun(serviceContext);

      // `key-1` claimed the message that started the run; a stop under the
      // same id is a mismatched reuse, not a replay to answer.
      await expect(
        call(
          intentsRouter.submit,
          { intentId: "key-1", intent: { type: "stop", runId } },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "intent_mismatch" } });
      expect(await db.runStop.count({ where: { runId } })).toBe(0);

      // Same kind, different target: the second run's stop cannot ride the
      // first one's id.
      const second = await call(
        intentsRouter.submit,
        {
          locationRef: "ops",
          threadRef: "ops-2",
          intent: { type: "message", text: "Check the migration." },
          intentId: "key-2",
        },
        { context: serviceContext },
      );
      await call(
        intentsRouter.submit,
        { intentId: "stop-1", intent: { type: "stop", runId } },
        { context: sessionContext },
      );
      await expect(
        call(
          intentsRouter.submit,
          { intentId: "stop-1", intent: { type: "stop", runId: second.runId! } },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "intent_mismatch" } });
      expect(await db.runStop.count({ where: { runId: second.runId! } })).toBe(0);
    });

    it("records no stop fact on a run that reached terminal state first", async () => {
      const { serviceContext, engine, org, owner } = await setup();
      const runId = await startedRun(serviceContext);
      await db.agentRun.update({ where: { id: runId }, data: { state: "completed" } });

      // The route's pre-claim validation refuses this before dispatch; driving
      // the lifecycle directly exercises the atomic recheck that covers a run
      // finishing between that validation and the stop record.
      const services = servicesFor(org.id, engine);
      const result = await services.lifecycle.stop("stop-race", runId, {
        principalId: owner.id,
      });

      expect(result).toBe("run-not-active");
      expect(await db.runStop.count({ where: { runId } })).toBe(0);
    });

    it("rejects a target that disagrees with the intent's own reference", async () => {
      const { serviceContext, sessionContext } = await setup();
      const runId = await startedRun(serviceContext);

      await expect(
        call(
          intentsRouter.submit,
          {
            intentId: "stop-1",
            target: { runId: "someone-else" },
            intent: { type: "stop", runId },
          },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "target_mismatch" } });
    });

    it("refuses to stop a terminal run and to retry an active one", async () => {
      const { serviceContext, sessionContext } = await setup();
      const runId = await startedRun(serviceContext);

      await expect(
        call(
          intentsRouter.submit,
          { intentId: "retry-1", intent: { type: "retry", runId } },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "run_not_retryable" } });

      await db.agentRun.update({ where: { id: runId }, data: { state: "completed" } });
      await expect(
        call(
          intentsRouter.submit,
          { intentId: "stop-1", intent: { type: "stop", runId } },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "run_not_active" } });
    });

    it("retries a failed run as a new run on the same thread", async () => {
      const { serviceContext, sessionContext } = await setup();
      const runId = await startedRun(serviceContext);
      await db.agentRun.update({ where: { id: runId }, data: { state: "failed" } });

      const retried = await call(
        intentsRouter.submit,
        { intentId: "retry-1", intent: { type: "retry", runId } },
        { context: sessionContext },
      );

      expect(retried).toMatchObject({ outcome: "retried", threadRef: "api:ops" });
      expect(retried.runId).not.toBe(runId);
      const retry = await db.agentRun.findUniqueOrThrow({ where: { id: retried.runId! } });
      expect(retry).toMatchObject({ trigger: "retry", retryOfRunId: runId, threadRef: "api:ops" });
    });

    it("resolves an elicitation with the decision derived from the option", async () => {
      const { serviceContext, sessionContext, org } = await setup();
      const runId = await startedRun(serviceContext);
      await db.runElicitation.create({
        data: {
          id: "elic-1",
          orgId: org.id,
          runId,
          event: {
            type: "elicitation",
            elicitationId: "elic-1",
            kind: "choice",
            prompt: "Which environment?",
            reference: { callId: "call-1" },
            options: [
              { id: "staging", label: "Staging" },
              { id: "production", label: "Production" },
            ],
            blocking: true,
          },
        },
      });

      await expect(
        call(
          intentsRouter.submit,
          {
            intentId: "resolve-0",
            intent: { type: "resolve", elicitationId: "elic-1", optionId: "blue" },
          },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "unknown_option" } });

      const resolved = await call(
        intentsRouter.submit,
        {
          intentId: "resolve-1",
          target: { elicitationId: "elic-1" },
          intent: { type: "resolve", elicitationId: "elic-1", optionId: "staging" },
        },
        { context: sessionContext },
      );

      expect(resolved).toEqual({ outcome: "resolved", runId, threadRef: "api:ops" });
      const record = await db.runElicitation.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.id, id: "elic-1" } },
      });
      expect(record.resolution).toMatchObject({ optionId: "staging", decision: "answered" });
      const events = await db.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } });
      expect(events.map((row) => (row.event as { type: string }).type)).toContain(
        "elicitation-resolved",
      );

      // A second decision with a fresh intent id is a conflict, not a rewrite.
      await expect(
        call(
          intentsRouter.submit,
          {
            intentId: "resolve-2",
            intent: { type: "resolve", elicitationId: "elic-1", optionId: "production" },
          },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "elicitation_resolved" } });
    });

    it("records feedback as an audit fact without touching the run", async () => {
      const { serviceContext, sessionContext, org, owner } = await setup();
      const runId = await startedRun(serviceContext);

      const recorded = await call(
        intentsRouter.submit,
        {
          intentId: "feedback-1",
          intent: { type: "feedback", runId, verdict: "down", comment: "Wrong deploy." },
        },
        { context: sessionContext },
      );

      expect(recorded).toEqual({ outcome: "recorded", runId, threadRef: "api:ops" });
      const entry = await db.auditLog.findFirstOrThrow({
        where: { orgId: org.id, action: "run.feedback" },
      });
      expect(entry).toMatchObject({
        actorPrincipalId: owner.id,
        subject: runId,
        payload: { verdict: "down", comment: "Wrong deploy." },
      });
      // The run itself is untouched: same state, no new events.
      const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.state).toBe("queued");
    });

    it("answers a run outside the caller's view as if it did not exist", async () => {
      const { sessionContext, engine, org } = await setup();
      // A run in another member's personal scope: the org owner may audit its
      // existence, never act on it.
      const member = await db.principal.create({
        data: { orgId: org.id, kind: "human", displayName: "Someone Else" },
      });
      const services = servicesFor(org.id, engine);
      const started = await startRun({
        services,
        input: {
          intentId: "member-1",
          trigger: "message",
          surface: "web",
          locationRef: member.id,
          requester: { principalId: member.id },
          message: { role: "user", blocks: [{ type: "text", text: "Private errand." }] },
          author: { principalId: member.id, displayName: member.displayName },
          threadRef: "member-chat",
        },
      });

      await expect(
        call(
          intentsRouter.submit,
          { intentId: "stop-1", intent: { type: "stop", runId: started.runId! } },
          { context: sessionContext },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(db.runStop.count({ where: { runId: started.runId! } })).resolves.toBe(0);
    });

    it("serves the same target intents under a service credential", async () => {
      const { serviceContext } = await setup();
      const runId = await startedRun(serviceContext);

      const stopped = await call(
        intentsRouter.submit,
        { intentId: "stop-1", intent: { type: "stop", runId } },
        { context: serviceContext },
      );

      expect(stopped).toEqual({ outcome: "stopped", runId, threadRef: "api:ops" });
    });
  });

  describe("schedules", () => {
    async function activeSchedule(orgId: string, scopeId: string, cron = "*/5 * * * *") {
      const owner = await db.principal.findFirstOrThrow({ where: { orgId, kind: "human" } });
      const created = await createSchedule(db, {
        orgId,
        scopeId,
        cron,
        timezone: "UTC",
        prompt: "Summarize yesterday's deploys.",
        createdById: owner.id,
      });
      return setScheduleStatus(db, {
        orgId,
        scheduleId: created.id,
        status: "active",
        byPrincipalId: owner.id,
      });
    }

    it("fires a normal run in service mode with the schedule trigger", async () => {
      const { org, orgScope, engine } = await setup();
      const schedule = await activeSchedule(org.id, orgScope.id);
      const services = servicesFor(org.id, engine);

      const result = await tickSchedule({
        services,
        schedule: { ...schedule, lastTickAt: new Date("2026-07-19T12:04:00.000Z") },
        now: new Date("2026-07-19T12:05:30.000Z"),
      });

      expect(result).toMatchObject({ outcome: "started", skipped: 0 });
      const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId! } });
      expect(run).toMatchObject({ trigger: "schedule", threadRef: schedule.threadRef });
      const firing = await db.scheduleFiring.findFirstOrThrow({
        where: { scheduleId: schedule.id },
      });
      expect(firing).toMatchObject({ outcome: "started", runId: run.id });
      expect(
        (await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).lastFiredAt,
      ).toEqual(new Date("2026-07-19T12:05:00.000Z"));
    });

    it("skips and records a tick that overlaps the previous firing's run", async () => {
      const { org, orgScope, engine } = await setup();
      const schedule = await activeSchedule(org.id, orgScope.id);
      const services = servicesFor(org.id, engine);

      const first = await tickSchedule({
        services,
        schedule: { ...schedule, lastTickAt: new Date("2026-07-19T11:59:00.000Z") },
        now: new Date("2026-07-19T12:00:30.000Z"),
      });
      const reloaded = await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
      const second = await tickSchedule({
        services,
        schedule: reloaded,
        now: new Date("2026-07-19T12:05:30.000Z"),
      });

      expect(first.outcome).toBe("started");
      expect(second).toMatchObject({ outcome: "skipped_overlap", skipped: 1 });
      expect(await db.agentRun.count({ where: { threadRef: schedule.threadRef } })).toBe(1);
      expect(
        (await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).skippedCount,
      ).toBe(1);
      const firings = await db.scheduleFiring.findMany({
        where: { scheduleId: schedule.id },
        orderBy: { tickAt: "asc" },
      });
      expect(firings.map(({ outcome }) => outcome)).toEqual(["started", "skipped_overlap"]);
    });

    it("records the ticks it missed and starts no make-up runs", async () => {
      const { org, orgScope, engine } = await setup();
      const schedule = await activeSchedule(org.id, orgScope.id);
      const services = servicesFor(org.id, engine);

      const result = await tickSchedule({
        services,
        schedule: { ...schedule, lastTickAt: new Date("2026-07-19T11:00:00.000Z") },
        now: new Date("2026-07-19T12:00:30.000Z"),
      });

      expect(result).toMatchObject({ outcome: "started", skipped: 11 });
      expect(await db.agentRun.count({ where: { threadRef: schedule.threadRef } })).toBe(1);
      expect(
        (await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).skippedCount,
      ).toBe(11);
      expect(
        await db.scheduleFiring.count({
          where: { scheduleId: schedule.id, outcome: "skipped_missed" },
        }),
      ).toBe(11);
    });

    it("does nothing for a schedule that is not active", async () => {
      const { org, orgScope, engine } = await setup();
      const owner = await db.principal.findFirstOrThrow({
        where: { orgId: org.id, kind: "human" },
      });
      const proposed = await createSchedule(db, {
        orgId: org.id,
        scopeId: orgScope.id,
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "Summarize yesterday's deploys.",
        createdById: owner.id,
      });

      const result = await tickSchedule({
        services: servicesFor(org.id, engine),
        schedule: proposed,
        now: new Date("2026-07-19T12:05:30.000Z"),
      });

      expect(result).toEqual({ outcome: "inactive", skipped: 0 });
      expect(await db.agentRun.count()).toBe(0);
    });

    it("keeps the tool allowlist on the run it starts", async () => {
      const { org, orgScope, engine } = await setup();
      const owner = await db.principal.findFirstOrThrow({
        where: { orgId: org.id, kind: "human" },
      });
      const created = await createSchedule(db, {
        orgId: org.id,
        scopeId: orgScope.id,
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "Summarize yesterday's deploys.",
        createdById: owner.id,
        toolAllowlist: ["read_calendar"],
        status: "active",
        activatedById: owner.id,
      });

      const result = await tickSchedule({
        services: servicesFor(org.id, engine),
        schedule: { ...created, lastTickAt: new Date("2026-07-19T12:04:00.000Z") },
        now: new Date("2026-07-19T12:05:30.000Z"),
      });

      const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId! } });
      expect(run.toolAllowlist).toEqual(["read_calendar"]);
    });

    it("creates, activates, and archives a schedule through the API", async () => {
      const { adminContext, orgScope } = await setup();

      const created = await call(
        schedulesRouter.create,
        {
          scopeId: orgScope.id,
          cron: "0 9 * * 1-5",
          timezone: "Europe/Paris",
          prompt: "Post the standup summary.",
        },
        { context: adminContext },
      );
      expect(created).toMatchObject({ status: "proposed", activatedById: null });

      const activated = await call(
        schedulesRouter.setStatus,
        { id: created.id, status: "active" },
        { context: adminContext },
      );
      expect(activated.status).toBe("active");
      expect(activated.activatedById).not.toBeNull();

      const listed = await call(schedulesRouter.list, {}, { context: adminContext });
      expect(listed.schedules.map(({ id }) => id)).toEqual([created.id]);

      const archived = await call(
        schedulesRouter.setStatus,
        { id: created.id, status: "archived" },
        { context: adminContext },
      );
      expect(archived.status).toBe("archived");
      await expect(
        call(
          schedulesRouter.setStatus,
          { id: created.id, status: "active" },
          { context: adminContext },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("hides schedules in personal scopes the caller cannot read", async () => {
      const { adminContext, org } = await setup();
      const owner = await db.principal.findFirstOrThrow({
        where: { orgId: org.id, kind: "human" },
      });
      const personalScope = await db.scope.create({
        data: { orgId: org.id, kind: "personal", name: "Someone else", ownerId: null },
      });
      await createSchedule(db, {
        orgId: org.id,
        scopeId: personalScope.id,
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "A private errand.",
        createdById: owner.id,
      });

      const listed = await call(schedulesRouter.list, {}, { context: adminContext });

      // Personal scopes do not inherit org roles, so even the org owner cannot
      // list another principal's personal schedule.
      expect(listed.schedules).toEqual([]);
    });

    it("rejects an invalid cron expression and an unknown time zone", async () => {
      const { adminContext, orgScope } = await setup();

      for (const input of [
        { cron: "0 9 * *", timezone: "UTC" },
        { cron: "0 9 * * *", timezone: "Mars/Olympus" },
      ]) {
        await expect(
          call(
            schedulesRouter.create,
            { scopeId: orgScope.id, prompt: "Post the summary.", ...input },
            { context: adminContext },
          ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
    });
  });
});
