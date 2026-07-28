import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "#server/app.js";
import type { Prisma, ScopeKind } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { createLogger, withLogger } from "#server/lib/logger/index.js";
import { approveApproval, hashApprovalArgs } from "#server/services/approvals/index.js";
import type { ConnectorFetch } from "#server/services/connectors/index.js";
import { useConnector } from "#server/services/dataplane/connector.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";
import { resolvePolicySnapshot } from "#server/services/policies/index.js";
import { hashSessionToken, SESSION_TOKEN_PREFIX } from "#server/services/sessions/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 73).toString("base64");

const MCP_URL = "http://context.test/api/v1/mcp";
const READ_TOOL = "google_workspace:search_messages";
const WRITE_TOOL = "google_workspace:create_draft";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

/**
 * A real MCP server standing in for an MCP-transport provider.
 *
 * The proxy reaches it with the SDK's own client over this fetch, so the call
 * crosses two complete MCP hops — the session's mount and the provider's
 * server — without a socket. Like the data-plane mount, it is stateless: every
 * request builds its own server and drops it again.
 */
function providerMcpServer(
  received: { query: string; authorization: string | null }[],
): ConnectorFetch {
  return async (url, init) => {
    const request = new Request(url, init);
    // The provider answers requests; it never opens a stream of its own.
    if (request.method === "GET") return new Response(null, { status: 405 });
    const authorization = request.headers.get("authorization");
    const server = new McpServer({ name: "provider", version: "1.0.0" });
    server.registerTool(
      "search_pages",
      {
        title: "Search pages",
        description: "Search the workspace.",
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      ({ query }) => {
        received.push({ query, authorization });
        return { content: [{ type: "text" as const, text: `3 pages match ${query}` }] };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

integration("data plane connector proxy", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "dataplane-connector-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_AUTH_BASE_URL: "https://auth.trema.example",
    TREMA_WEB_ORIGINS: "https://app.trema.example",
    TREMA_CREDENTIAL_MASTER_KEY: masterKey,
  });
  const auth = createAuth({ db, env });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function fixture() {
    const org = await db.org.create({ data: { name: `Proxy ${randomUUID()}` } });
    const agent = await db.principal.create({
      data: { orgId: org.id, kind: "agent", displayName: "Proxy agent" },
    });
    const human = await db.principal.create({
      data: { orgId: org.id, kind: "human", displayName: "Dana" },
    });
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    const sharedScope = await db.scope.create({
      data: { orgId: org.id, kind: "shared", name: "Support" },
    });
    const personalScope = await db.scope.create({
      data: { orgId: org.id, kind: "personal", name: "Dana", ownerId: human.id },
    });
    await db.grant.create({
      data: { orgId: org.id, principalId: human.id, role: "admin", scopeId: orgScope.id },
    });
    return { org, agent, human, orgScope, sharedScope, personalScope };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function connection(input: {
    orgId: string;
    principalId: string;
    accessToken: string;
    providerKey?: string;
    mode?: string;
    revokedAt?: Date;
    /** Set it in the past for a credential nothing can refresh. */
    expiresAt?: Date;
  }) {
    return db.connectorConnection.create({
      data: {
        orgId: input.orgId,
        principalId: input.principalId,
        providerKey: input.providerKey ?? "google_workspace",
        mode: input.mode ?? "oauth2_code",
        config: {},
        ciphertext: encryptEnvelope({ accessToken: input.accessToken }, masterKey),
        ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
    });
  }

  function installation(input: {
    orgId: string;
    scopeId: string;
    principalId: string;
    connectionId: string;
    catalogKey?: string;
    /** What an MCP provider's tool sync last reported. */
    syncedTools?: { name: string; sensitivity: "read" | "write" | "destructive" }[];
  }) {
    const catalogKey = input.catalogKey ?? "google_workspace";
    return db.item.create({
      data: {
        orgId: input.orgId,
        scopeId: input.scopeId,
        kind: "connector",
        title: catalogKey,
        body: {
          catalogKey,
          connectionId: input.connectionId,
          enabledTools: "all",
          ...(input.syncedTools ? { syncedTools: input.syncedTools } : {}),
        } satisfies Prisma.InputJsonObject,
        status: "active",
        disclosure: "retrieved",
        createdById: input.principalId,
      },
    });
  }

  /**
   * A session row without the binding plumbing: the proxy reads the scope
   * chain, the scope kind, and the pinned snapshot, and those are exactly what
   * this writes.
   */
  async function openTestSession(
    owner: Fixture,
    input: {
      scope: { id: string; kind: ScopeKind };
      actingPrincipalId: string;
      requesterPrincipalId?: string;
      /** Overrides the resolved chain, for the isolation tests. */
      scopeChain?: string[];
    },
  ) {
    const scopeChain =
      input.scopeChain ??
      (input.scope.kind === "org" ? [owner.orgScope.id] : [owner.orgScope.id, input.scope.id]);
    const policySnapshot = await resolvePolicySnapshot(db, {
      orgId: owner.org.id,
      scopeId: input.scope.id,
      scopeChain,
      scopeKind: input.scope.kind,
    });
    const token = `${SESSION_TOKEN_PREFIX}${randomUUID()}`;
    const row = await db.contextSession.create({
      data: {
        orgId: owner.org.id,
        scopeId: input.scope.id,
        surface: "slack",
        locationRef: `T1:${randomUUID()}`,
        mode: input.scope.kind === "personal" ? "delegated" : "service",
        scopeChain,
        actingPrincipalId: input.actingPrincipalId,
        requesterPrincipalId: input.requesterPrincipalId ?? null,
        standing: {} as Prisma.InputJsonValue,
        policySnapshot: policySnapshot as unknown as Prisma.InputJsonValue,
        snapshotHash: randomUUID(),
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    const session: DataPlaneSession = {
      id: row.id,
      orgId: row.orgId,
      scopeId: row.scopeId,
      scopeKind: input.scope.kind,
      scopeChain,
      actingPrincipalId: row.actingPrincipalId,
      requesterPrincipalId: row.requesterPrincipalId,
      requesterExternalRef: row.requesterExternalRef,
    };
    return { row, token, session };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function authorizationOf(fetch: FetchMock, call = 0): string | null {
    return new Headers(fetch.mock.calls[call]?.[1]?.headers).get("Authorization");
  }

  /** The harness's own client, speaking the real transport to the mount. */
  async function dataPlaneClient(app: ReturnType<typeof createApp>, token: string) {
    const client = new Client({ name: "connector-proxy-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    return client;
  }

  /** The `{code, message}` a refused tool call carries as its text content. */
  function codedFailure(result: CallToolResult): { code?: string; message?: string } {
    const [content] = result.content ?? [];
    return JSON.parse(content?.type === "text" ? content.text : "{}") as {
      code?: string;
      message?: string;
    };
  }

  /** The same database, with the audit table refusing every write. */
  function withFailingAuditWrite(client: typeof db, message = "audit table is unavailable") {
    return new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === "auditLog") {
          return {
            ...(value as object),
            create: () => Promise.reject(new Error(message)),
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function withFailingItemQuery(client: typeof db, message: string) {
    return new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === "item") {
          return {
            ...(value as object),
            findMany: () => Promise.reject(new Error(message)),
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function auditEntries(orgId: string) {
    return db.auditLog.findMany({
      where: { orgId, action: "dataplane.use_connector" },
      orderBy: { createdAt: "asc" },
    });
  }

  it("resolves the narrowest installation from a widest-first session chain", async () => {
    const owner = await fixture();
    const wide = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "org-token",
    });
    const narrow = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.agent.id,
      connectionId: wide.id,
    });
    const narrowItem = await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: narrow.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ messages: [] }));

    const outcome = await useConnector(db, opened.session, {
      toolKey: READ_TOOL,
      args: {},
      reason: "Find the thread the customer mentioned",
      masterKey,
      fetch,
    });

    expect(outcome).toMatchObject({ status: "executed", sensitivity: "read" });
    expect(authorizationOf(fetch)).toBe("Bearer shared-token");
    const [entry] = await auditEntries(owner.org.id);
    expect(entry?.subject).toBe(narrowItem.id);
    // The audit tuple names the agent that called and the person it called for.
    expect(entry?.actorPrincipalId).toBe(owner.agent.id);
    expect(entry?.payload).toMatchObject({
      outcome: "executed",
      toolKey: READ_TOOL,
      sensitivity: "read",
      installationItemId: narrowItem.id,
      argsHash: hashApprovalArgs({}),
      requesterPrincipalId: owner.human.id,
      requesterExternalRef: null,
    });
  });

  it("refuses a tool the narrowest scope's server does not expose instead of escalating", async () => {
    const owner = await fixture();
    const orgConnection = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "org-notion-token",
      providerKey: "notion",
      mode: "mcp_oauth",
    });
    const sharedConnection = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-notion-token",
      providerKey: "notion",
      mode: "mcp_oauth",
    });
    // The org's workspace exposes the destructive tool; the team's does not.
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.agent.id,
      connectionId: orgConnection.id,
      catalogKey: "notion",
      syncedTools: [
        { name: "search_pages", sensitivity: "read" },
        { name: "delete_page", sensitivity: "destructive" },
      ],
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: sharedConnection.id,
      catalogKey: "notion",
      syncedTools: [{ name: "search_pages", sensitivity: "read" }],
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const clientFactory = vi.fn(async () => {
      throw new Error("the org installation's connection must not be reached");
    });

    // Falling through to the org installation would run a destructive call on
    // a credential this team's scope was never given.
    await expect(
      useConnector(db, opened.session, {
        toolKey: "notion:delete_page",
        args: { pageId: "page-1" },
        reason: "Remove the page the customer asked us to delete",
        masterKey,
        clientFactory,
      }),
    ).rejects.toMatchObject({ code: "connector_tool_not_available" });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(await db.approval.count({ where: { orgId: owner.org.id } })).toBe(0);
    const [entry] = await auditEntries(owner.org.id);
    expect(entry?.payload).toMatchObject({
      outcome: "failed",
      errorCode: "connector_tool_not_available",
    });
  });

  it("keeps personal installations out of a shared session and org ones out of a personal session", async () => {
    const owner = await fixture();
    const orgConnection = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "org-token",
    });
    const personalConnection = await connection({
      orgId: owner.org.id,
      principalId: owner.human.id,
      accessToken: "personal-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.agent.id,
      connectionId: orgConnection.id,
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.personalScope.id,
      principalId: owner.human.id,
      connectionId: personalConnection.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ messages: [] }));

    // A shared session reaching into a personal scope is refused by kind, not
    // merely by the chain: the filter holds even when the chain names it.
    const shared = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      scopeChain: [owner.orgScope.id, owner.personalScope.id, owner.sharedScope.id],
    });
    const fromShared = await useConnector(db, shared.session, {
      toolKey: READ_TOOL,
      args: {},
      reason: "Read the shared inbox",
      masterKey,
      fetch,
    });
    expect(fromShared).toMatchObject({ status: "executed" });
    expect(authorizationOf(fetch)).toBe("Bearer org-token");

    // A personal session sees its own installation and nothing wider.
    fetch.mockClear();
    const personal = await openTestSession(owner, {
      scope: owner.personalScope,
      actingPrincipalId: owner.human.id,
      requesterPrincipalId: owner.human.id,
    });
    const fromPersonal = await useConnector(db, personal.session, {
      toolKey: READ_TOOL,
      args: {},
      reason: "Read my own inbox",
      masterKey,
      fetch,
    });
    expect(fromPersonal).toMatchObject({ status: "executed" });
    expect(authorizationOf(fetch)).toBe("Bearer personal-token");

    // With the personal installation gone, the org one is not a fallback.
    fetch.mockClear();
    await db.item.deleteMany({ where: { orgId: owner.org.id, scopeId: owner.personalScope.id } });
    await expect(
      useConnector(db, personal.session, {
        toolKey: READ_TOOL,
        args: {},
        reason: "Read my own inbox",
        masterKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: "connector_tool_not_available" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pauses a write for approval, executes once it is granted, and refuses a second run", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    const item = await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ id: "draft-1" }));
    const args = { message: { raw: "body" } };
    const call = {
      toolKey: WRITE_TOOL,
      args,
      reason: "Draft the reply the customer asked for",
      masterKey,
      fetch,
    };

    const paused = await useConnector(db, opened.session, call);
    expect(paused).toMatchObject({ status: "approval_required", sensitivity: "write" });
    expect(fetch).not.toHaveBeenCalled();
    const approvalId = (paused as { approvalId: string }).approvalId;

    const approval = await db.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: owner.org.id, id: approvalId } },
    });
    // The connector tool key is the approval's tool key, verbatim.
    expect(approval.toolKey).toBe(WRITE_TOOL);
    expect(approval.sessionId).toBe(opened.session.id);
    expect(approval.argsHash).toBe(hashApprovalArgs(args));
    // What the approver is deciding about is recorded with the decision.
    expect(approval.executionBinding).toEqual({
      installationItemId: item.id,
      connectionId: stored.id,
    });

    // Asking again while the first ask waits is one decision, not two.
    const again = await useConnector(db, opened.session, call);
    expect(again).toMatchObject({ status: "approval_required", approvalId });

    // Executing before the decision is refused.
    await expect(useConnector(db, opened.session, { ...call, approvalId })).rejects.toMatchObject({
      code: "not_approved",
    });

    await approveApproval(db, {
      orgId: owner.org.id,
      approvalId,
      approverPrincipalId: owner.human.id,
    });

    // A changed call is a different call, and the decision does not cover it.
    await expect(
      useConnector(db, opened.session, {
        ...call,
        args: { message: { raw: "something else" } },
        approvalId,
      }),
    ).rejects.toMatchObject({ code: "args_changed" });
    expect(fetch).not.toHaveBeenCalled();

    const executed = await useConnector(db, opened.session, { ...call, approvalId });
    expect(executed).toMatchObject({
      status: "executed",
      approvalId,
      result: { ok: true, status: 200, body: { id: "draft-1" } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // At most once: the claim is spent.
    await expect(useConnector(db, opened.session, { ...call, approvalId })).rejects.toMatchObject({
      code: "already_executed",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    const outcomes = (await auditEntries(owner.org.id)).map(
      (entry) => (entry.payload as { outcome: string }).outcome,
    );
    expect(outcomes).toEqual([
      "approval_required",
      "approval_required",
      "failed",
      "failed",
      "executed",
      "failed",
    ]);
    const entries = await auditEntries(owner.org.id);
    expect(entries.every((entry) => entry.subject === item.id)).toBe(true);
    // The arguments never leave the approval row for the audit stream.
    expect(JSON.stringify(entries)).not.toContain("body");
  });

  it("refuses an approval granted for another call", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const first = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const second = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ id: "draft-1" }));
    const args = { message: { raw: "body" } };

    const paused = await useConnector(db, first.session, {
      toolKey: WRITE_TOOL,
      args,
      reason: "Draft the reply",
      masterKey,
      fetch,
    });
    const approvalId = (paused as { approvalId: string }).approvalId;
    await approveApproval(db, {
      orgId: owner.org.id,
      approvalId,
      approverPrincipalId: owner.human.id,
    });

    await expect(
      useConnector(db, second.session, {
        toolKey: WRITE_TOOL,
        args,
        reason: "Draft the reply",
        approvalId,
        masterKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * The approve round trip, up to the point where a person has said yes and the
   * run is about to call again. Everything after that is what each binding test
   * changes underneath the decision.
   */
  async function approvedWrite(owner: Fixture) {
    const first = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "approved-token",
    });
    const second = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "swapped-token",
    });
    const item = await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: first.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ id: "draft-1" }));
    const call = {
      toolKey: WRITE_TOOL,
      args: { message: { raw: "body" } },
      reason: "Draft the reply the customer asked for",
      masterKey,
      fetch,
    };

    const paused = await useConnector(db, opened.session, call);
    const approvalId = (paused as { approvalId: string }).approvalId;
    await approveApproval(db, {
      orgId: owner.org.id,
      approvalId,
      approverPrincipalId: owner.human.id,
    });
    return { first, second, item, opened, fetch, call, approvalId };
  }

  it("refuses an approved call whose installation was repointed at another connection", async () => {
    const owner = await fixture();
    const approved = await approvedWrite(owner);

    // An admin repoints the installation while the approval waits. The tool,
    // the arguments and the session are unchanged; the credential is not.
    await db.item.update({
      where: { orgId_id: { orgId: owner.org.id, id: approved.item.id } },
      data: {
        body: {
          catalogKey: "google_workspace",
          connectionId: approved.second.id,
          enabledTools: "all",
        } satisfies Prisma.InputJsonObject,
      },
    });

    await expect(
      useConnector(db, approved.opened.session, {
        ...approved.call,
        approvalId: approved.approvalId,
      }),
    ).rejects.toMatchObject({ code: "approval_superseded" });
    expect(approved.fetch).not.toHaveBeenCalled();

    // Refused before the claim, so the decision is still there to be re-asked
    // against rather than burned on a call nobody approved.
    const approval = await db.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: owner.org.id, id: approved.approvalId } },
    });
    expect(approval.status).toBe("approved");
    expect(approval.executedAt).toBeNull();
    const outcomes = (await auditEntries(owner.org.id)).map((entry) => entry.payload);
    expect(outcomes).toMatchObject([
      { outcome: "approval_required" },
      { outcome: "failed", errorCode: "approval_superseded" },
    ]);
  });

  it("refuses an approved call whose tool was reclassified as more sensitive", async () => {
    const owner = await fixture();
    const approved = await approvedWrite(owner);

    // Same installation, same connection, but the class the approver saw is no
    // longer the class that would run.
    await db.item.update({
      where: { orgId_id: { orgId: owner.org.id, id: approved.item.id } },
      data: {
        body: {
          catalogKey: "google_workspace",
          connectionId: approved.first.id,
          enabledTools: "all",
          sensitivityOverrides: { create_draft: "destructive" },
        } satisfies Prisma.InputJsonObject,
      },
    });

    await expect(
      useConnector(db, approved.opened.session, {
        ...approved.call,
        approvalId: approved.approvalId,
      }),
    ).rejects.toMatchObject({ code: "approval_superseded" });
    expect(approved.fetch).not.toHaveBeenCalled();
    await expect(
      db.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: owner.org.id, id: approved.approvalId } },
      }),
    ).resolves.toMatchObject({ status: "approved", executedAt: null });
  });

  it("refuses an approval replayed against a different tool in the same session", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ id: "event-1" }));

    const paused = await useConnector(db, opened.session, {
      toolKey: WRITE_TOOL,
      args: {},
      reason: "Draft the reply",
      masterKey,
      fetch,
    });
    const approvalId = (paused as { approvalId: string }).approvalId;
    await approveApproval(db, {
      orgId: owner.org.id,
      approvalId,
      approverPrincipalId: owner.human.id,
    });

    // Same session, same arguments, same fingerprint — a different call.
    await expect(
      useConnector(db, opened.session, {
        toolKey: "google_workspace:create_event",
        args: {},
        reason: "Put it in the calendar",
        approvalId,
        masterKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a policy denial as a result rather than an error", async () => {
    const owner = await fixture();
    await db.policy.create({
      data: {
        orgId: owner.org.id,
        scopeId: owner.sharedScope.id,
        sensitivity: "write",
        action: "deny",
      },
    });
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const fetch: FetchMock = vi.fn();

    const denied = await useConnector(db, opened.session, {
      toolKey: WRITE_TOOL,
      args: { message: { raw: "body" } },
      reason: "Draft the reply",
      masterKey,
      fetch,
    });

    expect(denied).toMatchObject({ status: "denied", sensitivity: "write" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.approval.count({ where: { orgId: owner.org.id } })).toBe(0);
    const [entry] = await auditEntries(owner.org.id);
    expect(entry?.payload).toMatchObject({ outcome: "denied" });
  });

  it("refuses the reserved context namespace and an approval that does not exist, and records both", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    await expect(
      useConnector(db, opened.session, {
        toolKey: "context:activate_item",
        args: { itemId: randomUUID() },
        reason: "Turn it on",
        masterKey,
      }),
    ).rejects.toMatchObject({ code: "connector_tool_not_available" });

    // A call naming an approval nobody granted is refused the same way, and is
    // just as much a thing an auditor wants to see.
    await expect(
      useConnector(db, opened.session, {
        toolKey: WRITE_TOOL,
        args: { message: { raw: "body" } },
        reason: "Draft the reply",
        approvalId: randomUUID(),
        masterKey,
      }),
    ).rejects.toMatchObject({ name: "ApprovalNotFoundError" });

    // Nothing enters this tool and leaves without a row.
    const outcomes = (await auditEntries(owner.org.id)).map((entry) => entry.payload);
    expect(outcomes).toMatchObject([
      { outcome: "failed", errorCode: "connector_tool_not_available" },
      { outcome: "failed", errorCode: "approval_not_found" },
    ]);
  });

  it("names a broken installation as misconfigured rather than as something to retry", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    // The connection the installation points at is gone.
    await db.connectorConnection.delete({ where: { id: stored.id } });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    const connectorFetch: FetchMock = vi.fn();
    const app = createApp({ db, auth, env, connectorFetch });
    const client = await dataPlaneClient(app, opened.token);

    const answered = (await client.callTool({
      name: "use_connector",
      arguments: { toolKey: READ_TOOL, args: {}, reason: "Read the shared inbox" },
    })) as CallToolResult;

    expect(answered.isError).toBe(true);
    expect(codedFailure(answered)).toMatchObject({ code: "connector_misconfigured" });
    expect(connectorFetch).not.toHaveBeenCalled();
    const [entry] = await auditEntries(owner.org.id);
    expect(entry?.payload).toMatchObject({
      outcome: "failed",
      errorCode: "connector_misconfigured",
    });
    await client.close();
  });

  it("returns a completed execution even when its audit row cannot be written", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "shared-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ messages: [] }));

    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
    const outcome = await withLogger(logger, () =>
      useConnector(withFailingAuditWrite(db), opened.session, {
        toolKey: READ_TOOL,
        args: {},
        reason: "Find the customer's last message",
        masterKey,
        fetch,
      }),
    );

    // The call happened. Telling the run it failed would invite a retry of a
    // side effect that already left the deployment.
    expect(outcome).toMatchObject({ status: "executed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("Connector audit write failed");
  });

  it("runs the whole approval round trip over the MCP mount without leaking the credential", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "top-secret-token",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
      requesterPrincipalId: owner.human.id,
    });
    const connectorFetch: FetchMock = vi.fn(async () => jsonResponse({ id: "draft-1" }));
    const app = createApp({ db, auth, env, connectorFetch });

    const client = new Client({ name: "connector-proxy-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${opened.token}` } },
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport as Parameters<Client["connect"]>[0]);

    const args = { message: { raw: "hello" } };
    const paused = (await client.callTool({
      name: "use_connector",
      arguments: { toolKey: WRITE_TOOL, args, reason: "Draft the customer reply" },
    })) as CallToolResult;
    expect(paused.isError).toBeFalsy();
    const pausedContent = paused.structuredContent as { status: string; approvalId: string };
    expect(pausedContent.status).toBe("approval_required");
    expect(connectorFetch).not.toHaveBeenCalled();

    await approveApproval(db, {
      orgId: owner.org.id,
      approvalId: pausedContent.approvalId,
      approverPrincipalId: owner.human.id,
    });

    const executed = (await client.callTool({
      name: "use_connector",
      arguments: {
        toolKey: WRITE_TOOL,
        args,
        reason: "Draft the customer reply",
        approvalId: pausedContent.approvalId,
      },
    })) as CallToolResult;
    expect(executed.isError).toBeFalsy();
    expect(executed.structuredContent).toMatchObject({
      status: "executed",
      toolKey: WRITE_TOOL,
      result: { ok: true, status: 200, body: { id: "draft-1" } },
    });

    // A refusal the harness can switch on, as data rather than a protocol error.
    const mismatched = (await client.callTool({
      name: "use_connector",
      arguments: {
        toolKey: WRITE_TOOL,
        args: { message: { raw: "changed" } },
        reason: "Draft the customer reply",
        approvalId: pausedContent.approvalId,
      },
    })) as CallToolResult;
    expect(mismatched.isError).toBe(true);
    const [failure] = mismatched.content ?? [];
    expect(JSON.parse(failure?.type === "text" ? failure.text : "{}")).toMatchObject({
      code: "args_changed",
    });

    // At most once, said through the tool surface: the claim is spent, and the
    // provider is not asked a second time.
    const replayed = (await client.callTool({
      name: "use_connector",
      arguments: {
        toolKey: WRITE_TOOL,
        args,
        reason: "Draft the customer reply",
        approvalId: pausedContent.approvalId,
      },
    })) as CallToolResult;
    expect(replayed.isError).toBe(true);
    expect(codedFailure(replayed)).toMatchObject({ code: "already_executed" });
    expect(connectorFetch).toHaveBeenCalledTimes(1);

    const everything = JSON.stringify([paused, executed, mismatched, replayed]);
    expect(everything).not.toContain("top-secret-token");
    expect(JSON.stringify(await auditEntries(owner.org.id))).not.toContain("top-secret-token");
    await client.close();
  });

  it("keeps the access token out of every tool reply and every log line", async () => {
    const owner = await fixture();
    const token = "leaky-provider-token";
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: token,
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    // A chatty provider: it echoes the credential it was given, first in a
    // result body and then in a failure body. Both are the model's to read.
    let calls = 0;
    const connectorFetch: FetchMock = vi.fn(async (_url, init) => {
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      calls += 1;
      return calls === 1
        ? jsonResponse({ echoed: authorization, messages: [] })
        : jsonResponse({ error: "unauthorized", detail: `token ${token} is not valid` }, 400);
    });
    const app = createApp({ db, auth, env, connectorFetch });

    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
    const { executed, failed } = await withLogger(logger, async () => {
      const client = await dataPlaneClient(app, opened.token);
      const call = { toolKey: READ_TOOL, args: {}, reason: "Find the customer's last message" };
      const executed = (await client.callTool({
        name: "use_connector",
        arguments: call,
      })) as CallToolResult;
      const failed = (await client.callTool({
        name: "use_connector",
        arguments: call,
      })) as CallToolResult;
      await client.close();
      return { executed, failed };
    });

    expect(executed.structuredContent).toMatchObject({ status: "executed" });
    expect(JSON.stringify(executed)).toContain("[REDACTED]");
    expect(failed.isError).toBe(true);
    expect(codedFailure(failed)).toMatchObject({ code: "connector_transport_failed" });

    // The proxy exists so the model never holds the credential, and an operator
    // reading the log never finds it either.
    const written = lines.join("\n");
    expect(written).toContain("Connector tool call completed");
    expect(written).toContain("Connector tool call failed");
    for (const text of [JSON.stringify(executed), JSON.stringify(failed), written]) {
      expect(text).not.toContain(token);
    }
  });

  it("asks for a reconnect when the credential is revoked or has expired for good", async () => {
    const owner = await fixture();
    const revoked = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "revoked-token",
      revokedAt: new Date(),
    });
    const item = await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: revoked.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    const connectorFetch: FetchMock = vi.fn();
    const app = createApp({ db, auth, env, connectorFetch });
    const client = await dataPlaneClient(app, opened.token);
    const call = { toolKey: READ_TOOL, args: {}, reason: "Read the shared inbox" };

    const afterRevocation = (await client.callTool({
      name: "use_connector",
      arguments: call,
    })) as CallToolResult;
    expect(afterRevocation.isError).toBe(true);
    expect(codedFailure(afterRevocation)).toMatchObject({ code: "reconnect_needed" });

    // The other way a credential dies: past its expiry with nothing to refresh
    // it. Same answer, because the person has to reconnect either way.
    const expired = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "expired-token",
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.item.update({
      where: { orgId_id: { orgId: owner.org.id, id: item.id } },
      data: {
        body: {
          catalogKey: "google_workspace",
          connectionId: expired.id,
          enabledTools: "all",
        } satisfies Prisma.InputJsonObject,
      },
    });
    const afterExpiry = (await client.callTool({
      name: "use_connector",
      arguments: call,
    })) as CallToolResult;
    expect(afterExpiry.isError).toBe(true);
    expect(codedFailure(afterExpiry)).toMatchObject({ code: "reconnect_needed" });

    // Neither refusal reached the provider, and both are in the audit stream.
    expect(connectorFetch).not.toHaveBeenCalled();
    const outcomes = (await auditEntries(owner.org.id)).map((entry) => entry.payload);
    expect(outcomes).toMatchObject([
      { outcome: "failed", errorCode: "reconnect_needed" },
      { outcome: "failed", errorCode: "reconnect_needed" },
    ]);
    await client.close();
  });

  it("answers a failure nobody classified generically, and logs its class and nothing else", async () => {
    const owner = await fixture();
    const token = "unclassified-path-token";
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    // Resolution dies on an error nothing on this path has a vocabulary for,
    // carrying text that a real infrastructure failure could just as easily
    // carry. The audit write still works, so the refusal is recorded.
    const connectorFetch: FetchMock = vi.fn();
    const app = createApp({
      db: withFailingItemQuery(db, `boom ${token}`),
      auth,
      env,
      connectorFetch,
    });

    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
    const answered = await withLogger(logger, async () => {
      const client = await dataPlaneClient(app, opened.token);
      const result = (await client.callTool({
        name: "use_connector",
        arguments: { toolKey: READ_TOOL, args: {}, reason: "Read the shared inbox" },
      })) as CallToolResult;
      await client.close();
      return result;
    });

    expect(answered.isError).toBe(true);
    const [content] = answered.content ?? [];
    expect(content?.type === "text" ? content.text : "").toBe(
      "The context app could not complete the call",
    );
    // The class of the failure is the whole of what the mount may say about it.
    const written = lines.join("\n");
    expect(written).toContain("Data-plane tool failed");
    expect(written).toContain("errorName=Error");
    expect(written).not.toContain("boom");
    expect(written).not.toContain(token);
    // The refusal itself still made it into the audit, unclassified as it is.
    const entries = await auditEntries(owner.org.id);
    expect(entries.map((entry) => (entry.payload as { errorCode?: string }).errorCode)).toEqual([
      "unknown",
    ]);
  });

  it("keeps the refusal's code when recording the refusal fails", async () => {
    const owner = await fixture();
    const token = "audit-down-token";
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: token,
      revokedAt: new Date(),
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    // The call is refused, and then recording the refusal fails too. The
    // reconnect answer is what the harness acts on, so it must survive the
    // audit's failure — and the audit error's text must not reach the log.
    const connectorFetch: FetchMock = vi.fn();
    const app = createApp({
      db: withFailingAuditWrite(db, `boom ${token}`),
      auth,
      env,
      connectorFetch,
    });

    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
    const answered = await withLogger(logger, async () => {
      const client = await dataPlaneClient(app, opened.token);
      const result = (await client.callTool({
        name: "use_connector",
        arguments: { toolKey: READ_TOOL, args: {}, reason: "Read the shared inbox" },
      })) as CallToolResult;
      await client.close();
      return result;
    });

    expect(answered.isError).toBe(true);
    expect(codedFailure(answered).code).toBe("reconnect_needed");
    const written = lines.join("\n");
    expect(written).toContain("Connector audit write failed");
    expect(written).not.toContain("boom");
    expect(written).not.toContain(token);
  });

  it("runs a tool on an MCP provider server end to end", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.agent.id,
      accessToken: "notion-token",
      providerKey: "notion",
      mode: "mcp_oauth",
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.agent.id,
      connectionId: stored.id,
      catalogKey: "notion",
      syncedTools: [{ name: "search_pages", sensitivity: "read" }],
    });
    const opened = await openTestSession(owner, {
      scope: owner.sharedScope,
      actingPrincipalId: owner.agent.id,
    });
    const received: { query: string; authorization: string | null }[] = [];
    const app = createApp({ db, auth, env, connectorFetch: providerMcpServer(received) });

    const client = await dataPlaneClient(app, opened.token);
    const answered = (await client.callTool({
      name: "use_connector",
      arguments: {
        toolKey: "notion:search_pages",
        args: { query: "roadmap" },
        reason: "Find the roadmap page the customer asked about",
      },
    })) as CallToolResult;

    // Session token in, provider tool result out, across two MCP hops.
    expect(answered.isError).toBeFalsy();
    expect(answered.structuredContent).toMatchObject({
      status: "executed",
      toolKey: "notion:search_pages",
      result: { content: [{ type: "text", text: "3 pages match roadmap" }] },
    });
    expect(received).toEqual([{ query: "roadmap", authorization: "Bearer notion-token" }]);
    expect(JSON.stringify(answered)).not.toContain("notion-token");
    await client.close();
  });
});
