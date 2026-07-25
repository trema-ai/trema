import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { bindingsRouter } from "#/rpc/bindings.js";
import { serviceCredentialsRouter } from "#/rpc/credentials.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import { sessionsRouter } from "#/rpc/sessions.js";
import { createItem } from "#/services/items/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const MCP_URL = "http://context.test/api/v1/mcp";

const runbook = [
  "The kingfisher rollback procedure starts with the release train dashboard.",
  "It names the operator who drains connections, the checklist that closes an",
  "incident review, and the paging rotation that covers the release window.",
  "Every sentence here exists so the stored body is far longer than any excerpt",
  "the data plane is allowed to hand back to a caller.",
].join(" ");

integration("data plane", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "dataplane-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  });
  const auth = createAuth({ db, env });
  const app = createApp({ db, auth, env });

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

  async function createOrg(name = "Data Plane Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: signedUp.context },
    );
    return { ...signedUp, ...membership, orgScope, credential };
  }

  type Org = Awaited<ReturnType<typeof createOrg>>;

  function createMemory(org: Org, input: { scopeId: string; title: string; content: string }) {
    return createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: input.scopeId,
      kind: "memory",
      title: input.title,
      body: { type: "fact", content: input.content },
    });
  }

  function serviceContext(secret: string) {
    return { db, auth, env, headers: new Headers({ authorization: `Bearer ${secret}` }) };
  }

  // Every call goes through the mounted app, so the tests exercise the same
  // transport a third-party MCP client speaks.
  async function connect(sessionToken?: string) {
    const client = new Client({ name: "dataplane-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      ...(sessionToken
        ? { requestInit: { headers: { authorization: `Bearer ${sessionToken}` } } }
        : {}),
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    return client;
  }

  it("lists both tools and searches only the session's scope chain", async () => {
    const org = await createOrg();
    const orgItem = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Org note",
      content: "The kingfisher release ships on Tuesday",
    });

    const outside = await call(scopesRouter.create, { name: "Finance" }, { context: org.context });
    const outsideItem = await createMemory(org, {
      scopeId: outside.id,
      title: "Finance note",
      content: "The kingfisher budget is approved for the quarter",
    });

    const shared = await call(scopesRouter.create, { name: "Support" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C1", scopeId: shared.id },
      { context: org.context },
    );
    const sharedItem = await createMemory(org, {
      scopeId: shared.id,
      title: "Deployment runbook",
      content: runbook,
    });
    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C1" },
      { context: serviceContext(org.credential.secret) },
    );

    const client = await connect(opened.sessionToken);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual(["get_item", "search_context"]);

    const result = (await client.callTool({
      name: "search_context",
      arguments: { query: "kingfisher" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as {
      results: { id: string; snippet: string }[];
    };
    const ids = results.map(({ id }) => id);
    expect(ids).toContain(orgItem.id);
    expect(ids).toContain(sharedItem.id);
    expect(ids).not.toContain(outsideItem.id);

    // Snippets, never bodies: the two-step is what keeps search from filling
    // the model's window.
    for (const match of results) {
      expect(Object.keys(match).sort()).toEqual(["id", "kind", "score", "snippet", "title"]);
      expect(match.snippet.length).toBeLessThan(runbook.length);
    }
    expect(JSON.stringify(result)).not.toContain(runbook);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "dataplane.search_context", subject: opened.sessionId },
    });
    expect(audit.payload).toMatchObject({ resultCount: results.length, limit: 8 });
    // The query text is the caller's content and never lands in the stream.
    expect(JSON.stringify(audit.payload)).not.toContain("kingfisher");

    await client.close();
  });

  it("honours the kind filter and the result limit", async () => {
    const org = await createOrg();
    await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Kingfisher memory",
      content: "The kingfisher release ships on Tuesday",
    });
    await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: org.orgScope.id,
      kind: "instruction",
      title: "Kingfisher instruction",
      body: { content: "Announce every kingfisher release in the channel" },
    });

    const shared = await call(scopesRouter.create, { name: "Ops" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C2", scopeId: shared.id },
      { context: org.context },
    );
    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C2" },
      { context: serviceContext(org.credential.secret) },
    );
    const client = await connect(opened.sessionToken);

    const all = (await client.callTool({
      name: "search_context",
      arguments: { query: "kingfisher" },
    })) as CallToolResult;
    expect((all.structuredContent as { results: unknown[] }).results).toHaveLength(2);

    const memories = (await client.callTool({
      name: "search_context",
      arguments: { query: "kingfisher", kinds: ["memory"] },
    })) as CallToolResult;
    const kinds = (memories.structuredContent as { results: { kind: string }[] }).results;
    expect(kinds.map(({ kind }) => kind)).toEqual(["memory"]);

    const capped = (await client.callTool({
      name: "search_context",
      arguments: { query: "kingfisher", limit: 1 },
    })) as CallToolResult;
    expect((capped.structuredContent as { results: unknown[] }).results).toHaveLength(1);

    await client.close();
  });

  it("reads an item in the chain in full, marks it used, and audits the read", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Runbooks" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C3", scopeId: shared.id },
      { context: org.context },
    );
    const item = await createMemory(org, {
      scopeId: shared.id,
      title: "Deployment runbook",
      content: runbook,
    });
    expect(item.lastUsedAt).toBeNull();

    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C3" },
      { context: serviceContext(org.credential.secret) },
    );
    const client = await connect(opened.sessionToken);

    const result = (await client.callTool({
      name: "get_item",
      arguments: { id: item.id },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      id: item.id,
      kind: "memory",
      title: "Deployment runbook",
      body: { type: "fact", content: runbook },
      scopeId: shared.id,
      disclosure: "retrieved",
      version: 1,
    });

    const stored = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: item.id } },
    });
    expect(stored.lastUsedAt).not.toBeNull();
    // Usage is not an edit: the version and the update stamp stay put.
    expect(stored.version).toBe(1);
    expect(stored.updatedAt.getTime()).toBe(item.updatedAt.getTime());

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "dataplane.get_item", subject: item.id },
    });
    expect(audit.actorPrincipalId).toBe(opened.actingPrincipalId);
    expect(audit.payload).toMatchObject({ sessionId: opened.sessionId, kind: "memory" });

    await client.close();
  });

  it("reports an item outside the scope chain exactly like a missing one", async () => {
    const org = await createOrg();
    const outside = await call(scopesRouter.create, { name: "Legal" }, { context: org.context });
    const hidden = await createMemory(org, {
      scopeId: outside.id,
      title: "Contract note",
      content: "The vendor contract renews in March",
    });
    const shared = await call(scopesRouter.create, { name: "Helpdesk" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C4", scopeId: shared.id },
      { context: org.context },
    );
    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C4" },
      { context: serviceContext(org.credential.secret) },
    );
    const client = await connect(opened.sessionToken);

    const denied = (await client.callTool({
      name: "get_item",
      arguments: { id: hidden.id },
    })) as CallToolResult;
    const missing = (await client.callTool({
      name: "get_item",
      arguments: { id: randomUUID() },
    })) as CallToolResult;
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([{ type: "text", text: "Item not found" }]);
    expect(missing.content).toEqual(denied.content);

    const stored = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: hidden.id } },
    });
    expect(stored.lastUsedAt).toBeNull();
    await expect(
      db.auditLog.count({ where: { orgId: org.org.id, action: "dataplane.get_item" } }),
    ).resolves.toBe(0);

    await client.close();
  });

  it("rejects a missing, unknown, expired, or closed session token", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Lifetime" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C5", scopeId: shared.id },
      { context: org.context },
    );
    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C5" },
      { context: serviceContext(org.credential.secret) },
    );

    await expect(connect()).rejects.toThrow(/session_token_required/);
    await expect(connect("trema_ses_nonsense")).rejects.toThrow(/invalid_session_token/);
    await expect(connect(org.credential.secret)).rejects.toThrow(/invalid_session_token/);

    // A live token works, and the same token stops working the moment the
    // session expires: a data-plane call carries no other credential.
    const client = await connect(opened.sessionToken);
    await client.close();

    await db.contextSession.update({
      where: { id: opened.sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(connect(opened.sessionToken)).rejects.toThrow(/session_expired/);

    await db.contextSession.update({
      where: { id: opened.sessionId },
      data: { expiresAt: new Date(Date.now() + 60_000), closedAt: new Date() },
    });
    await expect(connect(opened.sessionToken)).rejects.toThrow(/session_closed/);
  });

  it("does not open a server-initiated stream", async () => {
    const response = await app.fetch(
      new Request(MCP_URL, { headers: { accept: "text/event-stream" } }),
    );
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "sse_unsupported" } },
    });
  });
});
