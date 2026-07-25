import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { InMemoryEngine } from "@trema/harness";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { orgRouter } from "#server/rpc/org.js";
import { runsRouter } from "#server/rpc/runs.js";
import { schedulesRouter } from "#server/rpc/schedules.js";
import type { RunServices } from "#server/services/runs/index.js";
import { createRunServices } from "#server/services/runs/index.js";
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
    return { adminContext: context, serviceContext, engine, org: membership.org, orgScope };
  }

  // No model is configured, so the services compose no driver: these tests
  // assert where a message lands, not what the loop does with it.
  function servicesFor(orgId: string, engine: InMemoryEngine): RunServices {
    return createRunServices({ db, env, orgId, engine });
  }

  describe("POST /runs", () => {
    it("starts a run and reports where the message landed", async () => {
      const { serviceContext } = await setup();

      const accepted = await call(
        runsRouter.create,
        { locationRef: "ops", message: "Check the deploy.", idempotencyKey: "key-1" },
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

    it("answers a repeated idempotency key with the run the first call made", async () => {
      const { serviceContext } = await setup();
      const first = await call(
        runsRouter.create,
        { locationRef: "ops", message: "Check the deploy.", idempotencyKey: "key-1" },
        { context: serviceContext },
      );

      const second = await call(
        runsRouter.create,
        { locationRef: "ops", message: "Check the deploy.", idempotencyKey: "key-1" },
        { context: serviceContext },
      );

      expect(second).toEqual({ outcome: "duplicate", runId: first.runId, threadRef: "api:ops" });
      expect(await db.agentRun.count()).toBe(1);
    });

    it("steers the active run instead of starting a second one on the thread", async () => {
      const { serviceContext } = await setup();
      const first = await call(
        runsRouter.create,
        { locationRef: "ops", message: "Check the deploy.", idempotencyKey: "key-1" },
        { context: serviceContext },
      );

      const second = await call(
        runsRouter.create,
        { locationRef: "ops", message: "And the migration.", idempotencyKey: "key-2" },
        { context: serviceContext },
      );

      expect(second).toEqual({ outcome: "steered", runId: first.runId, threadRef: "api:ops" });
      expect(await db.agentRun.count()).toBe(1);
      expect(await db.runQueuedInput.count({ where: { runId: first.runId } })).toBe(2);
    });

    it("reclaims an idempotency key whose claiming call died before routing", async () => {
      const { serviceContext, org } = await setup();
      // A claim with no recorded run, old enough that its call cannot still be
      // routing: the crash left the key consumed and the message lost.
      await db.runIntent.create({
        data: {
          id: "key-1",
          orgId: org.id,
          createdAt: new Date(Date.now() - 5 * 60_000),
        },
      });

      const accepted = await call(
        runsRouter.create,
        { locationRef: "ops", message: "Check the deploy.", idempotencyKey: "key-1" },
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
          runsRouter.create,
          { locationRef: "unbound", message: "Anyone there?", idempotencyKey: "key-1" },
          { context: serviceContext },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
