import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#server/app.js";
import type { Principal, Role, RunState } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { orgRouter } from "#server/rpc/org.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

/** One parsed SSE frame: whatever fields the block carried. */
interface SseFrame {
  id?: string;
  data?: string;
  comments: string[];
}

function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = { comments: [] };
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comments.push(line.slice(1).trim());
    } else if (line.startsWith("data: ")) {
      const chunk = line.slice("data: ".length);
      frame.data = frame.data === undefined ? chunk : `${frame.data}\n${chunk}`;
    } else if (line.startsWith("id: ")) {
      frame.id = line.slice("id: ".length);
    }
  }
  return frame;
}

/**
 * Reads SSE frames off a streaming response body incrementally — the stream
 * may be infinite, so nothing here ever awaits the full text.
 */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private frames: SseFrame[] = [];
  private done = false;

  constructor(response: Response) {
    if (!response.body) throw new Error("Response has no body to stream");
    this.reader = response.body.getReader();
  }

  /** The next frame, or null once the stream has closed. */
  async next(): Promise<SseFrame | null> {
    while (this.frames.length === 0) {
      if (this.done) return null;
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
      let boundary = this.buffer.indexOf("\n\n");
      while (boundary >= 0) {
        this.frames.push(parseFrame(this.buffer.slice(0, boundary)));
        this.buffer = this.buffer.slice(boundary + 2);
        boundary = this.buffer.indexOf("\n\n");
      }
    }
    return this.frames.shift() ?? null;
  }

  /** Every remaining frame until the server closes the stream. */
  async rest(): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    for (let frame = await this.next(); frame !== null; frame = await this.next()) {
      frames.push(frame);
    }
    return frames;
  }

  async cancel(): Promise<void> {
    this.done = true;
    await this.reader.cancel();
  }
}

integration("run event stream", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "run-stream-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  });
  const auth = createAuth({ db, env });
  // Short cadence so a test never sleeps real seconds; the heartbeat stays
  // above the poll interval, mirroring production proportions.
  const app = createApp({
    db,
    auth,
    env,
    runStream: { pollIntervalMs: 15, heartbeatIntervalMs: 60 },
  });

  // Streams a test failed to drain would keep the poll loop — and the test
  // process — alive; every reader registers here and is cancelled after.
  const openReaders: SseReader[] = [];
  function tail(response: Response): SseReader {
    const reader = new SseReader(response);
    openReaders.push(reader);
    return reader;
  }

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterEach(async () => {
    await Promise.all(openReaders.splice(0).map((reader) => reader.cancel()));
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
    return { user, cookie, context: { db, auth, env, headers: new Headers({ cookie }) } };
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

  async function openSession(orgId: string, scopeId: string, agent: Principal) {
    return db.contextSession.create({
      data: {
        orgId,
        scopeId,
        surface: "web",
        locationRef: "member-1",
        mode: "service",
        scopeChain: [scopeId],
        actingPrincipalId: agent.id,
        standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
        policySnapshot: {},
        snapshotHash: "snapshot-hash-1",
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  async function createRun(options: { orgId: string; sessionId: string; state?: RunState }) {
    return db.agentRun.create({
      data: {
        id: `run-${randomUUID()}`,
        orgId: options.orgId,
        threadRef: "web:alice",
        state: options.state ?? "running",
        trigger: "message",
        sessionId: options.sessionId,
      },
    });
  }

  /** Appends events after the run's current tail and advances `lastEventSeq`. */
  async function appendEvents(orgId: string, runId: string, events: unknown[]) {
    const run = await db.agentRun.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: runId } },
      select: { lastEventSeq: true },
    });
    let seq = run.lastEventSeq;
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

  const finished = { type: "run-finished", outcome: "completed" };

  /** An org with Alice (a member owning a personal scope) and a live run of hers. */
  async function setup(state: RunState = "running") {
    const org = await createOrg();
    const alice = await addMember(org.org.id, org.orgScope.id, "member", "Alice");
    const bob = await addMember(org.org.id, org.orgScope.id, "member", "Bob");
    const scope = await db.scope.create({
      data: { orgId: org.org.id, kind: "personal", name: "Alice", ownerId: alice.principal.id },
    });
    const session = await openSession(org.org.id, scope.id, org.agent);
    const run = await createRun({ orgId: org.org.id, sessionId: session.id, state });
    return { org, alice, bob, scope, session, run };
  }

  function stream(
    runId: string,
    cookie: string,
    options: { query?: string; lastEventId?: string } = {},
  ) {
    return app.request(`/api/v1/runs/${runId}/stream${options.query ?? ""}`, {
      headers: {
        cookie,
        ...(options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId }),
      },
    });
  }

  it("streams the backlog and closes on run-finished, payloads matching the paged read", async () => {
    const { org, alice, run } = await setup("completed");
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      steering(alice.principal.id, "Check the deploy."),
      { type: "text-start", blockId: "b1" },
      { type: "text-delta", blockId: "b1", delta: "Deployed." },
      { type: "text-end", blockId: "b1" },
      finished,
    ]);

    const response = await stream(run.id, alice.cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const frames = await tail(response).rest();
    const events = frames.filter((frame) => frame.data !== undefined);
    expect(events.map(({ id }) => id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    const envelopes = events.map((frame) => JSON.parse(frame.data!) as Record<string, unknown>);
    expect(envelopes[0]).toMatchObject({
      seq: 1,
      event: { type: "run-started", trigger: "message" },
    });
    expect(envelopes[1]?.event).toEqual(steering(alice.principal.id, "Check the deploy."));
    expect(typeof envelopes[0]?.at).toBe("string");
    expect(envelopes[5]?.event).toEqual(finished);
  });

  it("picks up events appended after the stream starts, then closes", async () => {
    const { org, alice, run } = await setup("running");
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      steering(alice.principal.id, "First."),
    ]);

    const reader = tail(await stream(run.id, alice.cookie));
    expect((await reader.next())?.id).toBe("1");
    expect((await reader.next())?.id).toBe("2");

    // The run moves while the stream is attached: a later poll must see it.
    await appendEvents(org.org.id, run.id, [{ type: "text-start", blockId: "b1" }, finished]);
    await db.agentRun.update({
      where: { orgId_id: { orgId: org.org.id, id: run.id } },
      data: { state: "completed" },
    });

    const frames = (await reader.rest()).filter((frame) => frame.data !== undefined);
    expect(frames.map(({ id }) => id)).toEqual(["3", "4"]);
    expect((JSON.parse(frames[1]!.data!) as { event: unknown }).event).toEqual(finished);
  });

  it("resumes from Last-Event-ID, which beats the after query param", async () => {
    const { org, alice, run } = await setup("completed");
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      { type: "text-start", blockId: "b1" },
      finished,
    ]);

    const response = await stream(run.id, alice.cookie, { query: "?after=0", lastEventId: "2" });

    const frames = (await tail(response).rest()).filter((frame) => frame.data !== undefined);
    expect(frames.map(({ id }) => id)).toEqual(["3"]);
  });

  it("starts from the after query param when no Last-Event-ID is sent", async () => {
    const { org, alice, run } = await setup("completed");
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      { type: "text-start", blockId: "b1" },
      finished,
    ]);

    const response = await stream(run.id, alice.cookie, { query: "?after=1" });

    const frames = (await tail(response).rest()).filter((frame) => frame.data !== undefined);
    expect(frames.map(({ id }) => id)).toEqual(["2", "3"]);
  });

  it("closes a terminal run whose log has no run-finished event", async () => {
    const { org, alice, run } = await setup("stale");
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      { type: "text-start", blockId: "b1" },
    ]);

    const frames = (await tail(await stream(run.id, alice.cookie)).rest()).filter(
      (frame) => frame.data !== undefined,
    );

    expect(frames.map(({ id }) => id)).toEqual(["1", "2"]);
  });

  it("passes unknown event types through and skips malformed known events", async () => {
    const { org, alice, run } = await setup("completed");
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      { type: "telemetry-blip", detail: { spanId: "s1" } },
      // A known type with an invalid payload: skipped, never emitted.
      { type: "steering", text: 42 },
      finished,
    ]);

    const frames = (await tail(await stream(run.id, alice.cookie)).rest()).filter(
      (frame) => frame.data !== undefined,
    );

    expect(frames.map(({ id }) => id)).toEqual(["1", "2", "4"]);
    expect((JSON.parse(frames[1]!.data!) as { event: unknown }).event).toEqual({
      type: "telemetry-blip",
      detail: { spanId: "s1" },
    });
  });

  it("heartbeats while the run is quiet", async () => {
    const { org, alice, run } = await setup("running");
    await appendEvents(org.org.id, run.id, [{ type: "run-started", trigger: "message" }]);

    const reader = tail(await stream(run.id, alice.cookie));
    expect((await reader.next())?.id).toBe("1");

    // Nothing new arrives, so the next full frame is the keep-alive comment.
    const frame = await reader.next();
    expect(frame?.comments).toContain("ping");
    expect(frame?.data).toBeUndefined();

    await reader.cancel();
  });

  it("stops polling promptly when the client disconnects", async () => {
    const { org, alice, run } = await setup("running");
    await appendEvents(org.org.id, run.id, [{ type: "run-started", trigger: "message" }]);

    const reader = tail(await stream(run.id, alice.cookie));
    expect((await reader.next())?.id).toBe("1");

    // Cancelling the body is the client hanging up; the poll loop must wind
    // down on its own — a leaked timer would hang the suite, not a test.
    await reader.cancel();
  });

  it("refuses a run the caller may not stream exactly like a missing one", async () => {
    const { org, bob, run } = await setup("running");

    // Bob holds nothing on Alice's personal scope; the org owner holds audit
    // metadata, which streams nothing; and the missing run is the baseline.
    const refusals = await Promise.all([
      stream(run.id, bob.cookie),
      stream(run.id, org.cookie),
      stream("run-missing", bob.cookie),
    ]);

    for (const refusal of refusals) {
      expect(refusal.status).toBe(404);
      expect(refusal.headers.get("content-type")).toContain("application/json");
      await expect(refusal.json()).resolves.toEqual({ error: "Run not found" });
    }
  });

  it("requires a signed-in session", async () => {
    const { run } = await setup("running");

    const response = await app.request(`/api/v1/runs/${run.id}/stream`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
  });
});
