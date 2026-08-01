import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import {
  githubProvider,
  googleWorkspaceProvider,
  loadProviderCatalog,
  slackProvider,
} from "@trema/connectors";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "#server/app.js";
import { createAuth } from "#server/lib/auth/index.js";
import { decryptEnvelope, encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { connectorsRouter } from "#server/rpc/connectors.js";
import { orgRouter } from "#server/rpc/org.js";
import {
  ConnectorAccountMismatchError,
  ConnectorConnectionNotFoundError,
  completeOAuthCallback,
  consumeOAuthState,
  createClientRegistration,
  createConnectorInstallation,
  createStaticConnection,
  hashOAuthState,
  listConnectorConnections,
  listConnectorInstallationHealth,
  type McpClientFactory,
  OAuthStateExpiredError,
  OAuthStateSingleUseError,
  OAuthTokenExchangeError,
  StaticCredentialValidationError,
  startOAuthConnect,
  UnsupportedConnectorAuthModeError,
} from "#server/services/connectors/index.js";

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
const googleWorkspaceOAuthCatalog = loadProviderCatalog([googleWorkspaceProvider]);

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

  async function storedConnection(orgId: string, ownerPrincipalId: string, providerKey = "github") {
    return db.connectorConnection.create({
      data: {
        orgId,
        ownerPrincipalId,
        providerKey,
        authMode: "oauth2_code",
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

  function googleIdToken(claims: Record<string, unknown>) {
    return [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "signature",
    ].join(".");
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
    const initiator = await db.principal.findFirstOrThrow({
      where: { orgId, kind: "human", deactivatedAt: null },
      select: { id: true },
    });
    const started = await startOAuthConnect(db, {
      orgId,
      scopeId: (
        await db.scope.findFirstOrThrow({
          where: { orgId, kind: "org" },
          select: { id: true },
        })
      ).id,
      ownerPrincipalId: agent.id,
      initiatedByPrincipalId: initiator.id,
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

  async function startGoogleWorkspace(orgId: string, reconnectConnectionId?: string) {
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId, kind: "agent" },
      select: { id: true },
    });
    const initiator = await db.principal.findFirstOrThrow({
      where: { orgId, kind: "human", deactivatedAt: null },
      select: { id: true },
    });
    const started = await startOAuthConnect(db, {
      orgId,
      scopeId: (
        await db.scope.findFirstOrThrow({
          where: { orgId, kind: "org" },
          select: { id: true },
        })
      ).id,
      ownerPrincipalId: agent.id,
      initiatedByPrincipalId: initiator.id,
      providerKey: "google_workspace",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: googleWorkspaceOAuthCatalog,
      ...(reconnectConnectionId ? { reconnectConnectionId } : {}),
    });
    return new URL(started.authorizationUrl).searchParams.get("state")!;
  }

  it("derives the organization agent principal server-side for admin OAuth", async () => {
    const org = await createOrg();
    const started = await call(
      connectorsRouter.connect.startOAuth,
      {
        scopeId: org.orgScope.id,
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
      scopeId: org.orgScope.id,
      providerKey: "github",
      ownerPrincipalId: org.agent.id,
      initiatedByPrincipalId: org.principal.id,
      connectionId: null,
      config: {},
      providerScopes: ["repo", "read:org"],
    });
    expect(pending.ownerPrincipalId).not.toBe(org.principal.id);

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
      ownerPrincipalId: org.agent.id,
      providerScopes: ["repo", "read:org"],
    });
    expect(completed.installation).toMatchObject({
      scopeId: org.orgScope.id,
      body: {
        catalogKey: "github",
        connectionId: completed.connection.id,
        enabledTools: "all",
      },
    });
    await expect(
      db.auditLog.findFirstOrThrow({
        where: {
          orgId: org.org.id,
          action: "connector.oauth.callback",
          subject: completed.connection.id,
        },
      }),
    ).resolves.toMatchObject({
      actorPrincipalId: org.principal.id,
      payload: {
        credentialOwnerPrincipalId: org.agent.id,
        initiatedByPrincipalId: org.principal.id,
        scopeId: org.orgScope.id,
      },
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
    await db.connectorConnection.update({
      where: { id: stored.id },
      data: { expiresAt: new Date("2026-07-31T11:00:00.000Z") },
    });

    // The list derives a display label from the hoisted account name without
    // leaking config; an explicit rename overrides it.
    const now = new Date("2026-07-31T12:00:00.000Z");
    const [listed] = await listConnectorConnections(
      db,
      org.org.id,
      "github",
      now,
      undefined,
      masterKey,
      oauthCatalog,
    );
    expect(listed?.label).toBe("octo-org");
    expect(listed).toMatchObject({ isExpired: false, isValid: true });
    expect(JSON.stringify(listed)).not.toMatch(/"config"|account_name/);
    await expect(
      listConnectorInstallationHealth(db, {
        orgId: org.org.id,
        scopeIds: [org.orgScope.id],
        masterKey,
        now,
      }),
    ).resolves.toEqual([{ installationItemId: completed.installation.id, status: "available" }]);
    const renamed = await call(
      connectorsRouter.connections.update,
      { connectionId: completed.connection.id, label: "Primary org" },
      { context: org.context },
    );
    expect(renamed.label).toBe("Primary org");
  });

  it("uses the caller as both owner and initiator for personal OAuth", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "OAuth Member");

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
      scopeId: member.personalScope.id,
      providerKey: "github",
      ownerPrincipalId: member.principal.id,
      initiatedByPrincipalId: member.principal.id,
      connectionId: null,
    });

    const completed = await completeOAuthCallback(db, {
      state,
      code: "personal-authorization-code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: tokenFetch(),
    });
    expect(completed.installation).toMatchObject({
      scopeId: member.personalScope.id,
      body: {
        catalogKey: "github",
        connectionId: completed.connection.id,
        enabledTools: "all",
      },
    });
  });

  it("allows personal user OAuth and rejects app or non-interactive providers", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "Gated Member");
    const returnTo = "https://app.trema.example/customize?tab=connections";

    const started = await call(
      connectorsRouter.member.connect.startOAuth,
      { providerKey: "github", returnTo },
      { context: member.context },
    );
    expect(started.authorizationUrl).toContain("https://");

    await expect(
      call(
        connectorsRouter.member.connect.startOAuth,
        { providerKey: "slack", returnTo },
        { context: member.context },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not support personal OAuth"),
    });

    await expect(
      call(
        connectorsRouter.member.connect.startOAuth,
        { providerKey: "stripe", returnTo },
        { context: member.context },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not support personal OAuth"),
    });
  });

  it("exposes personal OAuth support without a provider policy surface", async () => {
    const org = await createOrg();
    const catalog = await call(connectorsRouter.catalog.list, {}, { context: org.context });
    const byKey = new Map(catalog.map((provider) => [provider.key, provider]));

    expect(byKey.get("github")?.supportsPersonalOAuth).toBe(true);
    expect(byKey.get("hubspot")?.supportsPersonalOAuth).toBe(true);
    expect(byKey.get("zendesk")?.supportsPersonalOAuth).toBe(true);
    expect(byKey.get("slack")?.supportsPersonalOAuth).toBe(false);
    expect(byKey.get("stripe")?.supportsPersonalOAuth).toBe(false);
    expect(connectorsRouter).not.toHaveProperty("providers");
    expect(connectorsRouter.member.connect).not.toHaveProperty("createStatic");
    expect(connectorsRouter.member).not.toHaveProperty("installations");
  });

  it("enforces organization ownership for app OAuth and static credentials", async () => {
    const org = await createOrg();

    await expect(
      startOAuthConnect(db, {
        orgId: org.org.id,
        scopeId: org.orgScope.id,
        ownerPrincipalId: org.principal.id,
        initiatedByPrincipalId: org.principal.id,
        providerKey: "slack",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        catalog: loadProviderCatalog([slackProvider]),
      }),
    ).rejects.toBeInstanceOf(UnsupportedConnectorAuthModeError);

    await expect(
      createStaticConnection(db, {
        orgId: org.org.id,
        ownerPrincipalId: org.principal.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_human_secret" },
        masterKey,
        fetch: async () => new Response("{}", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(StaticCredentialValidationError);
  });

  it("lists and revokes only the caller's connections", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "Connection Member");
    const other = await addMember(org.org.id, org.orgScope.id, "Other Connection Member");
    const ownConnection = await storedConnection(org.org.id, member.principal.id);
    const otherConnection = await storedConnection(org.org.id, other.principal.id);
    const installation = await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: member.principal.id,
      scopeId: member.personalScope.id,
      catalogKey: "github",
      connectionId: ownConnection.id,
    });

    const listed = await call(
      connectorsRouter.member.connections.list,
      {},
      { context: member.context },
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: ownConnection.id,
        ownerPrincipalId: member.principal.id,
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
        connectorsRouter.connections.revoke,
        { connectionId: ownConnection.id },
        { context: org.context },
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

  it("reports a stale personal REST connection for reconnect", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "REST Repair Member");
    const connection = await storedConnection(org.org.id, member.principal.id);
    const installation = await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: member.personalScope.id,
        kind: "connector",
        title: githubProvider.displayName,
        body: {
          catalogKey: githubProvider.key,
          connectionId: connection.id,
          access: { kind: "minimum_role", role: "member" },
          enabledTools: ["removed_legacy_tool"],
        },
        status: "active",
        disclosure: "retrieved",
        createdById: member.principal.id,
      },
    });

    await expect(
      call(connectorsRouter.member.availability.list, {}, { context: member.context }),
    ).resolves.toEqual([]);
    await expect(
      call(connectorsRouter.member.connections.list, {}, { context: member.context }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: connection.id,
        installations: [{ id: installation.id, scopeId: member.personalScope.id }],
      }),
    ]);

    expect(connectorsRouter.member).not.toHaveProperty("installations");
  });

  it("reports organization installation health without exposing connection metadata", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "Health Member");
    const connection = await storedConnection(org.org.id, org.agent.id, "slack");
    const installation = await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: org.orgScope.id,
      catalogKey: "slack",
      connectionId: connection.id,
    });
    const listHealth = () =>
      call(connectorsRouter.member.availability.list, {}, { context: member.context });

    await Promise.all([
      db.item.create({
        data: {
          orgId: org.org.id,
          scopeId: org.orgScope.id,
          kind: "connector",
          title: "Retired provider",
          body: {
            catalogKey: "retired_provider",
            connectionId: connection.id,
            enabledTools: "all",
          },
          status: "active",
          disclosure: "retrieved",
          createdById: org.principal.id,
        },
      }),
      db.item.create({
        data: {
          orgId: org.org.id,
          scopeId: org.orgScope.id,
          kind: "connector",
          title: "Legacy provider body",
          body: {
            catalogKey: "github",
            connectionId: connection.id,
            enabledTools: ["removed_legacy_tool"],
          },
          status: "active",
          disclosure: "retrieved",
          createdById: org.principal.id,
        },
      }),
    ]);

    await expect(listHealth()).resolves.toEqual([
      {
        itemId: installation.id,
        status: "available",
      },
    ]);

    await db.connectorConnection.update({
      where: { id: connection.id },
      data: { revokedAt: new Date() },
    });
    await expect(listHealth()).resolves.toEqual([
      expect.objectContaining({ itemId: installation.id, status: "revoked" }),
    ]);

    await db.connectorConnection.update({
      where: { id: connection.id },
      data: { revokedAt: null, expiresAt: new Date(0), refreshExhausted: false },
    });
    await expect(listHealth()).resolves.toEqual([
      expect.objectContaining({ itemId: installation.id, status: "expired" }),
    ]);

    await db.connectorConnection.update({
      where: { id: connection.id },
      data: { expiresAt: null, refreshExhausted: true },
    });
    await expect(listHealth()).resolves.toEqual([
      expect.objectContaining({
        itemId: installation.id,
        status: "refresh_exhausted",
      }),
    ]);
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

  it("revalidates shared-scope authorization before callback provisioning", async () => {
    const org = await createOrg();
    const shared = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Support" },
    });
    const started = await call(
      connectorsRouter.connect.startOAuth,
      {
        scopeId: shared.id,
        providerKey: "github",
        returnTo: "https://app.trema.example/settings/connectors/github",
      },
      { context: org.context },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await db.grant.deleteMany({
      where: { orgId: org.org.id, principalId: org.principal.id },
    });

    await expect(
      completeOAuthCallback(db, {
        state,
        code: "authorization-code",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: tokenFetch(),
      }),
    ).rejects.toThrow("no longer authorized");
    await expect(db.connectorConnection.count({ where: { orgId: org.org.id } })).resolves.toBe(0);
    await expect(
      db.item.count({ where: { orgId: org.org.id, scopeId: shared.id, kind: "connector" } }),
    ).resolves.toBe(0);
  });

  it("rejects an OAuth reconnect that targets another connection's bound scope", async () => {
    const org = await createOrg();
    const shared = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Support" },
    });
    const orgConnection = await storedConnection(org.org.id, org.agent.id);
    const sharedConnection = await storedConnection(org.org.id, org.agent.id);
    await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: org.orgScope.id,
      catalogKey: "github",
      connectionId: orgConnection.id,
    });
    const sharedInstallation = await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: shared.id,
      catalogKey: "github",
      connectionId: sharedConnection.id,
    });
    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      scopeId: shared.id,
      ownerPrincipalId: org.agent.id,
      initiatedByPrincipalId: org.principal.id,
      providerKey: "github",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      reconnectConnectionId: orgConnection.id,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(
      completeOAuthCallback(db, {
        state,
        code: "authorization-code",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: tokenFetch(),
      }),
    ).rejects.toThrow("OAuth reconnect scope must already be bound");
    await expect(
      db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: sharedInstallation.id } },
      }),
    ).resolves.toMatchObject({
      body: {
        catalogKey: "github",
        connectionId: sharedConnection.id,
      },
    });
  });

  it("does not activate an installation when the OAuth callback fails", async () => {
    const org = await createOrg();
    const state = await start(org.org.id);
    await expect(
      completeOAuthCallback(db, {
        state,
        code: "authorization-code",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: async () => new Response("denied", { status: 401 }),
      }),
    ).rejects.toBeInstanceOf(OAuthTokenExchangeError);
    await expect(
      db.item.count({ where: { orgId: org.org.id, kind: "connector", status: "active" } }),
    ).resolves.toBe(0);
    await expect(db.connectorConnection.count({ where: { orgId: org.org.id } })).resolves.toBe(0);
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
      ownerPrincipalId: org.agent.id,
      scopeId: org.orgScope.id,
      initiatedByPrincipalId: org.principal.id,
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
      ownerPrincipalId: org.agent.id,
      scopeId: org.orgScope.id,
      initiatedByPrincipalId: org.principal.id,
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
    const app = createApp({ db, auth, env, connectorFetch, mcpClientFactory: clientFactory });
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
      ownerPrincipalId: org.agent.id,
      authMode: "mcp_oauth",
      config: {
        workspace_id: "notion-workspace",
        user_id: "notion-user",
      },
      providerScopes: ["default"],
    });

    const duplicateStarted = await startOAuthConnect(db, {
      orgId: org.org.id,
      ownerPrincipalId: org.agent.id,
      scopeId: org.orgScope.id,
      initiatedByPrincipalId: org.principal.id,
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

    const sharedScope = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Shared Notion" },
    });
    const sharedInstallation = await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: sharedScope.id,
      catalogKey: "notion",
      connectionId: connectionId!,
      enabledTools: "all",
      clientFactory,
      masterKey,
    });
    const reconnectStarted = await startOAuthConnect(db, {
      orgId: org.org.id,
      scopeId: org.orgScope.id,
      ownerPrincipalId: org.agent.id,
      initiatedByPrincipalId: org.principal.id,
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

    const installation = await db.item.findFirstOrThrow({
      where: {
        orgId: org.org.id,
        scopeId: orgScope.id,
        kind: "connector",
        status: "active",
      },
    });
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
          annotations: { readOnlyHint: true },
        },
      ],
    });
    await expect(
      db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: sharedInstallation.id } },
      }),
    ).resolves.toMatchObject({
      body: {
        catalogKey: "notion",
        connectionId,
        enabledTools: "all",
        syncedTools: [
          {
            name: "notion-search",
            description: "Search the connected Notion workspace",
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
    expect(clientFactory).toHaveBeenCalledTimes(5);
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
    await db.item.update({
      where: { orgId_id: { orgId: org.org.id, id: first.installation.id } },
      data: {
        body: {
          catalogKey: "github",
          connectionId: first.connection.id,
          enabledTools: [],
        },
      },
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
    expect(second.installation.id).toBe(first.installation.id);
    expect(second.installation.body).toMatchObject({ enabledTools: [] });
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

  it("rejects reconnecting an existing connection to a different provider account", async () => {
    const org = await createOrg();
    const first = await completeOAuthCallback(db, {
      state: await start(org.org.id),
      code: "first",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: tokenFetch({ access_token: "original-token", account_name: "octo-org" }),
    });
    const original = await db.connectorConnection.findUniqueOrThrow({
      where: { id: first.connection.id },
    });

    await expect(
      completeOAuthCallback(db, {
        state: await start(org.org.id, { reconnectConnectionId: first.connection.id }),
        code: "second",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: tokenFetch({ access_token: "wrong-account-token", account_name: "hooli" }),
      }),
    ).rejects.toBeInstanceOf(ConnectorAccountMismatchError);

    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: first.connection.id } }),
    ).resolves.toMatchObject({
      config: { account_name: "octo-org" },
      ciphertext: original.ciphertext,
    });
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

  it("hoists Google id-token identity before same-account matching on reconnect", async () => {
    const org = await createOrg();
    await createClientRegistration(db, {
      orgId: org.org.id,
      providerKey: "google_workspace",
      source: "customer",
      clientId: "google-client",
      clientSecret: "google-secret",
      masterKey,
    });
    const claims = { sub: "google-subject", email: "ada@example.com", hd: "example.com" };
    const complete = (state: string, accessToken: string) =>
      completeOAuthCallback(db, {
        state,
        code: "google-authorization-code",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: googleWorkspaceOAuthCatalog,
        fetch: tokenFetch({ access_token: accessToken, id_token: googleIdToken(claims) }),
      });

    const first = await complete(await startGoogleWorkspace(org.org.id), "first-google-token");
    await expect(
      listConnectorConnections(
        db,
        org.org.id,
        "google_workspace",
        new Date(),
        undefined,
        masterKey,
        googleWorkspaceOAuthCatalog,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: first.connection.id, label: "ada@example.com" }),
    ]);
    // A fresh OAuth connect has no connection id to fall back to, so this
    // assertion proves the hook ran before same-account matching.
    const matched = await complete(await startGoogleWorkspace(org.org.id), "second-google-token");
    expect(matched.connection.id).toBe(first.connection.id);

    const explicitReconnect = await complete(
      await startGoogleWorkspace(org.org.id, first.connection.id),
      "replacement-google-token",
    );
    expect(explicitReconnect.connection.id).toBe(first.connection.id);
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: first.connection.id } }),
    ).resolves.toMatchObject({ config: claims });
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
        scopeId: org.orgScope.id,
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
      ownerPrincipalId: org.agent.id,
      authMode: "api_key",
      config: {},
    });
    await expect(
      db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: created.installationId } },
      }),
    ).resolves.toMatchObject({
      scopeId: org.orgScope.id,
      kind: "connector",
      status: "active",
      body: {
        catalogKey: "stripe",
        connectionId: created.id,
        enabledTools: "all",
      },
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
        ownerPrincipalId: org.agent.id,
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
        scopeId: org.orgScope.id,
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
      ownerPrincipalId: org.agent.id,
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
      ownerPrincipalId: org.agent.id,
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
        ownerPrincipalId: org.agent.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_new_secret" },
        reconnectConnectionId: "00000000-0000-7000-8000-000000000000",
        masterKey,
        fetch: okFetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorConnectionNotFoundError);
  });

  it("targets fresh static connections and preserves reconnect scope bindings", async () => {
    const org = await createOrg();
    const shared = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Static Shared Scope" },
    });
    const okFetch = async () => new Response("{}", { status: 200 });
    const organizationConnection = await call(
      connectorsRouter.connect.createStatic,
      {
        scopeId: org.orgScope.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_organization_secret" },
      },
      { context: { ...org.context, connectorFetch: okFetch } },
    );
    const sharedConnection = await call(
      connectorsRouter.connect.createStatic,
      {
        scopeId: shared.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_shared_secret" },
      },
      { context: { ...org.context, connectorFetch: okFetch } },
    );

    await expect(
      call(
        connectorsRouter.connect.createStatic,
        {
          scopeId: shared.id,
          providerKey: "stripe",
          config: {},
          credentials: { apiKey: "rk_shared_reconnected_secret" },
          reconnectConnectionId: sharedConnection.id,
        },
        { context: { ...org.context, connectorFetch: okFetch } },
      ),
    ).resolves.toMatchObject({ id: sharedConnection.id });

    const installations = await db.item.findMany({
      where: {
        orgId: org.org.id,
        kind: "connector",
        status: { not: "archived" },
      },
      select: { scopeId: true, body: true },
    });
    expect(installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeId: org.orgScope.id,
          body: expect.objectContaining({ connectionId: organizationConnection.id }),
        }),
        expect.objectContaining({
          scopeId: shared.id,
          body: expect.objectContaining({ connectionId: sharedConnection.id }),
        }),
      ]),
    );
  });

  it("requires reconnect authority across every scope bound to a connection", async () => {
    const org = await createOrg();
    const shared = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Scoped Connector Admin" },
    });
    const scopedAdmin = await addMember(
      org.org.id,
      org.orgScope.id,
      "Scoped Connector Administrator",
    );
    await db.grant.create({
      data: {
        orgId: org.org.id,
        principalId: scopedAdmin.principal.id,
        scopeId: shared.id,
        role: "admin",
      },
    });
    const okFetch = async () => new Response("{}", { status: 200 });
    const connected = await call(
      connectorsRouter.connect.createStatic,
      {
        scopeId: org.orgScope.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_original_global_secret" },
      },
      { context: { ...org.context, connectorFetch: okFetch } },
    );
    await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: shared.id,
      catalogKey: "stripe",
      connectionId: connected.id,
    });
    const before = await db.connectorConnection.findUniqueOrThrow({
      where: { id: connected.id },
      select: { ciphertext: true },
    });

    await expect(
      call(
        connectorsRouter.connect.createStatic,
        {
          scopeId: shared.id,
          providerKey: "stripe",
          config: {},
          credentials: { apiKey: "rk_unauthorized_global_replacement" },
          reconnectConnectionId: connected.id,
        },
        { context: { ...scopedAdmin.context, connectorFetch: okFetch } },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("every bound scope"),
    });
    await expect(
      db.connectorConnection.findUniqueOrThrow({
        where: { id: connected.id },
        select: { ciphertext: true },
      }),
    ).resolves.toEqual(before);
  });

  it("revalidates shared-scope authorization after static credential verification", async () => {
    const org = await createOrg();
    const shared = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Static Authorization Race" },
    });
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    let releaseVerification!: () => void;
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const delayedFetch = vi.fn(async () => {
      markVerificationStarted();
      await verificationReleased;
      return new Response("{}", { status: 200 });
    });

    const pending = call(
      connectorsRouter.connect.createStatic,
      {
        scopeId: shared.id,
        providerKey: "stripe",
        config: {},
        credentials: { apiKey: "rk_revoked_during_verification" },
      },
      { context: { ...org.context, connectorFetch: delayedFetch } },
    );
    await verificationStarted;
    await db.grant.deleteMany({
      where: { orgId: org.org.id, principalId: org.principal.id },
    });
    releaseVerification();

    await expect(pending).rejects.toThrow("no longer authorized");
    await expect(
      db.connectorConnection.count({ where: { orgId: org.org.id, providerKey: "stripe" } }),
    ).resolves.toBe(0);
    await expect(
      db.item.count({ where: { orgId: org.org.id, scopeId: shared.id, kind: "connector" } }),
    ).resolves.toBe(0);
  });

  it("consumes OAuth state once and rejects expired state", async () => {
    const org = await createOrg();
    const state = await start(org.org.id);
    await expect(consumeOAuthState(db, state)).resolves.toMatchObject({ orgId: org.org.id });
    await expect(consumeOAuthState(db, state)).rejects.toBeInstanceOf(OAuthStateSingleUseError);

    const expired = await startOAuthConnect(db, {
      orgId: org.org.id,
      scopeId: org.orgScope.id,
      ownerPrincipalId: org.agent.id,
      initiatedByPrincipalId: org.principal.id,
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
