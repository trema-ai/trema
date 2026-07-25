import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import {
  gammaProvider,
  googleWorkspaceProvider,
  loadProviderCatalog,
  notionMcpProvider,
  stripeProvider,
  zendeskProvider,
} from "@trema/connectors";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { connectorsRouter } from "#server/rpc/connectors.js";
import { orgRouter } from "#server/rpc/org.js";
import {
  ConnectorApprovalRequiredError,
  ConnectorReconnectRequiredError,
  ConnectorSsrfRejectedError,
  ConnectorToolNotAvailableError,
  ConnectorToolValidationError,
  ConnectorTransportError,
  executeConnectorTool,
  type McpClientFactory,
} from "#server/services/connectors/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 73).toString("base64");

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

const basicProvider = {
  key: "basic_example",
  displayName: "Basic Example",
  categories: ["testing"],
  docsUrl: "https://basic.example/docs",
  authMode: "basic",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {
    username: { type: "string", title: "Username", secret: true },
    password: { type: "string", title: "Password", secret: true },
  },
  transport: {
    type: "rest",
    baseUrl: "https://api.basic.example",
    verification: { method: "GET", endpoints: ["/me"] },
  },
  toolManifest: [
    {
      name: "read_record",
      description: "Read one record.",
      method: "GET",
      path: "/records/{id}",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      sensitivity: "read",
    },
  ],
} as const;

integration("connector tool execution", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "connector-execute-secret-at-least-32-chars",
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
    const org = await db.org.create({ data: { name: `Execute ${randomUUID()}` } });
    const principal = await db.principal.create({
      data: { orgId: org.id, kind: "agent", displayName: "Execute agent" },
    });
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    const sharedScope = await db.scope.create({
      data: { orgId: org.id, kind: "shared", name: "Narrow" },
    });
    return { org, principal, orgScope, sharedScope };
  }

  async function connection(input: {
    orgId: string;
    principalId: string;
    providerKey: string;
    mode?: string;
    credential: Record<string, unknown>;
    config?: Record<string, string | number | boolean>;
    revokedAt?: Date;
  }) {
    return db.connectorConnection.create({
      data: {
        orgId: input.orgId,
        principalId: input.principalId,
        providerKey: input.providerKey,
        mode: input.mode ?? "oauth2_code",
        config: input.config ?? {},
        ciphertext: encryptEnvelope(input.credential, masterKey),
        ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
      },
    });
  }

  async function installation(input: {
    orgId: string;
    scopeId: string;
    principalId: string;
    catalogKey: string;
    connectionId: string;
    enabledTools?: "all" | string[];
    sensitivityOverrides?: Record<string, "read" | "write" | "destructive">;
    syncedTools?: Array<{
      name: string;
      description?: string;
      sensitivity: "read" | "write" | "destructive";
    }>;
  }) {
    return db.item.create({
      data: {
        orgId: input.orgId,
        scopeId: input.scopeId,
        kind: "connector",
        title: input.catalogKey,
        body: {
          catalogKey: input.catalogKey,
          connectionId: input.connectionId,
          enabledTools: input.enabledTools ?? "all",
          ...(input.sensitivityOverrides
            ? { sensitivityOverrides: input.sensitivityOverrides }
            : {}),
          ...(input.syncedTools ? { syncedTools: input.syncedTools } : {}),
        } satisfies Prisma.InputJsonObject,
        status: "active",
        disclosure: "retrieved",
        createdById: input.principalId,
      },
    });
  }

  function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  it("selects the narrowest exposing installation and never falls back after selection", async () => {
    const owner = await fixture();
    const broad = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "broad-token" },
    });
    const narrow = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "narrow-token" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: broad.id,
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: narrow.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ messages: [] }));

    await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.sharedScope.id, owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "google_workspace:search_messages",
      args: {},
      masterKey,
      fetch,
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer narrow-token",
    );

    await db.connectorConnection.update({
      where: { id: narrow.id },
      data: { revokedAt: new Date() },
    });
    fetch.mockClear();
    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.sharedScope.id, owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "google_workspace:search_messages",
        args: {},
        masterKey,
        fetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorReconnectRequiredError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a disabled narrow tool without falling back to a broader installation", async () => {
    const owner = await fixture();
    const broad = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "broad-token" },
    });
    const narrow = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "narrow-token" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: broad.id,
    });
    const narrowInstallation = await installation({
      orgId: owner.org.id,
      scopeId: owner.sharedScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: narrow.id,
      enabledTools: [],
    });
    const fetch: FetchMock = vi.fn();

    const failure = await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.sharedScope.id, owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "google_workspace:get_message",
      args: { id: "gmail-id" },
      masterKey,
      fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectorToolNotAvailableError);
    expect(failure).toMatchObject({ installationItemId: narrowInstallation.id });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gates write tools and honors sensitivity overrides in both directions", async () => {
    const owner = await fixture();
    const google = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "google-token" },
    });
    const item = await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: google.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ id: "draft" }));

    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "google_workspace:create_draft",
        args: { message: { raw: "body" } },
        masterKey,
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "approval_required",
      sensitivity: "write",
      installationItemId: item.id,
    });
    expect(fetch).not.toHaveBeenCalled();

    await db.item.update({
      where: { id: item.id },
      data: {
        body: {
          catalogKey: "google_workspace",
          connectionId: google.id,
          enabledTools: "all",
          sensitivityOverrides: {
            search_messages: "write",
            create_draft: "read",
          },
        },
      },
    });
    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "google_workspace:search_messages",
        args: {},
        masterKey,
        fetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorApprovalRequiredError);
    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "google_workspace:create_draft",
        args: { message: { raw: "body" } },
        masterKey,
        fetch,
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it("maps Gmail per-tool hosts, path/query params, and JSON request bodies", async () => {
    const owner = await fixture();
    const google = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "google-token" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: google.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ ok: true }));

    await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "google_workspace:get_message",
      args: { id: "a/b", format: "metadata" },
      masterKey,
      fetch,
    });
    const getUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(getUrl.origin).toBe("https://gmail.googleapis.com");
    expect(getUrl.pathname).toBe("/gmail/v1/users/me/messages/a%2Fb");
    expect(getUrl.searchParams.get("format")).toBe("metadata");

    await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "google_workspace:create_event",
      args: {
        calendarId: "team/calendar",
        summary: "Planning",
        start: { dateTime: "2026-07-25T14:00:00Z" },
      },
      masterKey,
      fetch,
      allowSensitiveToolExecution: true,
    });
    const [postUrlValue, postInit] = fetch.mock.calls[1]!;
    const postUrl = new URL(String(postUrlValue));
    expect(postUrl.origin).toBe("https://www.googleapis.com");
    expect(postUrl.pathname).toBe("/calendar/v3/calendars/team%2Fcalendar/events");
    expect(JSON.parse(String(postInit?.body))).toEqual({
      summary: "Planning",
      start: { dateTime: "2026-07-25T14:00:00Z" },
    });
  });

  it("rejects missing path params before a provider call", async () => {
    const owner = await fixture();
    const google = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: { accessToken: "google-token" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: google.id,
    });
    const fetch: FetchMock = vi.fn();
    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "google_workspace:get_message",
        args: { format: "full" },
        masterKey,
        fetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorToolValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("injects OAuth bearer, Stripe API-key, and Basic credentials", async () => {
    const owner = await fixture();
    const cases = [
      {
        providerKey: "google_workspace",
        mode: "oauth2_code",
        credential: { accessToken: "oauth-token" },
        toolKey: "google_workspace:search_messages",
        args: {},
        expected: "Bearer oauth-token",
        catalog: loadProviderCatalog([googleWorkspaceProvider]),
      },
      {
        providerKey: "stripe",
        mode: "api_key",
        credential: { apiKey: "stripe-key" },
        toolKey: "stripe:search_customers",
        args: { query: "email:'a@example.com'" },
        expected: "Bearer stripe-key",
        catalog: loadProviderCatalog([stripeProvider]),
      },
      {
        providerKey: "basic_example",
        mode: "basic",
        credential: { username: "alice", password: "basic-password" },
        toolKey: "basic_example:read_record",
        args: { id: "one" },
        expected: `Basic ${Buffer.from("alice:basic-password").toString("base64")}`,
        catalog: loadProviderCatalog([basicProvider]),
      },
    ] as const;

    for (const testCase of cases) {
      const stored = await connection({
        orgId: owner.org.id,
        principalId: owner.principal.id,
        providerKey: testCase.providerKey,
        mode: testCase.mode,
        credential: testCase.credential,
      });
      await installation({
        orgId: owner.org.id,
        scopeId: owner.orgScope.id,
        principalId: owner.principal.id,
        catalogKey: testCase.providerKey,
        connectionId: stored.id,
      });
      const fetch: FetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      await executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: testCase.toolKey,
        args: testCase.args,
        masterKey,
        fetch,
        catalog: testCase.catalog,
      });
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        testCase.expected,
      );
    }
  });

  it("injects Gamma's named API-key header and redacts it from provider errors", async () => {
    const owner = await fixture();
    const apiKey = "sk-gamma-execute-secret";
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "gamma",
      mode: "api_key",
      credential: { apiKey },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "gamma",
      connectionId: stored.id,
    });
    const fetch: FetchMock = vi.fn(async () => jsonResponse({ error: apiKey }, 400));

    const failure = await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "gamma:list_folders",
      args: {},
      masterKey,
      fetch,
      catalog: loadProviderCatalog([gammaProvider]),
    }).catch((error: unknown) => error);

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe(apiKey);
    expect(failure).toBeInstanceOf(ConnectorTransportError);
    expect(failure).toMatchObject({ status: 400, providerCode: undefined });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(apiKey);
  });

  it("honors Retry-After and re-resolves credentials before every attempt", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "zendesk",
      credential: { accessToken: "first-token" },
      config: { subdomain: "acme" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "zendesk",
      connectionId: stored.id,
    });
    const authorizations: string[] = [];
    const fetch: FetchMock = vi.fn(async (_request, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return authorizations.length === 1
        ? jsonResponse({ error: "rate_limited" }, 429, { "Retry-After": "2" })
        : jsonResponse({ results: [] });
    });
    const sleeps: number[] = [];

    await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "zendesk:search",
      args: { query: "type:ticket" },
      masterKey,
      fetch,
      catalog: loadProviderCatalog([zendeskProvider]),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        await db.connectorConnection.update({
          where: { id: stored.id },
          data: {
            ciphertext: encryptEnvelope({ accessToken: "second-token" }, masterKey),
          },
        });
      },
    });

    expect(sleeps).toEqual([2000]);
    expect(authorizations).toEqual(["Bearer first-token", "Bearer second-token"]);
  });

  it("rejects host-escaping config interpolation before a tool network call", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "zendesk",
      credential: { accessToken: "zendesk-token" },
      config: { subdomain: "attacker.example#ignored" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "zendesk",
      connectionId: stored.id,
    });
    const fetch: FetchMock = vi.fn();

    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "zendesk:search",
        args: { query: "all" },
        masterKey,
        fetch,
        catalog: loadProviderCatalog([zendeskProvider]),
      }),
    ).rejects.toBeInstanceOf(ConnectorSsrfRejectedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never includes credential material in provider failures or serialized errors", async () => {
    const owner = await fixture();
    const token = "secret-access-token";
    const refreshToken = "secret-refresh-token";
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "google_workspace",
      credential: {
        accessToken: token,
        refreshToken,
        raw: { access_token: token },
      },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "google_workspace",
      connectionId: stored.id,
    });
    const fetch: FetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: token,
          message: `provider echoed ${refreshToken}`,
        },
        400,
      ),
    );

    const failure = await executeConnectorTool(db, {
      orgId: owner.org.id,
      scopeIds: [owner.orgScope.id],
      principalId: owner.principal.id,
      toolKey: "google_workspace:search_messages",
      args: {},
      masterKey,
      fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectorTransportError);
    const serialized = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(refreshToken);
  });

  it("passes synced MCP tools through tools/call and closes the client", async () => {
    const owner = await fixture();
    const stored = await connection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      providerKey: "notion",
      mode: "mcp_oauth",
      credential: { accessToken: "notion-token" },
    });
    await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: owner.principal.id,
      catalogKey: "notion",
      connectionId: stored.id,
      syncedTools: [
        {
          name: "search_pages",
          description: "Search pages",
          sensitivity: "read",
        },
      ],
    });
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "found" }],
    }));
    const close = vi.fn(async () => {});
    const clientFactory: McpClientFactory = vi.fn(async (input) => {
      expect(input).toMatchObject({
        serverUrl: "https://mcp.notion.com/mcp",
        authorization: "Bearer notion-token",
      });
      return {
        listTools: async () => ({ tools: [] }),
        callTool,
        close,
      };
    });

    await expect(
      executeConnectorTool(db, {
        orgId: owner.org.id,
        scopeIds: [owner.orgScope.id],
        principalId: owner.principal.id,
        toolKey: "notion:search_pages",
        args: { query: "roadmap" },
        masterKey,
        catalog: loadProviderCatalog([notionMcpProvider]),
        clientFactory,
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "found" }],
    });
    expect(callTool).toHaveBeenCalledWith({
      name: "search_pages",
      arguments: { query: "roadmap" },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  async function createRpcOwner() {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "RPC Owner", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const context = { db, auth, env, headers: new Headers({ cookie }) };
    const membership = await call(orgRouter.create, { name: "RPC Connector Org" }, { context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    return { ...membership, orgScope, context };
  }

  it("maps approval-required and reconnect-required through the admin RPC", async () => {
    const owner = await createRpcOwner();
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: owner.org.id, kind: "agent" },
    });
    const stored = await connection({
      orgId: owner.org.id,
      principalId: agent.id,
      providerKey: "google_workspace",
      credential: { accessToken: "rpc-token" },
    });
    const item = await installation({
      orgId: owner.org.id,
      scopeId: owner.orgScope.id,
      principalId: agent.id,
      catalogKey: "google_workspace",
      connectionId: stored.id,
    });
    const rpcContext = {
      ...owner.context,
      connectorFetch: vi.fn(async () => jsonResponse({ ok: true })),
    };

    await expect(
      call(
        connectorsRouter.tools.execute,
        {
          scopeIds: [owner.orgScope.id],
          toolKey: "google_workspace:create_draft",
          args: { message: { raw: "body" } },
        },
        { context: rpcContext },
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: {
        code: "approval_required",
        toolKey: "google_workspace:create_draft",
        sensitivity: "write",
        installationItemId: item.id,
      },
    });

    await db.item.update({
      where: { id: item.id },
      data: {
        body: {
          catalogKey: "google_workspace",
          connectionId: stored.id,
          enabledTools: "all",
          sensitivityOverrides: { search_messages: "read" },
        },
      },
    });
    await db.connectorConnection.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      call(
        connectorsRouter.tools.execute,
        {
          scopeIds: [owner.orgScope.id],
          toolKey: "google_workspace:search_messages",
          args: {},
        },
        { context: rpcContext },
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: {
        code: "reconnect_needed",
        connectionId: stored.id,
        providerKey: "google_workspace",
        reason: "revoked",
      },
    });
  });
});
