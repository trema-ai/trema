import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { githubProvider, loadProviderCatalog } from "@trema/connectors";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { decryptEnvelope, encryptEnvelope } from "#/lib/crypto/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { connectorsRouter } from "#/rpc/connectors.js";
import { orgRouter } from "#/rpc/org.js";
import {
  ConnectorConnectionNotFoundError,
  completeOAuthCallback,
  consumeOAuthState,
  createClientRegistration,
  createStaticConnection,
  hashOAuthState,
  listConnectorConnections,
  type McpClientFactory,
  OAuthStateExpiredError,
  OAuthStateSingleUseError,
  startOAuthConnect,
} from "#/services/connectors/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 23).toString("base64");
const oauthCatalog = loadProviderCatalog([
  {
    ...githubProvider,
    auth: {
      ...githubProvider.auth,
      pkce: true,
      tokenRequestAuthMethod: "body" as const,
      tokenResponseMetadata: ["account_name"],
      accountIdentityFields: ["account_name"],
    },
  },
]);
const metadataOnlyOAuthCatalog = loadProviderCatalog([
  {
    ...githubProvider,
    auth: {
      ...githubProvider.auth,
      pkce: true,
      tokenRequestAuthMethod: "body" as const,
      tokenResponseMetadata: ["account_name"],
    },
  },
]);

integration("connector connection flows", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "connector-integration-secret-at-least-32-characters",
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

  async function signUp(name: string) {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name, email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const context = { db, auth, env, headers: new Headers({ cookie }) };
    return { user, context };
  }

  async function createOrg() {
    const owner = await signUp("Connector Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Connector Integration Org" },
      { context: owner.context },
    );
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "agent" },
    });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    await createClientRegistration(db, {
      orgId: membership.org.id,
      providerKey: "github",
      source: "customer",
      clientId: "github-client",
      clientSecret: "github-secret",
      masterKey,
    });
    return { ...owner, ...membership, agent, orgScope };
  }

  async function addMember(orgId: string, orgScopeId: string, name: string) {
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
    await Promise.all([
      db.grant.create({
        data: { orgId, principalId: principal.id, scopeId: orgScopeId, role: "member" },
      }),
      db.session.updateMany({
        where: { userId: signedUp.user.id },
        data: { activeOrgId: orgId },
      }),
    ]);
    const personalScope = await db.scope.create({
      data: { orgId, kind: "personal", name, ownerId: principal.id },
    });
    return { ...signedUp, principal, personalScope };
  }

  async function storedConnection(orgId: string, principalId: string, providerKey = "github") {
    return db.connectorConnection.create({
      data: {
        orgId,
        principalId,
        providerKey,
        mode: "oauth2_code",
        config: {},
        ciphertext: encryptEnvelope({ accessToken: "test-token" }, masterKey),
      },
    });
  }

  function tokenFetch(
    payload: Record<string, unknown> = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      scope: "repo,read:org",
      account_name: "octo-org",
    },
  ) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  }

  async function start(
    orgId: string,
    options: {
      returnTo?: string;
      reconnectConnectionId?: string;
      providerScopes?: string[];
    } = {},
  ) {
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId, kind: "agent" },
      select: { id: true },
    });
    const started = await startOAuthConnect(db, {
      orgId,
      principalId: agent.id,
      providerKey: "github",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      ...(options.returnTo ? { returnTo: options.returnTo } : {}),
      ...(options.reconnectConnectionId
        ? { reconnectConnectionId: options.reconnectConnectionId }
        : {}),
      ...(options.providerScopes ? { providerScopes: options.providerScopes } : {}),
    });
    return new URL(started.authorizationUrl).searchParams.get("state")!;
  }

  it("derives the organization agent principal server-side for admin OAuth", async () => {
    const org = await createOrg();
    const started = await call(
      connectorsRouter.connect.startOAuth,
      {
        providerKey: "github",
        returnTo: "https://app.trema.example/settings/connectors/github",
        providerScopes: ["repo", "read:org"],
      },
      { context: org.context },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const pending = await db.connectorOAuthState.findUniqueOrThrow({
      where: { stateHash: hashOAuthState(state) },
    });
    expect(pending).toMatchObject({
      orgId: org.org.id,
      providerKey: "github",
      principalId: org.agent.id,
      connectionId: null,
      config: {},
      providerScopes: ["repo", "read:org"],
    });
    expect(pending.principalId).not.toBe(org.principal.id);

    const completed = await completeOAuthCallback(db, {
      state,
      code: "authorization-code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: tokenFetch(),
    });
    expect(completed.connection).toMatchObject({
      providerKey: "github",
      principalId: org.agent.id,
      providerScopes: ["repo", "read:org"],
    });
    const stored = await db.connectorConnection.findUniqueOrThrow({
      where: { id: completed.connection.id },
    });
    expect(stored.config).toEqual({ account_name: "octo-org" });
    expect(decryptEnvelope<Record<string, unknown>>(stored.ciphertext, masterKey)).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      raw: { access_token: "access-token", account_name: "octo-org" },
    });

    // The list derives a display label from the hoisted account name without
    // leaking config; an explicit rename overrides it.
    const [listed] = await listConnectorConnections(
      db,
      org.org.id,
      "github",
      new Date(),
      undefined,
      oauthCatalog,
    );
    expect(listed?.label).toBe("octo-org");
    expect(JSON.stringify(listed)).not.toMatch(/"config"|account_name/);
    const renamed = await call(
      connectorsRouter.connections.update,
      { connectionId: completed.connection.id, label: "Primary org" },
      { context: org.context },
    );
    expect(renamed.label).toBe("Primary org");
  });

  it("derives the caller principal for member OAuth after both access gates pass", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "OAuth Member");
    await call(
      connectorsRouter.providers.updateSettings,
      { providerKey: "github", memberEnabled: true },
      { context: org.context },
    );

    const started = await call(
      connectorsRouter.member.connect.startOAuth,
      {
        providerKey: "github",
        returnTo: "https://app.trema.example/customize?tab=connections",
      },
      { context: member.context },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(
      db.connectorOAuthState.findUniqueOrThrow({
        where: { stateHash: hashOAuthState(state) },
      }),
    ).resolves.toMatchObject({
      orgId: org.org.id,
      providerKey: "github",
      principalId: member.principal.id,
      connectionId: null,
    });
  });

  it("allows member OAuth by default and rejects it once disabled or below the ceiling", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "Gated Member");
    const returnTo = "https://app.trema.example/customize?tab=connections";

    // memberConnectable is the ceiling and member access defaults on, so a
    // member may connect github without any admin opt-in.
    const started = await call(
      connectorsRouter.member.connect.startOAuth,
      { providerKey: "github", returnTo },
      { context: member.context },
    );
    expect(started.authorizationUrl).toContain("https://");

    // An explicit opt-out closes it.
    await call(
      connectorsRouter.providers.updateSettings,
      { providerKey: "github", memberEnabled: false },
      { context: org.context },
    );
    await expect(
      call(
        connectorsRouter.member.connect.startOAuth,
        { providerKey: "github", returnTo },
        { context: member.context },
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("not enabled for member connections"),
    });

    // A provider below the ceiling is never member-connectable.
    await expect(
      call(
        connectorsRouter.member.connect.startOAuth,
        { providerKey: "stripe", returnTo },
        { context: member.context },
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("not enabled for member connections"),
    });
  });

  it("lists and revokes only the caller's connections", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "Connection Member");
    const other = await addMember(org.org.id, org.orgScope.id, "Other Connection Member");
    await call(
      connectorsRouter.providers.updateSettings,
      { providerKey: "github", memberEnabled: true },
      { context: org.context },
    );
    const ownConnection = await storedConnection(org.org.id, member.principal.id);
    const otherConnection = await storedConnection(org.org.id, other.principal.id);
    const installation = await call(
      connectorsRouter.member.installations.create,
      {
        scopeId: member.personalScope.id,
        catalogKey: "github",
        connectionId: ownConnection.id,
      },
      { context: member.context },
    );

    const listed = await call(
      connectorsRouter.member.connections.list,
      {},
      { context: member.context },
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: ownConnection.id,
        principalId: member.principal.id,
        installations: [{ id: installation.id, scopeId: member.personalScope.id }],
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/ciphertext|test-token|config/);

    await expect(
      call(
        connectorsRouter.member.connections.revoke,
        { connectionId: otherConnection.id },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        connectorsRouter.member.connect.startOAuth,
        {
          providerKey: "github",
          reconnectConnectionId: otherConnection.id,
          returnTo: "https://app.trema.example/customize?tab=connections",
        },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: otherConnection.id } }),
    ).resolves.toMatchObject({ revokedAt: null });

    await expect(
      call(
        connectorsRouter.member.connections.revoke,
        { connectionId: ownConnection.id },
        { context: member.context },
      ),
    ).resolves.toMatchObject({ id: ownConnection.id });
  });

  it("appends connected=<connectionId> to the safe callback redirect", async () => {
    const org = await createOrg();
    const returnTo = "https://app.trema.example/settings/connectors/github?from=list";
    const state = await start(org.org.id, { returnTo });
    const app = createApp({ db, auth, env, connectorFetch: tokenFetch() });
    const response = await app.request(
      `https://auth.trema.example/connect/callback?state=${encodeURIComponent(state)}&code=ok`,
    );
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(
      "https://app.trema.example/settings/connectors/github",
    );
    expect(redirect.searchParams.get("from")).toBe("list");
    const connectionId = redirect.searchParams.get("connected");
    expect(connectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(
      db.connectorConnection.findUnique({ where: { id: connectionId! } }),
    ).resolves.not.toBeNull();
  });

  it("completes dynamic MCP OAuth, redirects with the connection, and syncs installation tools", async () => {
    const org = await createOrg();
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "org" },
    });
    const callbackUrl = "https://auth.trema.example/connect/callback";
    const mcpServerUrl = "https://mcp.notion.com/mcp";
    const authorizationServerUrl = "https://mcp.notion.com";
    const tokenEndpoint = `${authorizationServerUrl}/token`;
    const connectorFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("oauth-protected-resource")) {
          return new Response(
            JSON.stringify({
              resource: mcpServerUrl,
              authorization_servers: [authorizationServerUrl],
              scopes_supported: ["default"],
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              issuer: authorizationServerUrl,
              authorization_endpoint: `${authorizationServerUrl}/authorize`,
              token_endpoint: tokenEndpoint,
              registration_endpoint: `${authorizationServerUrl}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: [
                "client_secret_basic",
                "client_secret_post",
                "none",
              ],
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${authorizationServerUrl}/register`) {
          const registration = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(registration).toMatchObject({
            redirect_uris: [callbackUrl],
            token_endpoint_auth_method: "none",
          });
          return new Response(
            JSON.stringify({
              client_id: "notion-dynamic-client",
              client_secret: "notion-dynamic-secret",
              redirect_uris: [callbackUrl],
              token_endpoint_auth_method: "client_secret_post",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === tokenEndpoint) {
          const headers = new Headers(init?.headers);
          const body = new URLSearchParams(String(init?.body));
          if (
            headers.has("Authorization") ||
            body.get("client_id") !== "notion-dynamic-client" ||
            body.get("client_secret") !== "notion-dynamic-secret"
          ) {
            return new Response(
              JSON.stringify({
                error: "invalid_client",
                error_description: "client_secret_post is required",
              }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("notion-authorization-code");
          expect(body.get("redirect_uri")).toBe(callbackUrl);
          expect(body.get("resource")).toBe(mcpServerUrl);
          expect(body.get("code_verifier")).toBeTruthy();
          return new Response(
            JSON.stringify({
              access_token: "notion-access-token",
              refresh_token: "notion-refresh-token",
              token_type: "bearer",
              expires_in: 3600,
              scope: "default",
              workspace_id: "notion-workspace",
              user_id: "notion-user",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(null, { status: url === mcpServerUrl ? 401 : 404 });
      },
    ) as unknown as typeof globalThis.fetch;

    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      returnTo: "https://app.trema.example/settings/connectors/notion?from=list",
      fetch: connectorFetch,
    });
    const authorization = new URL(started.authorizationUrl);
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(authorization.searchParams.get("client_id")).toBe("notion-dynamic-client");
    expect(authorization.searchParams.get("resource")).toBe(mcpServerUrl);
    await expect(
      db.connectorOAuthState.findUniqueOrThrow({
        where: { stateHash: hashOAuthState(state!) },
      }),
    ).resolves.toMatchObject({
      orgId: org.org.id,
      providerKey: "notion",
      principalId: org.agent.id,
      connectionId: null,
      config: {},
      providerScopes: ["default"],
      tokenEndpoint,
      resource: mcpServerUrl,
    });
    await expect(
      db.clientRegistration.findFirstOrThrow({
        where: { orgId: org.org.id, providerKey: "notion", source: "dynamic" },
      }),
    ).resolves.toMatchObject({
      clientId: "notion-dynamic-client",
      tokenEndpointAuthMethod: "client_secret_post",
    });

    const app = createApp({ db, auth, env, connectorFetch });
    const callback = await app.request(
      `https://auth.trema.example/connect/callback?state=${encodeURIComponent(state!)}&code=notion-authorization-code`,
    );
    expect(callback.status).toBe(302);
    const redirect = new URL(callback.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(
      "https://app.trema.example/settings/connectors/notion",
    );
    expect(redirect.searchParams.get("from")).toBe("list");
    expect(redirect.searchParams.has("connector_error")).toBe(false);
    const connectionId = redirect.searchParams.get("connected");
    expect(connectionId).toBeTruthy();

    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: connectionId! } }),
    ).resolves.toMatchObject({
      orgId: org.org.id,
      providerKey: "notion",
      principalId: org.agent.id,
      mode: "mcp_oauth",
      config: {
        workspace_id: "notion-workspace",
        user_id: "notion-user",
      },
      providerScopes: ["default"],
    });

    const duplicateStarted = await startOAuthConnect(db, {
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      fetch: connectorFetch,
    });
    const duplicateState = new URL(duplicateStarted.authorizationUrl).searchParams.get("state");
    expect(duplicateState).toBeTruthy();
    const duplicateCallback = await app.request(
      `https://auth.trema.example/connect/callback?state=${encodeURIComponent(duplicateState!)}&code=notion-authorization-code`,
    );
    expect(new URL(duplicateCallback.headers.get("location")!).searchParams.get("connected")).toBe(
      connectionId,
    );

    const reconnectStarted = await startOAuthConnect(db, {
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      returnTo: "https://app.trema.example/settings/connectors/notion",
      reconnectConnectionId: connectionId!,
      fetch: connectorFetch,
    });
    const reconnectState = new URL(reconnectStarted.authorizationUrl).searchParams.get("state");
    expect(reconnectState).toBeTruthy();
    const reconnectCallback = await app.request(
      `https://auth.trema.example/connect/callback?state=${encodeURIComponent(reconnectState!)}&code=notion-authorization-code`,
    );
    const reconnectRedirect = new URL(reconnectCallback.headers.get("location")!);
    expect(reconnectRedirect.searchParams.get("connected")).toBe(connectionId);
    expect(reconnectRedirect.searchParams.has("connector_error")).toBe(false);
    const registrationCalls = vi
      .mocked(connectorFetch)
      .mock.calls.filter(([input]) => String(input) === `${authorizationServerUrl}/register`);
    expect(registrationCalls).toHaveLength(1);
    await expect(
      db.connectorConnection.count({ where: { orgId: org.org.id, providerKey: "notion" } }),
    ).resolves.toBe(1);

    const clientFactory = vi.fn(async ({ serverUrl, authorization }) => {
      expect(serverUrl).toBe(mcpServerUrl);
      expect(authorization).toBe("Bearer notion-access-token");
      return {
        listTools: async () => ({
          tools: [
            {
              name: "notion-search",
              description: "Search the connected Notion workspace",
              annotations: { readOnlyHint: true },
            },
          ],
        }),
        close: async () => {},
      };
    }) satisfies McpClientFactory;
    const installation = await call(
      connectorsRouter.installations.create,
      {
        scopeId: orgScope.id,
        catalogKey: "notion",
        connectionId: connectionId!,
        enabledTools: "all",
      },
      { context: { ...org.context, mcpClientFactory: clientFactory } },
    );
    const storedInstallation = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: installation.id } },
    });
    expect(storedInstallation.body).toMatchObject({
      catalogKey: "notion",
      connectionId,
      enabledTools: "all",
      syncedTools: [
        {
          name: "notion-search",
          description: "Search the connected Notion workspace",
          sensitivity: "read",
        },
      ],
    });
    expect(clientFactory).toHaveBeenCalledOnce();
  });

  it("reconnects in place and clears revocation and refresh exhaustion", async () => {
    const org = await createOrg();
    const firstState = await start(org.org.id);
    const first = await completeOAuthCallback(db, {
      state: firstState,
      code: "first",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: tokenFetch(),
    });
    await db.connectorConnection.update({
      where: { id: first.connection.id },
      data: {
        revokedAt: new Date(),
        refreshExhausted: true,
        refreshAttempts: 9,
        lastRefreshFailure: new Date(),
      },
    });

    const reconnectState = await start(org.org.id, {
      reconnectConnectionId: first.connection.id,
      providerScopes: ["repo"],
    });
    const pending = await db.connectorOAuthState.findUniqueOrThrow({
      where: { stateHash: hashOAuthState(reconnectState) },
    });
    expect(pending.connectionId).toBe(first.connection.id);
    const second = await completeOAuthCallback(db, {
      state: reconnectState,
      code: "second",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: tokenFetch({
        access_token: "replacement-token",
        scope: "repo",
        account_name: "octo-org",
      }),
    });
    expect(second.connection.id).toBe(first.connection.id);
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: first.connection.id } }),
    ).resolves.toMatchObject({
      revokedAt: null,
      refreshExhausted: false,
      refreshAttempts: 0,
      lastRefreshFailure: null,
      providerScopes: ["repo"],
    });
    await expect(
      db.connectorConnection.count({ where: { orgId: org.org.id, providerKey: "github" } }),
    ).resolves.toBe(1);
  });

  it("collapses a re-connect of the same account but keeps distinct workspaces apart", async () => {
    const org = await createOrg();
    const complete = (state: string, code: string, accountName: string) =>
      completeOAuthCallback(db, {
        state,
        code,
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: tokenFetch({ access_token: `token-${accountName}`, account_name: accountName }),
      });

    const first = await complete(await start(org.org.id), "first", "octo-org");
    // A fresh connect (no reconnectConnectionId) that lands on the same account
    // updates the existing connection rather than minting a duplicate.
    const same = await complete(await start(org.org.id), "second", "octo-org");
    expect(same.connection.id).toBe(first.connection.id);
    // A different workspace becomes its own connection.
    const other = await complete(await start(org.org.id), "third", "hooli");
    expect(other.connection.id).not.toBe(first.connection.id);

    const connections = await db.connectorConnection.findMany({
      where: { orgId: org.org.id, providerKey: "github" },
    });
    expect(connections).toHaveLength(2);
    expect(
      new Set(connections.map((row) => (row.config as { account_name?: string }).account_name)),
    ).toEqual(new Set(["octo-org", "hooli"]));
  });

  it("keeps fresh connections distinct when a provider declares metadata but no identity", async () => {
    const org = await createOrg();
    const complete = (state: string, code: string) =>
      completeOAuthCallback(db, {
        state,
        code,
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: metadataOnlyOAuthCatalog,
        fetch: tokenFetch({ access_token: `token-${code}`, account_name: "shared-metadata" }),
      });

    const first = await complete(await start(org.org.id), "first");
    const second = await complete(await start(org.org.id), "second");

    expect(second.connection.id).not.toBe(first.connection.id);
    await expect(
      db.connectorConnection.count({ where: { orgId: org.org.id, providerKey: "github" } }),
    ).resolves.toBe(2);
  });

  it("creates verified static connections for the agent and exposes metadata only", async () => {
    const org = await createOrg();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rk_test_secret");
      return new Response("{}", { status: 200 });
    });
    const created = await call(
      connectorsRouter.connect.createStatic,
      {
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_test_secret" },
      },
      { context: { ...org.context, connectorFetch: fetch } },
    );
    const stored = await db.connectorConnection.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored).toMatchObject({
      providerKey: "stripe",
      principalId: org.agent.id,
      mode: "api_key",
      config: {},
    });

    const listed = await call(
      connectorsRouter.connections.list,
      { providerKey: "stripe" },
      { context: org.context },
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.id,
        providerKey: "stripe",
        principalId: org.agent.id,
        isValid: true,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/rk_test_secret|ciphertext|config/);
  });

  it("uses a provider's named authentication header for static verification", async () => {
    const org = await createOrg();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-gamma-test-secret");
      expect(headers.has("authorization")).toBe(false);
      return new Response("{}", { status: 200 });
    });

    await call(
      connectorsRouter.connect.createStatic,
      {
        providerKey: "gamma",
        config: {},
        credentials: { apiKey: "sk-gamma-test-secret" },
      },
      { context: { ...org.context, connectorFetch: fetch } },
    );

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reconnects a static connection in place instead of creating a duplicate", async () => {
    const org = await createOrg();
    const okFetch = async () => new Response("{}", { status: 200 });
    const first = await createStaticConnection(db, {
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "stripe",
      config: {},
      credentials: { apiKey: "rk_old_secret" },
      masterKey,
      fetch: okFetch,
    });
    await db.connectorConnection.update({
      where: { id: first.id },
      data: { revokedAt: new Date(), refreshExhausted: true, refreshAttempts: 3 },
    });
    const second = await createStaticConnection(db, {
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "stripe",
      config: {},
      credentials: { apiKey: "rk_new_secret" },
      reconnectConnectionId: first.id,
      masterKey,
      fetch: okFetch,
    });
    expect(second.id).toBe(first.id);
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: first.id } }),
    ).resolves.toMatchObject({
      revokedAt: null,
      refreshExhausted: false,
      refreshAttempts: 0,
    });
    await expect(
      db.connectorConnection.count({ where: { orgId: org.org.id, providerKey: "stripe" } }),
    ).resolves.toBe(1);
    await expect(
      createStaticConnection(db, {
        orgId: org.org.id,
        principalId: org.agent.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_new_secret" },
        reconnectConnectionId: "00000000-0000-7000-8000-000000000000",
        masterKey,
        fetch: okFetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorConnectionNotFoundError);
  });

  it("consumes OAuth state once and rejects expired state", async () => {
    const org = await createOrg();
    const state = await start(org.org.id);
    await expect(consumeOAuthState(db, state)).resolves.toMatchObject({ orgId: org.org.id });
    await expect(consumeOAuthState(db, state)).rejects.toBeInstanceOf(OAuthStateSingleUseError);

    const expired = await startOAuthConnect(db, {
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "github",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const expiredState = new URL(expired.authorizationUrl).searchParams.get("state")!;
    await expect(
      consumeOAuthState(db, expiredState, new Date("2026-01-01T00:16:00Z")),
    ).rejects.toBeInstanceOf(OAuthStateExpiredError);
  });
});
