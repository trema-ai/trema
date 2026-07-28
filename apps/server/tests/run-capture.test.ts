import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import type { ModelPort, RunEventData, TurnResult, Usage } from "@trema/harness";
import { InMemoryEngine } from "@trema/harness";
import { FauxModelPort } from "@trema/harness/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { orgRouter } from "#server/rpc/org.js";
import { createRunServices, startRun } from "#server/services/runs/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const usage: Usage = {
  inputTokens: 2,
  outputTokens: 2,
  totalTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

function answer(text: string): TurnResult {
  return {
    message: { role: "assistant", blocks: [{ type: "text", text }] },
    toolCalls: [],
    stopReason: "stop",
    usage,
  };
}

function textEvents(blockId: string, text: string): RunEventData[] {
  return [
    { type: "text-start", blockId },
    { type: "text-delta", blockId, delta: text },
    { type: "text-end", blockId },
  ];
}

/**
 * The opening message reaches the conversation store the moment its run
 * starts, driven the way the worker drives it: dispatch through `startRun`,
 * the in-memory engine standing in for Hatchet, and a scripted model port.
 */
integration("opening message capture", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "capture-integration-secret-at-least-32-characters",
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

  async function setup() {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "Capture Owner", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const context = { db, auth, env, headers: new Headers({ cookie }) };

    const { org, principal } = await call(orgRouter.create, { name: "Capture Org" }, { context });
    const orgScope = await db.scope.findFirstOrThrow({ where: { orgId: org.id, kind: "org" } });
    await call(
      bindingsRouter.create,
      { surface: "api", locationRef: "ops", scopeId: orgScope.id },
      { context },
    );
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.id, kind: "agent" },
    });
    return { org, orgScope, owner: principal, agent };
  }

  function servicesFor(orgId: string, engine: InMemoryEngine, modelPort: ModelPort) {
    return createRunServices({
      db,
      env,
      orgId,
      engine,
      resolveModel: async () => ({ model: { id: "test/model" }, modelPort }),
    });
  }

  it("shows the thread with the person's message as soon as the run starts", async () => {
    const { org, orgScope, owner } = await setup();
    let messagesAtFirstTurn = -1;
    const modelPort = new FauxModelPort([
      {
        // Read inside the turn, so the assertion is about the running run and
        // not about what the finished one left behind.
        events: (async function* () {
          messagesAtFirstTurn = await db.message.count({ where: { orgId: org.id } });
          yield* textEvents("text-1", "Looking.");
        })(),
        result: answer("Looking."),
      },
    ]);
    const engine = new InMemoryEngine();

    const started = await startRun({
      services: servicesFor(org.id, engine, modelPort),
      input: {
        intentId: "intent-1",
        trigger: "api",
        surface: "api",
        locationRef: "ops",
        threadRef: "chat-1",
        requester: { principalId: owner.id },
        message: { role: "user", blocks: [{ type: "text", text: "Check the deploy." }] },
        author: { principalId: owner.id, displayName: "Capture Owner" },
      },
    });
    await engine.idle();

    expect(started.outcome).toBe("started");
    expect(messagesAtFirstTurn).toBe(1);
    const conversation = await db.conversation.findFirstOrThrow({ where: { orgId: org.id } });
    expect(conversation).toMatchObject({
      surface: "api",
      locationRef: "ops",
      threadRef: "chat-1",
      scopeId: orgScope.id,
    });
    const messages = await db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { seq: "asc" },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      seq: 1,
      surfaceMessageRef: "intent-1",
      authorPrincipalId: owner.id,
      text: "Check the deploy.",
    });
  });

  it("reports the same message once when the run is executed again", async () => {
    const { org, owner } = await setup();
    const scripted = new FauxModelPort([
      { events: textEvents("text-1", "Looking."), result: answer("Looking.") },
    ]);
    let turns = 0;
    const modelPort: ModelPort = {
      streamTurn: (request) => {
        turns += 1;
        // The first execution dies mid-turn, the way a worker does. Its run
        // row stays running and the engine delivers the run again.
        if (turns === 1) throw new Error("provider unreachable");
        return scripted.streamTurn(request);
      },
      complete: (request) => scripted.complete(request),
    };
    const engine = new InMemoryEngine();
    const services = servicesFor(org.id, engine, modelPort);

    const started = await startRun({
      services,
      input: {
        intentId: "intent-1",
        trigger: "api",
        surface: "api",
        locationRef: "ops",
        threadRef: "chat-1",
        requester: { principalId: owner.id },
        message: { role: "user", blocks: [{ type: "text", text: "Check the deploy." }] },
        author: { principalId: owner.id, displayName: "Capture Owner" },
      },
    });
    await expect(engine.idle()).rejects.toThrow("provider unreachable");

    const redelivered = await services.driver!.execute(started.runId!);

    expect(redelivered).toMatchObject({ status: "finished" });
    expect(await db.conversation.count({ where: { orgId: org.id } })).toBe(1);
    const messages = await db.message.findMany({ where: { orgId: org.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ surfaceMessageRef: "intent-1", seq: 1 });
  });

  it("captures nothing for a run no person asked for", async () => {
    const { org, agent } = await setup();
    const modelPort = new FauxModelPort([
      { events: textEvents("text-1", "Done."), result: answer("Done.") },
    ]);
    const engine = new InMemoryEngine();

    await startRun({
      services: servicesFor(org.id, engine, modelPort),
      input: {
        intentId: "intent-1",
        trigger: "schedule",
        surface: "api",
        locationRef: "ops",
        message: { role: "user", blocks: [{ type: "text", text: "Summarize the deploys." }] },
        author: { principalId: agent.id, displayName: "Agent" },
      },
    });
    await engine.idle();

    // A schedule talking to itself is not a conversation.
    expect(await db.conversation.count({ where: { orgId: org.id } })).toBe(0);
  });
});
