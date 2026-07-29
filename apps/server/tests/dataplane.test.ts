import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#server/app.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { orgRouter } from "#server/rpc/org.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import { sessionsRouter } from "#server/rpc/sessions.js";
import { createItem, type MemoryType } from "#server/services/items/index.js";

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

function memoryContent(item: { body: unknown }): string {
  return (item.body as { content: string }).content;
}

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

  function createMemory(
    org: Org,
    input: { scopeId: string; title: string; content: string; type?: MemoryType },
  ) {
    return createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: input.scopeId,
      kind: "memory",
      title: input.title,
      body: { type: input.type ?? "fact", content: input.content },
    });
  }

  /** Bind a channel to a fresh shared scope and open a session on it. */
  async function openSessionOn(org: Org, name: string, locationRef: string) {
    const scope = await call(scopesRouter.create, { name }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef, scopeId: scope.id },
      { context: org.context },
    );
    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef },
      { context: serviceContext(org.credential.secret) },
    );
    return { scope, opened };
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

  it("lists every tool and searches only the session's scope chain", async () => {
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
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      "fetch_transcript",
      "get_item",
      "save_memory",
      "search_context",
      "search_tools",
      "update_memory",
      "use_connector",
    ]);

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

  it("saves memories at the session's own scope, under the type policy", async () => {
    const org = await createOrg();
    const { scope, opened } = await openSessionOn(org, "Ops", "T1:C6");
    const client = await connect(opened.sessionToken);

    const saved = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Staging host",
        content: "Acme's staging environment answers on stage.acme.io",
      },
    })) as CallToolResult;
    expect(saved.isError).toBeFalsy();
    const fact = saved.structuredContent as { id: string; status: string; scopeId: string };
    // Write local: the memory lands at the session's own scope, never at the
    // org scope it also reads from.
    expect(fact.scopeId).toBe(scope.id);
    expect(fact.status).toBe("active");
    expect(saved.structuredContent).toMatchObject({ type: "fact", version: 1, superseded: null });

    const proposed = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "rule",
        title: "Pull requests only",
        content: "Never push to main; always open a pull request",
      },
    })) as CallToolResult;
    // A rule changes future behavior silently, so it waits for a person.
    expect(proposed.structuredContent).toMatchObject({ status: "proposed", scopeId: scope.id });

    const preference = (await client.callTool({
      name: "save_memory",
      arguments: { type: "preference", title: "Bullet summaries", content: "Alice wants bullets" },
    })) as CallToolResult;
    expect(preference.structuredContent).toMatchObject({ status: "active" });

    const procedure = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "procedure",
        title: "Weekly metrics",
        content: "Export the dashboard, then post the numbers in the channel",
      },
    })) as CallToolResult;
    expect(procedure.structuredContent).toMatchObject({ status: "proposed" });

    await expect(
      db.item.count({ where: { orgId: org.org.id, scopeId: org.orgScope.id } }),
    ).resolves.toBe(0);
    const stored = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: fact.id } },
    });
    expect(stored.sourceSessionId).toBe(opened.sessionId);
    expect(stored.createdById).toBe(opened.actingPrincipalId);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "dataplane.save_memory", subject: fact.id },
    });
    expect(audit.payload).toMatchObject({
      sessionId: opened.sessionId,
      scopeId: scope.id,
      type: "fact",
      status: "active",
      superseded: null,
    });
    // Ids, counts, and the policy outcome — never what the memory says.
    expect(JSON.stringify(audit.payload)).not.toContain("stage.acme.io");

    await client.close();
  });

  it("supersedes a near-duplicate at its own scope and never one at a wider scope", async () => {
    const org = await createOrg();
    const { scope, opened } = await openSessionOn(org, "Delivery", "T1:C7");
    const local = await createMemory(org, {
      scopeId: scope.id,
      title: "Kingfisher release train",
      content:
        "The kingfisher release train leaves every Tuesday at 10:00 and freezes on Monday evening.",
    });
    const wider = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Kingfisher release train",
      content:
        "The kingfisher release train leaves every Tuesday at 10:00 and freezes on Monday evening.",
    });
    const client = await connect(opened.sessionToken);

    const saved = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Kingfisher release",
        content: "The kingfisher release train leaves every Tuesday.",
      },
    })) as CallToolResult;
    expect(saved.structuredContent).toMatchObject({
      id: local.id,
      superseded: local.id,
      version: 2,
      scopeId: scope.id,
    });

    // The old wording is retained, so a person can see what changed.
    const versions = await db.itemVersion.findMany({ where: { itemId: local.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, title: "Kingfisher release train" });
    expect(versions[0]?.body).toMatchObject({ content: memoryContent(local) });

    // The identical memory one scope up is untouched: a cross-scope conflict
    // is resolution order plus a person's judgement, not a supersede.
    const untouched = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: wider.id } },
    });
    expect(untouched.version).toBe(1);

    // A memory about something else lands beside them.
    const other = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Support rota",
        content: "Dana carries the support pager this month",
      },
    })) as CallToolResult;
    const otherId = (other.structuredContent as { id: string }).id;
    expect(otherId).not.toBe(local.id);
    expect(other.structuredContent).toMatchObject({ superseded: null, version: 1 });

    // The same title at the same scope is the same memory, whatever the words.
    const retitled = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Support rota",
        content: "Ravi carries the support pager from next Monday",
      },
    })) as CallToolResult;
    expect(retitled.structuredContent).toMatchObject({
      id: otherId,
      superseded: otherId,
      version: 2,
    });

    // A different type is a different memory, however alike the words are.
    const asPreference = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "preference",
        title: "Support rota",
        content: "Ravi carries the support pager from next Monday",
      },
    })) as CallToolResult;
    expect(asPreference.structuredContent).toMatchObject({ superseded: null, version: 1 });
    expect((asPreference.structuredContent as { id: string }).id).not.toBe(otherId);

    await client.close();
  });

  it("supersedes the same-type match even when another type ranks higher", async () => {
    const org = await createOrg();
    const { scope, opened } = await openSessionOn(org, "Cadence", "T1:C14");
    // Two memories with the same words but different types. Whichever one
    // search ranks first, the save must take over the fact, never the
    // preference.
    const preference = await createMemory(org, {
      scopeId: scope.id,
      type: "preference",
      title: "Deploy cadence preference",
      content: "Deploys go out every Thursday afternoon after the standup",
    });
    const fact = await createMemory(org, {
      scopeId: scope.id,
      title: "Deploy cadence",
      content: "Deploys go out every Thursday afternoon after the standup",
    });
    const client = await connect(opened.sessionToken);

    // The title's words all appear in the stored memories: the lexical query
    // requires every word of the new memory, so a novel title word would hide
    // both candidates and dodge the case under test.
    const saved = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Thursday deploys",
        content: "Deploys go out every Thursday afternoon after the standup",
      },
    })) as CallToolResult;
    expect(saved.structuredContent).toMatchObject({ id: fact.id, superseded: fact.id, version: 2 });

    const untouched = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: preference.id } },
    });
    expect(untouched.version).toBe(1);

    await client.close();
  });

  it("updates only active facts and preferences at the session's own scope", async () => {
    const org = await createOrg();
    const { scope, opened } = await openSessionOn(org, "Billing", "T1:C8");
    const own = await createMemory(org, {
      scopeId: scope.id,
      title: "Invoice contact",
      content: "Send invoices to billing@acme.example",
    });
    const wider = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Company address",
      content: "Acme is registered at 4 Mill Lane",
    });
    const rule = await createMemory(org, {
      scopeId: scope.id,
      title: "Invoice approvals",
      content: "Every invoice over 5000 needs a second approver",
      type: "rule",
    });
    const outside = await call(scopesRouter.create, { name: "Legal" }, { context: org.context });
    const hidden = await createMemory(org, {
      scopeId: outside.id,
      title: "Retainer",
      content: "The retainer renews in March",
    });
    const client = await connect(opened.sessionToken);

    const updated = (await client.callTool({
      name: "update_memory",
      arguments: { id: own.id, content: "Send invoices to accounts@acme.example" },
    })) as CallToolResult;
    expect(updated.isError).toBeFalsy();
    // The type and the title survive an update; only the content moves on.
    expect(updated.structuredContent).toMatchObject({
      id: own.id,
      type: "fact",
      title: "Invoice contact",
      status: "active",
      version: 2,
    });
    const versions = await db.itemVersion.findMany({ where: { itemId: own.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.body).toMatchObject({ content: memoryContent(own) });

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "dataplane.update_memory", subject: own.id },
    });
    expect(audit.payload).toMatchObject({
      sessionId: opened.sessionId,
      type: "fact",
      version: 2,
      previousVersion: 1,
    });
    expect(JSON.stringify(audit.payload)).not.toContain("accounts@acme.example");

    // Wider scopes are read-only from inside a run: they are the control
    // plane's to edit.
    const wide = (await client.callTool({
      name: "update_memory",
      arguments: { id: wider.id, content: "Acme moved to 9 Mill Lane" },
    })) as CallToolResult;
    expect(wide.isError).toBe(true);
    expect(JSON.stringify(wide.content)).toContain("wider scope");

    // An active rule is guidance a person turned on.
    const guidance = (await client.callTool({
      name: "update_memory",
      arguments: { id: rule.id, content: "Every invoice over 9000 needs a second approver" },
    })) as CallToolResult;
    expect(guidance.isError).toBe(true);
    expect(JSON.stringify(guidance.content)).toContain("save_memory");

    // Out of the chain, archived, and never existed all read the same.
    await db.item.update({
      where: { orgId_id: { orgId: org.org.id, id: own.id } },
      data: { status: "archived" },
    });
    const denied = (await client.callTool({
      name: "update_memory",
      arguments: { id: hidden.id, content: "The retainer renews in April" },
    })) as CallToolResult;
    const archived = (await client.callTool({
      name: "update_memory",
      arguments: { id: own.id, content: "Send invoices to nobody" },
    })) as CallToolResult;
    const missing = (await client.callTool({
      name: "update_memory",
      arguments: { id: randomUUID(), content: "Anything at all" },
    })) as CallToolResult;
    expect(denied.content).toEqual([{ type: "text", text: "Item not found" }]);
    expect(archived.content).toEqual(denied.content);
    expect(missing.content).toEqual(denied.content);

    for (const untouched of [wider, rule, hidden]) {
      const stored = await db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: untouched.id } },
      });
      expect(stored.version).toBe(1);
      expect(stored.body).toEqual(untouched.body);
    }

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
