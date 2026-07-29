import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { InMemoryEngine, type ToolCall, type TranscriptMessage, type Usage } from "@trema/harness";
import { FauxModelPort } from "@trema/harness/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalMode, Prisma } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { orgRouter } from "#server/rpc/org.js";
import { createDataPlaneToolExecutor } from "#server/services/dataplane/executor.js";
import { connectorModelToolName } from "#server/services/dataplane/tools.js";
import type { Embedder } from "#server/services/embeddings/index.js";
import { putDefaults, putProvider } from "#server/services/model-providers/index.js";
import { createRunServices } from "#server/services/runs/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 41).toString("base64");
const connectorToken = "run-connector-secret";

const usage: Usage = {
  inputTokens: 3,
  outputTokens: 5,
  totalTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

function assistant(blocks: TranscriptMessage["blocks"]): TranscriptMessage {
  return { role: "assistant", blocks };
}

function modelFor(call: ToolCall, searchQuery: string): FauxModelPort {
  const searchCall = {
    callId: `${call.callId}-search`,
    name: "search_tools",
    input: { query: searchQuery },
  };
  return new FauxModelPort([
    {
      events: [],
      result: {
        message: assistant([
          {
            type: "toolCall",
            callId: searchCall.callId,
            name: searchCall.name,
            input: searchCall.input,
          },
        ]),
        toolCalls: [searchCall],
        stopReason: "toolUse",
        usage,
      },
    },
    {
      events: [],
      result: {
        message: assistant([
          {
            type: "toolCall",
            callId: call.callId,
            name: call.name,
            input: call.input,
          },
        ]),
        toolCalls: [call],
        stopReason: "toolUse",
        usage,
      },
    },
    {
      events: [],
      result: {
        message: assistant([{ type: "text", text: "Done." }]),
        toolCalls: [],
        stopReason: "stop",
        usage,
      },
    },
  ]);
}

integration("in-process connector execution", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "run-connectors-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
    TREMA_CREDENTIAL_MASTER_KEY: masterKey,
  });
  const auth = createAuth({ db, env });
  const providerCalls: { authorization: string | null }[] = [];

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
    providerCalls.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function setup(input: { install?: boolean } = {}) {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "Run Connector Owner", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const context = { db, auth, env, headers: new Headers({ cookie }) };
    const { org, principal: owner } = await call(
      orgRouter.create,
      { name: "Run Connector Org" },
      { context },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: org.id, kind: "org" },
    });
    await call(
      bindingsRouter.create,
      { surface: "api", locationRef: "ops", scopeId: orgScope.id },
      { context },
    );
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.id, kind: "agent" },
    });
    const connection = await db.connectorConnection.create({
      data: {
        orgId: org.id,
        principalId: agent.id,
        providerKey: "google_workspace",
        mode: "oauth2_code",
        config: {},
        ciphertext: encryptEnvelope({ accessToken: connectorToken }, masterKey),
      },
    });
    const install = () =>
      db.item.create({
        data: {
          orgId: org.id,
          scopeId: orgScope.id,
          kind: "connector",
          title: "google_workspace",
          body: {
            catalogKey: "google_workspace",
            connectionId: connection.id,
            enabledTools: "all",
          } satisfies Prisma.InputJsonObject,
          status: "active",
          disclosure: "retrieved",
          createdById: owner.id,
        },
      });
    const installation = input.install === false ? null : await install();
    return { org, orgScope, owner, installation, install };
  }

  async function executeCall(
    fixture: Awaited<ReturnType<typeof setup>>,
    call: ToolCall,
    approvalMode: ApprovalMode = "ask",
    searchQuery = "draft",
    embedder?: Embedder,
    afterOpen?: () => Promise<void>,
  ) {
    const port = modelFor(call, searchQuery);
    const engine = new InMemoryEngine();
    const services = createRunServices({
      db,
      env,
      orgId: fixture.org.id,
      engine,
      resolveModel: async () => ({ model: { id: "faux/connectors" }, modelPort: port }),
      toolExecutorForSession: (session) =>
        createDataPlaneToolExecutor(
          {
            db,
            masterKey,
            ...(embedder === undefined ? {} : { embedder }),
            fetch: async (_url, init) => {
              const authorization = new Headers(init?.headers).get("authorization");
              providerCalls.push({ authorization });
              return Response.json({
                id: "draft-from-run",
                requestAuthorization: authorization,
              });
            },
          },
          session,
        ),
    });
    const snapshot = await services.context.open({
      surface: "api",
      locationRef: "ops",
      threadRef: `thread-${call.callId}`,
      requester: { principalId: fixture.owner.id },
    });
    if (approvalMode === "full") {
      await db.contextSession.update({
        where: { orgId_id: { orgId: fixture.org.id, id: snapshot.sessionId } },
        data: {
          approvalMode,
          policySnapshot: {
            version: 2,
            scopeId: fixture.orgScope.id,
            scopeChain: [fixture.orgScope.id],
            rows: [
              {
                id: "full-connector-policy",
                scopeId: fixture.orgScope.id,
                connectorKey: "google_workspace",
                maxMode: "full",
                approverRoles: ["owner"],
                allowRequesterApproval: true,
              },
            ],
          },
        },
      });
    }
    await afterOpen?.();

    const run = await services.lifecycle.create({
      threadRef: `thread-${call.callId}`,
      trigger: "api",
      sessionId: snapshot.sessionId,
    });
    await services.store.enqueueSteering(run.id, {
      id: `intent-${call.callId}`,
      author: { principalId: fixture.owner.id },
      message: { role: "user", blocks: [{ type: "text", text: "Use the connector." }] },
    });
    const result = await services.driver?.execute(run.id);
    if (result?.status === "paused") {
      return { output: undefined, port, run, services, engine, result };
    }
    expect(result).toMatchObject({ status: "finished" });
    const turns = await services.store.listTurns(run.id);
    const toolResult = turns
      .flatMap(({ toolResults }) => toolResults)
      .find(({ toolCallId }) => toolCallId === call.callId);
    const block = toolResult?.blocks[0];
    if (block?.type !== "text") throw new Error("run did not record a text tool result");
    let output: unknown = block.text;
    try {
      output = JSON.parse(block.text);
    } catch {
      // Plain-text harness failures are already the useful result.
    }
    return {
      output,
      port,
      run,
      services,
      engine,
      result,
    };
  }

  it("executes through the proxy and records the connected system response", async () => {
    const fixture = await setup();
    const toolName = connectorModelToolName("google_workspace:create_draft");
    const { output, port } = await executeCall(
      fixture,
      {
        callId: "executed",
        name: toolName,
        input: { message: { raw: "RnJlZXplIG5vdGljZQ" } },
      },
      "full",
    );

    if (output === undefined) throw new Error("connector run unexpectedly paused");
    expect(port.turnRequests[0]?.tools.map(({ name }) => name)).not.toContain(toolName);
    expect(port.turnRequests[1]?.tools.map(({ name }) => name)).toContain(toolName);
    expect(output).toMatchObject({
      id: "draft-from-run",
      requestAuthorization: "[REDACTED]",
    });
    expect(JSON.stringify(output)).not.toContain(connectorToken);
    expect(providerCalls).toEqual([{ authorization: `Bearer ${connectorToken}` }]);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: fixture.org.id, action: "dataplane.use_connector" },
    });
    expect(audit.payload).toMatchObject({ outcome: "executed", sessionId: expect.any(String) });
  });

  it("exposes an installed connector operation as a first-class typed model tool", async () => {
    const fixture = await setup();
    const toolKey = "google_workspace:create_draft";
    const toolName = connectorModelToolName(toolKey);
    const { output, port } = await executeCall(
      fixture,
      {
        callId: "typed",
        name: toolName,
        input: { message: { raw: "RnJlZXplIG5vdGljZQ" } },
      },
      "full",
    );

    if (output === undefined) throw new Error("typed connector run unexpectedly paused");
    const definition = port.turnRequests[1]?.tools.find(({ name }) => name === toolName);
    expect(definition).toMatchObject({
      key: toolKey,
      kind: "connector",
      schema: { type: "object" },
    });
    expect(port.turnRequests[0]?.tools.find(({ name }) => name === toolName)).toBeUndefined();
    expect(output).toMatchObject({
      id: "draft-from-run",
      requestAuthorization: "[REDACTED]",
    });
  });

  it("finds a connector operation by semantic meaning without lexical overlap", async () => {
    const fixture = await setup();
    await putProvider(db, {
      orgId: fixture.org.id,
      name: "vectors",
      protocol: "openai_compatible",
      baseUrl: "https://embeddings.example.test/v1",
      credentialMode: "none",
    });
    await putDefaults(db, {
      orgId: fixture.org.id,
      role: "embed",
      chain: [{ providerName: "vectors", modelId: "semantic-tools" }],
    });
    const toolKey = "google_workspace:create_draft";
    const toolName = connectorModelToolName(toolKey);
    const embedder: Embedder = {
      model: "semantic-tools",
      embed: async (texts) =>
        texts.map((text) =>
          text === "prepare correspondence" || text.includes("Create a Gmail draft")
            ? [1, 0]
            : [0, 1],
        ),
    };
    const { output, port } = await executeCall(
      fixture,
      {
        callId: "semantic",
        name: toolName,
        input: { message: { raw: "RnJlZXplIG5vdGljZQ" } },
      },
      "full",
      "prepare correspondence",
      embedder,
    );

    expect(output).toMatchObject({ id: "draft-from-run" });
    expect(port.turnRequests[0]?.tools.map(({ name }) => name)).not.toContain(toolName);
    expect(port.turnRequests[1]?.tools.map(({ name }) => name)).toContain(toolName);
  });

  it("discovers a connector installed after the session opened", async () => {
    const fixture = await setup({ install: false });
    const toolName = connectorModelToolName("google_workspace:create_draft");
    const { output, port } = await executeCall(
      fixture,
      {
        callId: "installed-live",
        name: toolName,
        input: { message: { raw: "RnJlZXplIG5vdGljZQ" } },
      },
      "full",
      "draft",
      undefined,
      async () => {
        await fixture.install();
      },
    );

    expect(output).toMatchObject({ id: "draft-from-run" });
    expect(port.turnRequests[1]?.tools.map(({ name }) => name)).toContain(toolName);
  });

  it("parks once for approval and resumes the exact call without model-visible approval plumbing", async () => {
    const fixture = await setup();
    const toolName = connectorModelToolName("google_workspace:create_draft");
    const { output, result, services, engine, run, port } = await executeCall(fixture, {
      callId: "approval",
      name: toolName,
      input: { message: { raw: "RnJlZXplIG5vdGljZQ" } },
    });

    expect(output).toBeUndefined();
    expect(result).toMatchObject({
      status: "paused",
      result: {
        status: "paused",
        elicitation: {
          kind: "approval",
          reference: { callId: "approval", approvalId: expect.any(String) },
        },
      },
    });
    expect(providerCalls).toEqual([]);
    if (result?.status !== "paused" || result.result.status !== "paused") {
      throw new Error("connector run did not pause");
    }
    const approvalId = result.result.elicitation.reference?.approvalId;
    if (approvalId === undefined) throw new Error("approval elicitation has no approval id");
    await expect(
      db.approval.findUniqueOrThrow({ where: { id: approvalId } }),
    ).resolves.toMatchObject({ status: "pending" });

    await services.interrupts.resolve({
      elicitationId: result.result.elicitation.elicitationId,
      optionId: "approve",
      decision: "approved",
      scope: "once",
      by: { principalId: fixture.owner.id, displayName: "Run Connector Owner" },
    });
    await engine.idle();

    expect(providerCalls).toHaveLength(1);
    expect(port.turnRequests).toHaveLength(3);
    expect((await services.store.getRun(run.id))?.state).toBe("completed");
    const turns = await services.store.listTurns(run.id);
    const toolBlock = turns[1]?.toolResults[0]?.blocks[0];
    if (toolBlock?.type !== "text") throw new Error("approved call has no result");
    expect(JSON.parse(toolBlock.text)).toMatchObject({
      id: "draft-from-run",
      requestAuthorization: "[REDACTED]",
    });
  });

  it("refuses an approved pending call when its live tool was removed", async () => {
    const fixture = await setup();
    const toolName = connectorModelToolName("google_workspace:create_draft");
    const { result, services, engine, run } = await executeCall(fixture, {
      callId: "removed-after-search",
      name: toolName,
      input: { message: { raw: "RnJlZXplIG5vdGljZQ" } },
    });
    if (result?.status !== "paused" || result.result.status !== "paused") {
      throw new Error("connector run did not pause");
    }
    const approvalId = result.result.elicitation.reference?.approvalId;
    if (approvalId === undefined) throw new Error("approval elicitation has no approval id");
    if (fixture.installation === null) throw new Error("fixture has no connector installation");

    await db.item.update({
      where: { orgId_id: { orgId: fixture.org.id, id: fixture.installation.id } },
      data: { status: "archived" },
    });
    await services.interrupts.resolve({
      elicitationId: result.result.elicitation.elicitationId,
      optionId: "approve",
      decision: "approved",
      scope: "once",
      by: { principalId: fixture.owner.id, displayName: "Run Connector Owner" },
    });
    await engine.idle();

    expect(providerCalls).toEqual([]);
    expect((await services.store.getRun(run.id))?.state).toBe("completed");
    const turns = await services.store.listTurns(run.id);
    const block = turns[1]?.toolResults[0]?.blocks[0];
    expect(block).toMatchObject({
      type: "text",
      text: `tool no longer available: ${toolName}`,
    });
  });

  it("does not activate an operation that discovery did not find", async () => {
    const fixture = await setup();
    const unavailableName = connectorModelToolName("google_workspace:not_a_tool");
    const { output, run } = await executeCall(
      fixture,
      {
        callId: "unknown",
        name: unavailableName,
        input: {},
      },
      "ask",
      "quantum banana",
    );

    if (output === undefined) throw new Error("unknown connector tool unexpectedly paused");
    expect(output).toBe(`tool no longer available: ${unavailableName}`);
    expect(providerCalls).toEqual([]);
    const events = await db.runEvent.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map(({ event }) => event)).toContainEqual(
      expect.objectContaining({ type: "tool-result", callId: "unknown", status: "error" }),
    );
    const audit = await db.auditLog.findFirst({
      where: { orgId: fixture.org.id, action: "dataplane.use_connector" },
    });
    expect(audit).toBeNull();
  });
});
