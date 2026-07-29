import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#server/app.js";
import type { Prisma } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { orgRouter } from "#server/rpc/org.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import { requestItemActivation } from "#server/services/approvals/index.js";
import type { ConnectorFetch } from "#server/services/connectors/index.js";
import { createItem } from "#server/services/items/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 73).toString("base64");

const origin = "http://context.test";
const GMAIL_TOKEN = "acceptance-gmail-token";

/**
 * The context app's acceptance path, driven the way a harness drives it: the
 * session protocol over plain HTTP, then the data plane over MCP. Each phase
 * adds to this one run — memory writes, the approval round-trip, skills.
 */
integration("acceptance", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "acceptance-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
    TREMA_CREDENTIAL_MASTER_KEY: masterKey,
  });
  const auth = createAuth({ db, env });

  // The connected system is recorded, not live: this path proves the proxy
  // chain and the approval gate, and CI never reaches a provider.
  const providerCalls: { url: string; authorization: string | null }[] = [];
  const connectorFetch: ConnectorFetch = async (url, init) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    providerCalls.push({ url: String(url), authorization });
    // A chatty provider echoes the credential it was handed back in its own
    // answer. The proxy hands that answer to the model, so this is the case the
    // redaction has to survive — a body with the token in it, not merely one
    // without.
    return Response.json({
      id: "draft-9",
      message: { id: "message-9" },
      requestAuthorization: authorization,
    });
  };
  const app = createApp({ db, auth, env, connectorFetch });

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
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  it("opens a session, searches the context, saves a memory, and reads it back", async () => {
    // An administrator sets up the organization: a team scope, the Slack
    // channel bound to it, and one memory worth retrieving.
    const owner = await signUp("Acceptance Owner");
    const { org, principal } = await call(
      orgRouter.create,
      { name: "Acceptance Org" },
      { context: owner.context },
    );
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: owner.context },
    );
    const scope = await call(
      scopesRouter.create,
      { name: "Engineering" },
      { context: owner.context },
    );
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T9:C9", scopeId: scope.id },
      { context: owner.context },
    );
    const item = await createItem(db, {
      orgId: org.id,
      actorPrincipalId: principal.id,
      scopeId: scope.id,
      kind: "memory",
      title: "Release train",
      body: {
        type: "fact",
        content: "The release train leaves every Tuesday at 10:00 and freezes on Monday evening.",
      },
    });

    // The harness opens a session for the channel.
    const openResponse = await app.fetch(
      new Request(`${origin}/api/v1/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.secret}`,
        },
        body: JSON.stringify({ surface: "slack", locationRef: "T9:C9" }),
      }),
    );
    expect(openResponse.status).toBe(200);
    const session = (await openResponse.json()) as { sessionId: string; sessionToken: string };
    expect(session.sessionToken).toMatch(/^trema_ses_/);

    // The model reaches the context through the data plane, with the session
    // token as its only credential.
    const client = new Client({ name: "acceptance-harness", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${session.sessionToken}` } },
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport as Parameters<Client["connect"]>[0]);

    const found = (await client.callTool({
      name: "search_context",
      arguments: { query: "release train" },
    })) as CallToolResult;
    const { results } = found.structuredContent as { results: { id: string }[] };
    expect(results.map(({ id }) => id)).toEqual([item.id]);

    const read = (await client.callTool({
      name: "get_item",
      arguments: { id: results[0]?.id },
    })) as CallToolResult;
    expect(read.structuredContent).toMatchObject({
      id: item.id,
      title: "Release train",
      body: { type: "fact" },
    });

    // The run learns something worth keeping and writes it down. The memory
    // lands at the session's own scope, active, because a fact is cheap to
    // correct.
    const remembered = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Release captain",
        content: "Priya runs the release train and announces the freeze.",
      },
    })) as CallToolResult;
    expect(remembered.isError).toBeFalsy();
    const memory = remembered.structuredContent as { id: string };
    expect(remembered.structuredContent).toMatchObject({
      scopeId: scope.id,
      status: "active",
      version: 1,
      superseded: null,
    });

    const readBack = (await client.callTool({
      name: "get_item",
      arguments: { id: memory.id },
    })) as CallToolResult;
    expect(readBack.structuredContent).toMatchObject({
      id: memory.id,
      title: "Release captain",
      body: { type: "fact", content: "Priya runs the release train and announces the freeze." },
    });

    // A rule is not the run's to turn on. It lands proposed, and a proposed
    // item is not readable from the data plane at all.
    const proposed = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "rule",
        title: "Freeze notice",
        content: "Announce the freeze in the channel before Monday evening.",
      },
    })) as CallToolResult;
    const rule = proposed.structuredContent as { id: string };
    expect(proposed.structuredContent).toMatchObject({ status: "proposed" });
    const beforeApproval = (await client.callTool({
      name: "get_item",
      arguments: { id: rule.id },
    })) as CallToolResult;
    expect(beforeApproval.isError).toBe(true);

    // The run asks for it, and a person says yes — here through the
    // control-plane API, which is always an alternative approval surface.
    const approval = await requestItemActivation(db, {
      orgId: org.id,
      sessionId: session.sessionId,
      itemId: rule.id,
      reason: "The freeze notice came up twice this week",
    });
    const approveResponse = await app.fetch(
      new Request(`${origin}/api/v1/approvals/${approval.id}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: owner.context.headers.get("cookie") ?? "",
        },
      }),
    );
    expect(approveResponse.status).toBe(200);
    const approved = (await approveResponse.json()) as {
      approval: { status: string; executedAt: string | null };
      activatedItemId?: string;
    };
    expect(approved).toMatchObject({
      approval: { status: "approved" },
      activatedItemId: rule.id,
    });
    expect(approved.approval.executedAt).not.toBeNull();

    // Now the run can read the rule it proposed.
    const afterApproval = (await client.callTool({
      name: "get_item",
      arguments: { id: rule.id },
    })) as CallToolResult;
    expect(afterApproval.isError).toBeFalsy();
    expect(afterApproval.structuredContent).toMatchObject({
      id: rule.id,
      title: "Freeze notice",
      body: { type: "rule" },
    });

    // The harness reports what was said in the thread it answered in.
    const captureResponse = await app.fetch(
      new Request(`${origin}/api/v1/sessions/${session.sessionId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.sessionToken}`,
        },
        body: JSON.stringify({
          messages: [
            {
              surfaceMessageRef: "1700000000.0001",
              author: { externalRef: "U-ASKS" },
              sentAt: "2026-07-24T09:00:00.000Z",
              text: "Who runs the release train?",
            },
            {
              surfaceMessageRef: "1700000000.0002",
              author: { externalRef: "U-AGENT" },
              sentAt: "2026-07-24T09:00:12.000Z",
              text: "Priya runs it and announces the freeze on Monday evening.",
            },
          ],
        }),
      }),
    );
    expect(captureResponse.status).toBe(200);
    const captured = (await captureResponse.json()) as {
      conversationId: string;
      created: number;
    };
    expect(captured.created).toBe(2);

    // The model can read the thread back, word for word.
    const window = (await client.callTool({
      name: "fetch_transcript",
      arguments: { conversationId: captured.conversationId },
    })) as CallToolResult;
    expect(window.structuredContent).toMatchObject({
      conversationId: captured.conversationId,
      messageCount: 2,
      firstSeq: 1,
      lastSeq: 2,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    const { messages } = window.structuredContent as { messages: { text: string }[] };
    expect(messages.map(({ text }) => text)).toEqual([
      "Who runs the release train?",
      "Priya runs it and announces the freeze on Monday evening.",
    ]);

    // The organization has a connected Gmail account. The credential is stored
    // encrypted at the org scope; the run never sees it and never calls Gmail.
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: org.id, kind: "org" },
    });
    const connection = await db.connectorConnection.create({
      data: {
        orgId: org.id,
        principalId: principal.id,
        providerKey: "google_workspace",
        mode: "oauth2_code",
        config: {},
        ciphertext: encryptEnvelope({ accessToken: GMAIL_TOKEN }, masterKey),
      },
    });
    await db.item.create({
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
        createdById: principal.id,
      },
    });

    // Connector changes affect new sessions. Open a fresh pinned snapshot
    // before asking the connector proxy to expose the new installation.
    await client.close();
    const connectorOpenResponse = await app.fetch(
      new Request(`${origin}/api/v1/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.secret}`,
        },
        body: JSON.stringify({ surface: "slack", locationRef: "T9:C9" }),
      }),
    );
    expect(connectorOpenResponse.status).toBe(200);
    const connectorSession = (await connectorOpenResponse.json()) as {
      sessionToken: string;
    };
    const connectorClient = new Client({
      name: "acceptance-connector-harness",
      version: "1.0.0",
    });
    const connectorTransport = new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${connectorSession.sessionToken}` },
      },
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await connectorClient.connect(connectorTransport as Parameters<Client["connect"]>[0]);

    // Drafting mail changes something in a connected system, so the call stops
    // at the gate: an approval id comes back as a result, and nothing left the
    // deployment.
    const draftArgs = { message: { raw: "RnJlZXplIG5vdGljZQ" } };
    const gated = (await connectorClient.callTool({
      name: "use_connector",
      arguments: {
        toolKey: "google_workspace:create_draft",
        args: draftArgs,
        reason: "Draft the freeze notice so Priya only has to send it",
      },
    })) as CallToolResult;
    expect(gated.isError).toBeFalsy();
    expect(gated.structuredContent).toMatchObject({
      status: "approval_required",
      toolKey: "google_workspace:create_draft",
      mode: "ask",
    });
    const gatedCall = gated.structuredContent as { approvalId: string };
    expect(providerCalls).toEqual([]);

    // The same person approves it, through the same endpoint that activated
    // the rule — one approval vocabulary for tool calls and items alike.
    const connectorApproval = await app.fetch(
      new Request(`${origin}/api/v1/approvals/${gatedCall.approvalId}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: owner.context.headers.get("cookie") ?? "",
        },
      }),
    );
    expect(connectorApproval.status).toBe(200);
    expect(await connectorApproval.json()).toMatchObject({ approval: { status: "approved" } });

    // Calling again with the id and the same arguments runs it, once, with the
    // organization's credential attached on this side of the boundary.
    const ran = (await connectorClient.callTool({
      name: "use_connector",
      arguments: {
        toolKey: "google_workspace:create_draft",
        args: draftArgs,
        reason: "Draft the freeze notice so Priya only has to send it",
        approvalId: gatedCall.approvalId,
      },
    })) as CallToolResult;
    expect(ran.isError).toBeFalsy();
    expect(ran.structuredContent).toMatchObject({
      status: "executed",
      toolKey: "google_workspace:create_draft",
      approvalId: gatedCall.approvalId,
      result: { ok: true, status: 200, body: { id: "draft-9" } },
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.authorization).toBe(`Bearer ${GMAIL_TOKEN}`);
    expect(JSON.stringify(ran)).not.toContain(GMAIL_TOKEN);
    // The echo came back, with the credential taken out of it.
    expect(ran.structuredContent).toMatchObject({
      result: { body: { requestAuthorization: "[REDACTED]" } },
    });

    await connectorClient.close();

    // The run's usage lands on the session, and the whole exchange is in the
    // audit stream.
    const closeResponse = await app.fetch(
      new Request(`${origin}/api/v1/sessions/${session.sessionId}/close`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.sessionToken}`,
        },
        body: JSON.stringify({ usage: { totalTokens: 900 } }),
      }),
    );
    expect(closeResponse.status).toBe(200);

    const actions = await db.auditLog.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(actions.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "session.open",
        "dataplane.search_context",
        "dataplane.get_item",
        "dataplane.save_memory",
        "approval.request",
        "approval.approved",
        "item.activate",
        "session.messages",
        "dataplane.fetch_transcript",
        "dataplane.use_connector",
        "session.close",
      ]),
    );

    // Both halves of the proxied call are recorded, and the arguments stay in
    // the approval row rather than the audit stream.
    const proxied = await db.auditLog.findMany({
      where: { orgId: org.id, action: "dataplane.use_connector" },
      orderBy: { createdAt: "asc" },
    });
    expect(proxied.map((entry) => (entry.payload as { outcome: string }).outcome)).toEqual([
      "approval_required",
      "executed",
    ]);
    expect(JSON.stringify(proxied)).not.toContain(draftArgs.message.raw);
  });
});
