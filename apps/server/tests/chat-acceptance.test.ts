import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import type { Engine, RunEventData, TranscriptMessage, TurnResult, Usage } from "@trema/harness";
import { InMemoryEngine } from "@trema/harness";
import { FauxModelPort, type FauxTurnScript } from "@trema/harness/testing";
import { advance, type FoldInput, fold, type Part, type Projection } from "@trema/projection";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#server/app.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { orgRouter } from "#server/rpc/org.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import { createRunServices, type RunServices } from "#server/services/runs/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const origin = "http://chat.test";

const usage: Usage = {
  inputTokens: 3,
  outputTokens: 5,
  totalTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

function assistant(text: string): TranscriptMessage {
  return { role: "assistant", blocks: [{ type: "text", text }] };
}

function transcriptText(message: TranscriptMessage): string {
  return message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** One scripted turn that streams `text` and stops. */
function reply(text: string, blockId: string): FauxTurnScript {
  const events: RunEventData[] = [
    { type: "text-start", blockId },
    { type: "text-delta", blockId, delta: text },
    { type: "text-end", blockId },
  ];
  return {
    events,
    result: { message: assistant(text), toolCalls: [], stopReason: "stop", usage },
  };
}

/**
 * One scripted turn that narrates, then raises a blocking approval.
 *
 * The elicitation carries no `approvalId`: resolving one relays the decision
 * to the context app's data plane, which this deployment does not serve yet,
 * and the pause-and-resume contract under test is the same either way.
 */
function approvalPause(prompt: string, elicitationId: string, blockId: string): FauxTurnScript {
  const narration = "One moment.";
  const events: RunEventData[] = [
    { type: "text-start", blockId },
    { type: "text-delta", blockId, delta: narration },
    { type: "text-end", blockId },
    {
      type: "elicitation",
      elicitationId,
      kind: "approval",
      prompt,
      options: [
        { id: "approve", label: "Approve", scope: "once" },
        { id: "deny", label: "Deny", style: "danger", scope: "once" },
      ],
      blocking: true,
    },
  ];
  return {
    events,
    result: { message: assistant(narration), toolCalls: [], stopReason: "paused", usage },
  };
}

/** One scripted turn that ends in a model failure the loop records as run data. */
function failure(message: string): FauxTurnScript {
  return {
    events: [],
    result: {
      message: { role: "assistant", blocks: [] },
      toolCalls: [],
      stopReason: "error",
      usage,
      error: { message, retryable: false },
    },
  };
}

/**
 * One scripted turn that streams a first delta, then holds mid-stream until
 * the gate opens — the test's handle on "the run is live right now".
 */
function gated(
  gate: Promise<void>,
  blockId: string,
  delta: string,
  result: TurnResult,
): FauxTurnScript {
  return {
    events: (async function* () {
      yield { type: "text-start", blockId } as const;
      yield { type: "text-delta", blockId, delta } as const;
      await gate;
      yield { type: "text-end", blockId } as const;
    })(),
    result: gate.then(() => result),
  };
}

/** A one-line label per part, in log order — the shape assertions read. */
function partLabels(projection: Projection): string[] {
  return projection.segments.flatMap((segment) => segment.parts.map(partLabel));
}

function partLabel(part: Part): string {
  if (part.kind === "text") return `text:${part.markdown}`;
  if (part.kind === "steering") return `steering:${part.text}`;
  if (part.kind === "elicitation") return `elicitation:${part.elicitationId}`;
  return part.kind;
}

interface IntentResponse {
  runId: string | null;
  outcome: string;
  threadRef: string;
}

interface EventsPage {
  events: FoldInput[];
  cursor: number;
  hasMore: boolean;
  malformed: number;
}

/**
 * The web chat's acceptance path, driven exactly the way the browser drives
 * it: session-cookie auth, `POST /v1/intents` for every write, the run reads
 * and the SSE tail for everything rendered. The in-memory engine and the faux
 * model port are the only substitutions — the engine executes a worker-side
 * driver from the run id, as Hatchet does, while the API route composes its
 * own driverless services.
 */
integration("chat acceptance", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "chat-acceptance-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  });
  const auth = createAuth({ db, env });

  // Reassigned per test with that scenario's scripted turns; the worker's
  // `resolveModel` reads it at execution time, like the registry it stands for.
  let port = new FauxModelPort();

  const inMemory = new InMemoryEngine();
  const engines = new Map<string, Engine>();
  const workers = new Map<string, RunServices>();

  function workerFor(orgId: string): RunServices {
    let worker = workers.get(orgId);
    if (worker === undefined) {
      worker = createRunServices({
        db,
        env,
        orgId,
        engine: engineFor(orgId),
        resolveModel: async () => ({ modelPort: port, model: { id: "faux/turns" } }),
      });
      workers.set(orgId, worker);
    }
    return worker;
  }

  // The API process enqueues a run id; the worker reloads and executes it.
  // The in-memory engine underneath keeps one thread's tasks serial and lets
  // tests await quiescence, exactly like the reference engine everywhere else.
  function engineFor(orgId: string): Engine {
    let engine = engines.get(orgId);
    if (engine === undefined) {
      engine = {
        enqueue: (task) =>
          inMemory.enqueue({
            ...task,
            run: async () => {
              const driver = workerFor(orgId).driver;
              if (driver === undefined) throw new Error("worker composed no driver");
              await driver.execute(task.runId);
            },
          }),
      };
      engines.set(orgId, engine);
    }
    return engine;
  }

  const app = createApp({
    db,
    auth,
    env,
    runEngineFor: engineFor,
    runStream: { pollIntervalMs: 15, heartbeatIntervalMs: 60 },
  });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
    workers.clear();
    engines.clear();
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
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    return { user, cookie, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function setup() {
    const owner = await signUp("Chat Owner");
    const { org, principal } = await call(
      orgRouter.create,
      { name: "Chat Org" },
      { context: owner.context },
    );
    const orgScope = await db.scope.findFirstOrThrow({ where: { orgId: org.id, kind: "org" } });
    return { ...owner, org, principal, orgScope };
  }

  async function addMember(orgId: string, orgScopeId: string, name: string) {
    const member = await signUp(name);
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: member.user.id,
        displayName: name,
        email: member.user.email,
      },
    });
    await db.grant.create({
      data: { orgId, principalId: principal.id, scopeId: orgScopeId, role: "member" },
    });
    await db.session.updateMany({
      where: { userId: member.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...member, principal };
  }

  async function postIntent(cookie: string, body: unknown): Promise<Response> {
    return await app.fetch(
      new Request(`${origin}/api/v1/intents`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Submits an intent the way the composer does and expects the 202 fact. */
  async function submit(cookie: string, body: unknown): Promise<IntentResponse> {
    const response = await postIntent(cookie, body);
    expect(response.status).toBe(202);
    return (await response.json()) as IntentResponse;
  }

  async function getJson<T>(cookie: string, path: string): Promise<{ status: number; body: T }> {
    const response = await app.fetch(
      new Request(`${origin}/api/v1${path}`, { headers: { cookie } }),
    );
    return { status: response.status, body: (await response.json()) as T };
  }

  // The read is paged (`after`, `limit`), but the OpenAPI mount registers no
  // query coercion plugin, so a numeric query param is refused as input — the
  // typed `/rpc` client the web app uses is unaffected. Cursor advancement is
  // asserted client-side over the full read here; the SSE tail exercises the
  // server-side cursor via `Last-Event-ID`.
  async function readEvents(cookie: string, runId: string): Promise<EventsPage> {
    const { status, body } = await getJson<EventsPage>(cookie, `/runs/${runId}/events`);
    expect(status).toBe(200);
    return body;
  }

  /** Tails the SSE route from a cursor and returns the event frames it emits. */
  async function streamFrames(
    cookie: string,
    runId: string,
    lastEventId: string,
  ): Promise<FoldInput[]> {
    const response = await app.fetch(
      new Request(`${origin}/api/v1/runs/${runId}/stream`, {
        headers: { cookie, "last-event-id": lastEventId },
      }),
    );
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Stream response has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: FoldInput[] = [];
    const parseFrames = () => {
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const data = buffer
          .slice(0, boundary)
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (data) frames.push(JSON.parse(data) as FoldInput);
      }
    };
    // The route closes on terminal events; the deadline is the backstop so a
    // stream that never closes fails this test instead of hanging the runner.
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      void reader.cancel();
    }, 10_000);
    try {
      // A final read may carry bytes alongside `done`, and the decoder can
      // hold a partial code point until its flush — drain both before parsing
      // whatever the buffer still holds.
      for (let chunk = await reader.read(); ; chunk = await reader.read()) {
        if (chunk.value !== undefined) {
          buffer += decoder.decode(chunk.value, { stream: true });
          parseFrames();
        }
        if (chunk.done) break;
      }
    } finally {
      clearTimeout(deadline);
    }
    if (expired) throw new Error("SSE stream did not close within the deadline");
    buffer += decoder.decode();
    parseFrames();
    return frames;
  }

  /** Polls until the condition holds — how a test waits for a live run to reach a point. */
  async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  function streamedDelta(runId: string): () => Promise<boolean> {
    return async () =>
      (await db.runEvent.count({
        where: { runId, event: { path: ["type"], equals: "text-delta" } },
      })) > 0;
  }

  // Scenario 1: new chat → first message → run starts → reply streams into
  // the thread. The threadRef is client-minted and nothing is durable until
  // the first message intent lands.
  it("starts a run from a first message and streams the reply into the thread", async () => {
    const owner = await setup();
    port = new FauxModelPort([reply("Here is your week, planned.", "s1-b1")]);

    const accepted = await submit(owner.cookie, {
      intentId: "s1-m1",
      threadRef: "s1-chat",
      intent: { type: "message", text: "Plan my week." },
    });
    expect(accepted).toMatchObject({ outcome: "started", threadRef: "s1-chat" });
    const runId = accepted.runId;
    if (runId === null) throw new Error("started without a run id");

    await inMemory.idle();

    // The paged events read folds to the thread's rendering: the opening
    // message as steering, then the faux reply as the final text.
    const page = await readEvents(owner.cookie, runId);
    expect(page.hasMore).toBe(false);
    const projection = fold(runId, page.events);
    expect(projection.status).toBe("completed");
    expect(partLabels(projection)).toEqual([
      "steering:Plan my week.",
      "text:Here is your week, planned.",
    ]);

    // The SSE tail resumes from Last-Event-ID and the advanced fold is
    // byte-identical to folding the fresh full read.
    const seen = page.events.filter((event) => event.seq <= 2);
    const rest = await streamFrames(owner.cookie, runId, "2");
    expect(rest[0]?.seq).toBe(3);
    expect(advance(fold(runId, seen), rest)).toEqual(projection);

    // The thread-runs read lists the run with its derived opening message —
    // the timeline spine the chat renders.
    const listed = await getJson<{ runs: unknown[] }>(owner.cookie, "/threads/s1-chat/runs");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      runs: [
        {
          id: runId,
          state: "completed",
          trigger: "message",
          openingMessage: {
            author: { principalId: owner.principal.id },
            text: "Plan my week.",
          },
        },
      ],
    });
  });

  // Scenario 2: the second message on a thread reaches the model with the
  // first exchange in context — the thread-history derivation, asserted at
  // the model port seam.
  it("feeds the first exchange into the second run's model request", async () => {
    const owner = await setup();
    port = new FauxModelPort([reply("Tuesday is free.", "s2-b1"), reply("Booked.", "s2-b2")]);

    await submit(owner.cookie, {
      intentId: "s2-m1",
      threadRef: "s2-chat",
      intent: { type: "message", text: "What day is free?" },
    });
    await inMemory.idle();

    const second = await submit(owner.cookie, {
      intentId: "s2-m2",
      threadRef: "s2-chat",
      intent: { type: "message", text: "Book it." },
    });
    expect(second.outcome).toBe("started");
    await inMemory.idle();

    const request = port.turnRequests[1];
    if (request === undefined) throw new Error("the second run never reached the model");
    expect(
      request.messages.map((message) => ({ role: message.role, text: transcriptText(message) })),
    ).toEqual([
      { role: "user", text: "What day is free?" },
      { role: "assistant", text: "Tuesday is free." },
      { role: "user", text: "Book it." },
    ]);
  });

  // Scenario 3: a send during an active run classifies as steering, waits in
  // `queuedInput` until the drain point, lands as a `steering` event there,
  // and a mid-run reload folds to the identical history.
  it("steers a mid-run send, drains it in place, and refolds identically on reload", async () => {
    const owner = await setup();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    port = new FauxModelPort([
      gated(gate, "s3-b1", "Working on it.", {
        message: assistant("Working on it."),
        toolCalls: [],
        stopReason: "stop",
        usage,
      }),
      reply("Done, with the summary.", "s3-b2"),
    ]);

    const first = await submit(owner.cookie, {
      intentId: "s3-m1",
      threadRef: "s3-chat",
      intent: { type: "message", text: "Start the report." },
    });
    const runId = first.runId;
    if (runId === null) throw new Error("started without a run id");
    await until(streamedDelta(runId), "turn one to start streaming");

    const steer = await submit(owner.cookie, {
      intentId: "s3-m2",
      threadRef: "s3-chat",
      intent: { type: "message", text: "Add a summary too." },
    });
    expect(steer).toEqual({ outcome: "steered", runId, threadRef: "s3-chat" });

    // Before the drain, the run read carries the steer as queued input — what
    // a reload renders as the pending chip.
    const pending = await getJson<{ queuedInput: unknown[] }>(owner.cookie, `/runs/${runId}`);
    expect(pending.body).toMatchObject({
      access: "full",
      state: "running",
      queuedInput: [
        {
          id: "s3-m2",
          kind: "steering",
          text: "Add a summary too.",
          author: { principalId: owner.principal.id },
        },
      ],
    });

    // A mid-run reload: page A is what a client had before the run finished;
    // page B is what a later read from page A's cursor delivers.
    const pageA = await readEvents(owner.cookie, runId);
    open();
    await inMemory.idle();
    const pageB = (await readEvents(owner.cookie, runId)).events.filter(
      (event) => event.seq > pageA.cursor,
    );

    // Incremental advance and a fresh full refold are one history.
    const incremental = advance(fold(runId, pageA.events), pageB);
    const reloaded = fold(runId, (await readEvents(owner.cookie, runId)).events);
    expect(reloaded).toEqual(incremental);

    // The steering event landed at the drain point: after the answer it
    // arrived during, before the answer it shaped.
    expect(reloaded.status).toBe("completed");
    expect(partLabels(reloaded)).toEqual([
      "steering:Start the report.",
      "text:Working on it.",
      "steering:Add a summary too.",
      "text:Done, with the summary.",
    ]);

    // The drain emptied the queue.
    const drained = await getJson<{ queuedInput: unknown[] }>(owner.cookie, `/runs/${runId}`);
    expect(drained.body).toMatchObject({ queuedInput: [] });
  });

  // Scenario 4: a blocking approval parks the run — closed segment, pending
  // card — and a resolve resumes it with post-decision output in a fresh
  // segment. The chat and the run view submit the resolve through the same
  // endpoint with the same payload; the run view also mirrors the target in
  // the envelope, and both framings are accepted identically.
  it("parks on a blocking approval and resumes in a fresh segment when resolved", async () => {
    const owner = await setup();
    port = new FauxModelPort([
      approvalPause("Send the email?", "s4-e1", "s4-b1"),
      approvalPause("Send the follow-up too?", "s4-e2", "s4-b2"),
      reply("Both sent.", "s4-b3"),
    ]);

    const accepted = await submit(owner.cookie, {
      intentId: "s4-m1",
      threadRef: "s4-chat",
      intent: { type: "message", text: "Send the email." },
    });
    const runId = accepted.runId;
    if (runId === null) throw new Error("started without a run id");
    await inMemory.idle();

    await expect(db.agentRun.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({
      state: "awaiting_approval",
    });
    const paused = fold(runId, (await readEvents(owner.cookie, runId)).events);
    expect(paused.status).toBe("paused");
    expect(paused.segments).toHaveLength(1);
    expect(paused.segments[0]?.end).toEqual({ reason: "paused" });
    const card = paused.segments[0]?.parts.at(-1);
    if (card?.kind !== "elicitation") throw new Error("the pause left no elicitation part");
    expect(card).toMatchObject({ elicitationId: "s4-e1", blocking: true });
    expect(card.resolution).toBeUndefined();

    // Resolved the way the chat frames it: the intent alone.
    const fromChat = await submit(owner.cookie, {
      intentId: "s4-r1",
      intent: { type: "resolve", elicitationId: "s4-e1", optionId: "approve" },
    });
    expect(fromChat).toEqual({ outcome: "resolved", runId, threadRef: "s4-chat" });
    await inMemory.idle();

    // Resolved the way the run view frames it: same endpoint, same payload,
    // the target mirrored in the envelope. Accepted identically.
    const fromRunView = await submit(owner.cookie, {
      intentId: "s4-r2",
      target: { elicitationId: "s4-e2" },
      intent: { type: "resolve", elicitationId: "s4-e2", optionId: "approve" },
    });
    expect(fromRunView).toEqual({ outcome: "resolved", runId, threadRef: "s4-chat" });
    await inMemory.idle();

    const final = fold(runId, (await readEvents(owner.cookie, runId)).events);
    expect(final.status).toBe("completed");
    // Each pause closed its segment; the post-decision output opened a new one.
    expect(final.segments.map((segment) => segment.end?.reason)).toEqual([
      "paused",
      "paused",
      undefined,
    ]);
    expect(final.segments[2]?.parts.map(partLabel)).toEqual(["text:Both sent."]);
    // The resolutions mutated the cards in place, inside their closed segments.
    const resolvedCard = final.segments[0]?.parts.at(-1);
    if (resolvedCard?.kind !== "elicitation") throw new Error("the resolved card is gone");
    expect(resolvedCard.resolution).toMatchObject({
      optionId: "approve",
      by: { principalId: owner.principal.id },
    });
  });

  // Scenario 5, stop: the stop fact is durably recorded before the 2xx, and
  // the run reaches cancelled with `run-finished(cancelled)` on the log.
  it("stops an active run, recording the stop fact before the cancellation", async () => {
    const owner = await setup();
    let abortTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      abortTurn = resolve;
    });
    // The route records the stop; a provider port then ends the in-flight
    // turn as aborted when its abort signal fires. The lifecycle's abort
    // controller lives in the process executing the loop, so the scripted
    // port stands in for that signal here: the test releases it only after
    // the stop fact has landed, which is the ordering the contract requires.
    port = new FauxModelPort([
      gated(gate, "s5-b1", "Deleting everyth—", {
        message: { role: "assistant", blocks: [] },
        toolCalls: [],
        stopReason: "aborted",
        usage,
      }),
    ]);

    const accepted = await submit(owner.cookie, {
      intentId: "s5-m1",
      threadRef: "s5-stop",
      intent: { type: "message", text: "Clean up the archive." },
    });
    const runId = accepted.runId;
    if (runId === null) throw new Error("started without a run id");
    await until(streamedDelta(runId), "the run to start streaming");

    const stopped = await submit(owner.cookie, {
      intentId: "s5-stop",
      target: { runId },
      intent: { type: "stop", runId },
    });
    expect(stopped).toEqual({ outcome: "stopped", runId, threadRef: "s5-stop" });
    // The 2xx reported a recorded fact, not a promise.
    await expect(db.runStop.findUniqueOrThrow({ where: { runId } })).resolves.toMatchObject({
      intentId: "s5-stop",
    });

    abortTurn();
    await inMemory.idle();

    await expect(db.agentRun.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({
      state: "cancelled",
    });
    const projection = fold(runId, (await readEvents(owner.cookie, runId)).events);
    expect(projection.status).toBe("cancelled");
  });

  // Scenario 5, retry: a failed run retries as a new run on the same thread.
  it("retries a failed run as a new run on the same thread", async () => {
    const owner = await setup();
    port = new FauxModelPort([failure("model provider exploded")]);

    const accepted = await submit(owner.cookie, {
      intentId: "s5-m2",
      threadRef: "s5-retry",
      intent: { type: "message", text: "Try the thing." },
    });
    const runId = accepted.runId;
    if (runId === null) throw new Error("started without a run id");
    await inMemory.idle();
    await expect(db.agentRun.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({
      state: "failed",
      error: "model provider exploded",
    });

    const retried = await submit(owner.cookie, {
      intentId: "s5-r1",
      intent: { type: "retry", runId },
    });
    expect(retried).toMatchObject({ outcome: "retried", threadRef: "s5-retry" });
    expect(retried.runId).not.toBeNull();
    expect(retried.runId).not.toBe(runId);
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: retried.runId! } }),
    ).resolves.toMatchObject({
      trigger: "retry",
      retryOfRunId: runId,
      retryAttempt: 1,
      threadRef: "s5-retry",
    });

    // Known limitation, documented in the PR: the retry run reuses its failed
    // predecessor's session, which the failure already closed, so execution
    // fails at start — and even recording that failure trips over closing the
    // closed session again, which the engine surfaces here. The classification
    // above is the contract this scenario pins; the execution gap — a retry
    // needs a fresh or reopened session — is a separate fix, not papered over
    // here.
    await expect(inMemory.idle()).rejects.toThrow("Session is already closed");
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: retried.runId! } }),
    ).resolves.toMatchObject({
      state: "failed",
      error: expect.stringContaining("context session is closed"),
    });
  });

  // Scenario 5, duplicate: a replayed `intentId` returns `duplicate` with the
  // original routing and creates nothing new.
  it("answers a replayed intent id with the original outcome", async () => {
    const owner = await setup();
    port = new FauxModelPort([reply("On it.", "s5-b2")]);
    const body = {
      intentId: "s5-dup",
      threadRef: "s5-dup-chat",
      intent: { type: "message", text: "Ship it." },
    };

    const first = await submit(owner.cookie, body);
    expect(first.outcome).toBe("started");

    const replayed = await submit(owner.cookie, body);
    expect(replayed).toEqual({
      outcome: "duplicate",
      runId: first.runId,
      threadRef: "s5-dup-chat",
    });
    expect(await db.agentRun.count({ where: { threadRef: "s5-dup-chat" } })).toBe(1);
    await inMemory.idle();
  });

  // Scenario 5, personal scopes off: the structured FORBIDDEN the chat region
  // renders in place of the composer.
  it("refuses chat with the structured error when personal scopes are disabled", async () => {
    const owner = await setup();
    await call(scopesRouter.setPersonalPolicy, { enabled: false }, { context: owner.context });

    const response = await postIntent(owner.cookie, {
      intentId: "s5-p1",
      intent: { type: "message", text: "Anyone there?" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      data: { code: "personal_scopes_disabled" },
    });
  });

  // Scenario 5, the admin view: an org admin reading a member's web thread
  // gets audit metadata on the run, nothing from the content reads, and a
  // target intent refused exactly like a run that does not exist.
  it("gives an org admin only the audit view of a member's thread", async () => {
    const owner = await setup();
    const alice = await addMember(owner.org.id, owner.orgScope.id, "Alice");
    port = new FauxModelPort([reply("A private answer.", "s5-b3")]);

    const accepted = await submit(alice.cookie, {
      intentId: "s5-a1",
      threadRef: "alice-chat",
      intent: { type: "message", text: "A private errand." },
    });
    const runId = accepted.runId;
    if (runId === null) throw new Error("started without a run id");
    await inMemory.idle();

    // The run read: metadata only — that it happened and which tools it
    // called, never thread, grant, or queued content.
    const metadata = await getJson<Record<string, unknown>>(owner.cookie, `/runs/${runId}`);
    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({
      access: "metadata",
      id: runId,
      state: "completed",
      trigger: "message",
      toolNames: [],
    });
    expect(metadata.body).not.toHaveProperty("threadRef");
    expect(metadata.body).not.toHaveProperty("queuedInput");
    expect(metadata.body).not.toHaveProperty("grantSnapshot");

    // The thread list hides runs the caller may not fully read: the member's
    // thread is indistinguishable from an empty one.
    const listed = await getJson<unknown>(owner.cookie, "/threads/alice-chat/runs");
    expect(listed.body).toEqual({ runs: [] });

    // The event log and the SSE tail are content: the refusal is the same
    // 404 a missing run gets.
    const events = await getJson<unknown>(owner.cookie, `/runs/${runId}/events`);
    expect(events.status).toBe(404);
    const stream = await app.fetch(
      new Request(`${origin}/api/v1/runs/${runId}/stream`, { headers: { cookie: owner.cookie } }),
    );
    expect(stream.status).toBe(404);

    // A target intent from the admin finds nothing to act on.
    const stopResponse = await postIntent(owner.cookie, {
      intentId: "s5-a2",
      intent: { type: "stop", runId },
    });
    expect(stopResponse.status).toBe(404);
    expect(await stopResponse.json()).toMatchObject({ message: "Run not found" });

    // The owner of the thread keeps the full view.
    const own = await getJson<unknown>(alice.cookie, `/runs/${runId}`);
    expect(own.body).toMatchObject({ access: "full", threadRef: "alice-chat" });
  });
});
