import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import type { ProviderDefInput } from "@trema/connectors";
import { githubProvider } from "@trema/connectors";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { decryptEnvelope } from "#/lib/crypto/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { connectorsRouter } from "#/rpc/connectors.js";
import { orgRouter } from "#/rpc/org.js";
import {
  ClientRegistrationConflictError,
  ConnectorCatalogDefectError,
  CredentialVerificationError,
  completeOAuthCallback,
  createClientRegistration,
  createStaticCredential,
  hashOAuthState,
  loadProviderCatalog,
  NoClientRegistrationError,
  OAuthStateExpiredError,
  OAuthStateSingleUseError,
  resolveClientRegistration,
  startOAuthConnect,
} from "#/services/connectors/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 23).toString("base64");

// An api_key REST provider with a POST verification recipe. Linear is now an
// MCP-only provider, so this inline fixture stands in for the api_key +
// GraphQL-verification shape these credential tests exercise.
const apiKeyProvider = {
  key: "linear",
  displayName: "Linear",
  description: "Access issues, projects, and comments in Linear workspaces.",
  categories: ["project-management"],
  docsUrl: "https://linear.app/developers/graphql",
  authMode: "api_key",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {
    apiKey: {
      type: "string",
      title: "API key",
      description: "A Linear personal API key.",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: "https://api.linear.app",
    authHeader: `\${credentials.apiKey}`,
    verification: {
      method: "POST",
      endpoints: ["/graphql"],
      body: { query: "{ viewer { id } }" },
    },
  },
  toolManifest: [
    {
      name: "search_issues",
      description: "Search Linear issues using a GraphQL query.",
      method: "POST",
      path: "/graphql",
      paramsSchema: {
        type: "object",
        properties: { query: { type: "string" }, variables: { type: "object" } },
        required: ["query"],
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: false,
} satisfies ProviderDefInput;

const oauthCatalog = loadProviderCatalog([
  {
    ...githubProvider,
    auth: {
      ...githubProvider.auth,
      pkce: true,
      tokenRequestAuthMethod: "body" as const,
      tokenResponseMetadata: ["custom"],
    },
  },
]);
const linearCatalog = loadProviderCatalog([apiKeyProvider]);
const basicCatalog = loadProviderCatalog([
  {
    ...apiKeyProvider,
    key: "basic_test",
    displayName: "Basic Test",
    authMode: "basic" as const,
    auth: { defaultScopes: [] },
    credentialFields: {
      username: { type: "string" as const, title: "Username", secret: true },
      password: { type: "string" as const, title: "Password", secret: true },
    },
    transport: {
      type: "rest" as const,
      baseUrl: "https://basic.example.test",
      verification: { method: "GET" as const, endpoints: ["/me"] },
    },
  },
]);

// An mcp_oauth provider whose credential is minted by discovery + dynamic
// client registration rather than a pre-configured OAuth app.
const mcpProvider = {
  key: "notion",
  displayName: "Notion",
  description: "Access Notion pages and databases via the official MCP server.",
  categories: ["knowledge-management"],
  docsUrl: "https://developers.notion.com/docs/mcp",
  authMode: "mcp_oauth",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.notion.test/mcp" },
  memberConnectable: true,
} satisfies ProviderDefInput;
const mcpCatalog = loadProviderCatalog([mcpProvider]);

const MCP_AS_ORIGIN = "https://auth.notion.test";

// A single stub answering every HTTP step of the mcp_oauth flow: the
// unauthenticated probe, RFC 9728 protected-resource metadata, RFC 8414
// authorization-server metadata, RFC 7591 dynamic client registration, and the
// token exchange. `registerCalls` proves DCR runs at most once.
function mcpFlowFetch() {
  const state = { registerCalls: 0 };
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("oauth-protected-resource")) {
      return json({
        resource: "https://mcp.notion.test/mcp",
        authorization_servers: [`${MCP_AS_ORIGIN}/`],
        scopes_supported: ["read", "write"],
      });
    }
    if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
      return json({
        issuer: `${MCP_AS_ORIGIN}/`,
        authorization_endpoint: `${MCP_AS_ORIGIN}/authorize`,
        token_endpoint: `${MCP_AS_ORIGIN}/token`,
        registration_endpoint: `${MCP_AS_ORIGIN}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.endsWith("/register") && method === "POST") {
      state.registerCalls += 1;
      return json({
        client_id: "notion-dcr-client",
        redirect_uris: ["https://auth.trema.example/connect/callback"],
        token_endpoint_auth_method: "none",
      });
    }
    if (url.endsWith("/token") && method === "POST") {
      return json({
        access_token: "notion-access-token",
        refresh_token: "notion-refresh-token",
        token_type: "bearer",
        scope: "read",
        expires_in: 3600,
      });
    }
    return new Response(null, { status: 401 });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, state };
}

integration("connector registrations and credentials", () => {
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

  async function fixture(providerKey: string) {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "Connector Owner", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const context = { db, auth, env, headers: new Headers({ cookie }) };
    const membership = await call(orgRouter.create, { name: "Connector Org" }, { context });
    const scope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const installation = await db.item.create({
      data: {
        orgId: membership.org.id,
        scopeId: scope.id,
        kind: "connector",
        title: `${providerKey} installation`,
        body: { catalogKey: providerKey, enabledTools: [] },
        status: "active",
        disclosure: "retrieved",
        createdById: membership.principal.id,
      },
    });
    return { ...membership, context, scope, installation };
  }

  async function customerRegistration(orgId: string, catalog = oauthCatalog) {
    return createClientRegistration(db, {
      orgId,
      providerKey: "github",
      source: "customer",
      clientId: "customer-client",
      clientSecret: "customer-secret",
      masterKey,
      catalog,
    });
  }

  it("atomically consumes OAuth state once and rejects expired state", async () => {
    const org = await fixture("github");
    await customerRegistration(org.org.id);
    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "github",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      returnTo: "https://app.trema.example/connectors",
      masterKey,
      catalog: oauthCatalog,
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const tokenFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain("code_verifier=");
      return new Response(
        JSON.stringify({
          access_token: "oauth-access-token",
          refresh_token: "oauth-refresh-token",
          expires_in: 3600,
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const completed = await completeOAuthCallback(db, {
      state: state!,
      code: "authorization-code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: tokenFetch,
    });
    expect(completed.returnTo).toBe("https://app.trema.example/connectors");
    expect(tokenFetch).toHaveBeenCalledTimes(1);

    await expect(
      completeOAuthCallback(db, {
        state: state!,
        code: "replayed-code",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: tokenFetch,
      }),
    ).rejects.toBeInstanceOf(OAuthStateSingleUseError);
    expect(tokenFetch).toHaveBeenCalledTimes(1);

    const oldNow = new Date(Date.now() - 20 * 60 * 1000);
    const expired = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "github",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      now: oldNow,
    });
    const expiredState = new URL(expired.authorizationUrl).searchParams.get("state");
    await expect(
      completeOAuthCallback(db, {
        state: expiredState!,
        code: "expired-code",
        authBaseUrl: env.TREMA_AUTH_BASE_URL,
        masterKey,
        catalog: oauthCatalog,
        fetch: tokenFetch,
      }),
    ).rejects.toBeInstanceOf(OAuthStateExpiredError);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
  });

  it("guards the callback route against an external return URL", async () => {
    const org = await fixture("github");
    await customerRegistration(org.org.id);
    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "github",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      returnTo: "https://attacker.example/collect",
      masterKey,
      catalog: oauthCatalog,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const app = createApp({ db, auth, env });
    const response = await app.request(
      `/connect/callback?state=${encodeURIComponent(state)}&error=access_denied`,
    );

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin).toBe("https://app.trema.example");
    expect(redirect.searchParams.get("connector_error")).toBe("provider_error");
    expect(redirect.toString()).not.toContain("attacker.example");
  });

  it("resolves customer before platform, then platform, then a typed error", async () => {
    const org = await fixture("github");
    await createClientRegistration(db, {
      orgId: org.org.id,
      providerKey: "github",
      source: "platform",
      sharedRef: "hosted-github",
      catalog: oauthCatalog,
    });
    const customer = await customerRegistration(org.org.id);
    const platformApps = {
      get: vi.fn(() => ({ clientId: "platform-client", clientSecret: "platform-secret" })),
    };

    await expect(
      resolveClientRegistration(db, org.org.id, "github", platformApps, masterKey),
    ).resolves.toMatchObject({ source: "customer", clientId: "customer-client" });
    expect(platformApps.get).not.toHaveBeenCalled();

    await db.clientRegistration.delete({ where: { id: customer.id } });
    await expect(
      resolveClientRegistration(db, org.org.id, "github", platformApps, masterKey),
    ).resolves.toMatchObject({ source: "platform", clientId: "platform-client" });

    await db.clientRegistration.deleteMany({ where: { orgId: org.org.id } });
    await expect(
      resolveClientRegistration(db, org.org.id, "github", platformApps, masterKey),
    ).rejects.toBeInstanceOf(NoClientRegistrationError);
  });

  it("decrypts the retained raw token response while no DB or list output exposes plaintext", async () => {
    const org = await fixture("github");
    await customerRegistration(org.org.id);
    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "github",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await completeOAuthCallback(db, {
      state,
      code: "code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: async () =>
        new Response(
          JSON.stringify({
            access_token: "plaintext-access-token",
            refresh_token: "plaintext-refresh-token",
            custom: "retained-metadata",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const stored = await db.connectorCredential.findFirstOrThrow({
      where: { installationItemId: org.installation.id },
    });
    expect(JSON.stringify(stored)).not.toContain("plaintext-access-token");
    // Response omitted `scope`, so the requested (default) scopes are recorded.
    expect(stored.providerScopes).toEqual(["read:user", "repo"]);
    expect(decryptEnvelope(stored.ciphertext, masterKey)).toEqual({
      accessToken: "plaintext-access-token",
      refreshToken: "plaintext-refresh-token",
      raw: {
        access_token: "plaintext-access-token",
        refresh_token: "plaintext-refresh-token",
        custom: "retained-metadata",
      },
    });
    const installation = await db.item.findUniqueOrThrow({ where: { id: org.installation.id } });
    expect(installation.body).toMatchObject({
      config: { custom: "retained-metadata" },
    });

    const registrations = await call(
      connectorsRouter.registrations.list,
      {},
      { context: org.context },
    );
    const credentials = await call(
      connectorsRouter.credentials.list,
      { installationItemId: org.installation.id },
      { context: org.context },
    );
    expect(JSON.stringify(registrations)).not.toMatch(/clientSecret|ciphertext|customer-secret/);
    expect(JSON.stringify(credentials)).not.toMatch(/ciphertext|plaintext-access-token/);

    await call(
      connectorsRouter.credentials.revoke,
      { installationItemId: org.installation.id, credentialId: stored.id },
      { context: org.context },
    );
    const revoked = await call(
      connectorsRouter.credentials.list,
      { installationItemId: org.installation.id },
      { context: org.context },
    );
    expect(revoked[0]).toMatchObject({ isRevoked: true, isValid: false });
  });

  it("requests the installation's scope override and records the granted scopes", async () => {
    const org = await fixture("github");
    await customerRegistration(org.org.id);
    // Override the installed scopes with a subset of GitHub's availableScopes.
    await db.item.update({
      where: { id: org.installation.id },
      data: { body: { catalogKey: "github", enabledTools: [], providerScopes: ["repo"] } },
    });

    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "github",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    // The authorization request asks for the override, not the defaults.
    expect(authorizationUrl.searchParams.get("scope")).toBe("repo");
    const state = authorizationUrl.searchParams.get("state")!;

    // GitHub returns the granted set as a comma-separated string.
    await completeOAuthCallback(db, {
      state,
      code: "code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: async () =>
        new Response(JSON.stringify({ access_token: "token", scope: "repo,read:org" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const stored = await db.connectorCredential.findFirstOrThrow({
      where: { installationItemId: org.installation.id },
    });
    expect(stored.providerScopes).toEqual(["repo", "read:org"]);
  });

  it("records granted scopes from a space-separated token response", async () => {
    const org = await fixture("github");
    await customerRegistration(org.org.id);
    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "github",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await completeOAuthCallback(db, {
      state,
      code: "code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: oauthCatalog,
      fetch: async () =>
        new Response(JSON.stringify({ access_token: "token", scope: "read:user repo gist" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const stored = await db.connectorCredential.findFirstOrThrow({
      where: { installationItemId: org.installation.id },
    });
    expect(stored.providerScopes).toEqual(["read:user", "repo", "gist"]);
  });

  it("stores only verified static credentials and rejects missing verification recipes", async () => {
    const org = await fixture("linear");
    const okFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    const created = await createStaticCredential(db, {
      orgId: org.org.id,
      providerKey: "linear",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      credentials: { apiKey: "verified-linear-key" },
      masterKey,
      catalog: linearCatalog,
      fetch: okFetch,
    });
    expect(created.mode).toBe("api_key");
    expect(okFetch).toHaveBeenCalledTimes(1);
    const requestInit = okFetch.mock.calls[0]?.[1];
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("verified-linear-key");
    expect(new Headers(requestInit?.headers).get("content-type")).toBe("application/json");
    expect(requestInit?.body).toBe(JSON.stringify({ query: "{ viewer { id } }" }));

    const basicInstallation = await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: org.scope.id,
        kind: "connector",
        title: "Basic installation",
        body: { catalogKey: "basic_test", enabledTools: [] },
        status: "active",
        disclosure: "retrieved",
        createdById: org.principal.id,
      },
    });
    const basicFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("basic-user:basic-password").toString("base64")}`,
      );
      return new Response(null, { status: 200 });
    });
    await createStaticCredential(db, {
      orgId: org.org.id,
      providerKey: "basic_test",
      installationItemId: basicInstallation.id,
      principalId: org.principal.id,
      credentials: { username: "basic-user", password: "basic-password" },
      masterKey,
      catalog: basicCatalog,
      fetch: basicFetch,
    });
    expect(basicFetch).toHaveBeenCalledOnce();

    await expect(
      createStaticCredential(db, {
        orgId: org.org.id,
        providerKey: "linear",
        installationItemId: org.installation.id,
        principalId: org.principal.id,
        credentials: { apiKey: "rejected-linear-key" },
        masterKey,
        catalog: linearCatalog,
        fetch: async () => new Response(null, { status: 401 }),
      }),
    ).rejects.toBeInstanceOf(CredentialVerificationError);
    const afterUnauthorized = await db.connectorCredential.findMany({
      where: { installationItemId: org.installation.id },
    });
    expect(afterUnauthorized).toHaveLength(1);
    expect(decryptEnvelope(afterUnauthorized[0]!.ciphertext, masterKey)).not.toEqual(
      expect.objectContaining({ apiKey: "rejected-linear-key" }),
    );

    const noVerificationCatalog = loadProviderCatalog([
      {
        ...apiKeyProvider,
        transport: { ...apiKeyProvider.transport, verification: undefined },
      },
    ]);
    await expect(
      createStaticCredential(db, {
        orgId: org.org.id,
        providerKey: "linear",
        installationItemId: org.installation.id,
        principalId: org.principal.id,
        credentials: { apiKey: "unverified-linear-key" },
        masterKey,
        catalog: noVerificationCatalog,
        fetch: okFetch,
      }),
    ).rejects.toBeInstanceOf(ConnectorCatalogDefectError);
    expect(okFetch).toHaveBeenCalledTimes(1);
  });

  it("replaces the customer registration in place, keeping its id", async () => {
    const org = await fixture("github");
    const first = await customerRegistration(org.org.id);
    await expect(customerRegistration(org.org.id)).rejects.toBeInstanceOf(
      ClientRegistrationConflictError,
    );

    const replaced = await createClientRegistration(db, {
      orgId: org.org.id,
      providerKey: "github",
      source: "customer",
      clientId: "rotated-client",
      clientSecret: "rotated-secret",
      masterKey,
      catalog: oauthCatalog,
      replace: true,
    });
    expect(replaced.id).toBe(first.id);
    expect(replaced.clientId).toBe("rotated-client");

    const row = await db.clientRegistration.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.clientSecretCiphertext).not.toBeNull();
    expect(decryptEnvelope(row.clientSecretCiphertext as string, masterKey)).toBe("rotated-secret");
  });

  it("mints an mcp_oauth credential via discovery + one-time dynamic registration", async () => {
    const org = await fixture("notion");
    const { fetch: mcpFetch, state } = mcpFlowFetch();

    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "notion",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      returnTo: "https://app.trema.example/connectors",
      masterKey,
      catalog: mcpCatalog,
      fetch: mcpFetch,
    });

    // Dynamic client registration ran once and persisted a public "dynamic" row.
    expect(state.registerCalls).toBe(1);
    const registrations = await db.clientRegistration.findMany({
      where: { orgId: org.org.id, providerKey: "notion" },
    });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      source: "dynamic",
      clientId: "notion-dcr-client",
      clientSecretCiphertext: null,
    });

    const authorizationUrl = new URL(started.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      `${MCP_AS_ORIGIN}/authorize`,
    );
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.notion.test/mcp");
    expect(authorizationUrl.searchParams.get("scope")).toBe("read write");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("notion-dcr-client");
    const oauthState = authorizationUrl.searchParams.get("state")!;

    // The discovered token endpoint and resource survive the redirect.
    const pending = await db.connectorOAuthState.findUniqueOrThrow({
      where: { stateHash: hashOAuthState(oauthState) },
    });
    expect(pending.tokenEndpoint).toBe(`${MCP_AS_ORIGIN}/token`);
    expect(pending.resource).toBe("https://mcp.notion.test/mcp");
    expect(pending.providerScopes).toEqual(["read", "write"]);

    const completed = await completeOAuthCallback(db, {
      state: oauthState,
      code: "notion-auth-code",
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: mcpCatalog,
      fetch: mcpFetch,
    });
    expect(completed.returnTo).toBe("https://app.trema.example/connectors");

    const stored = await db.connectorCredential.findFirstOrThrow({
      where: { installationItemId: org.installation.id },
    });
    expect(stored.mode).toBe("mcp_oauth");
    // The token response narrowed the granted scope to "read".
    expect(stored.providerScopes).toEqual(["read"]);
    expect(JSON.stringify(stored)).not.toContain("notion-access-token");
    expect(decryptEnvelope(stored.ciphertext, masterKey)).toMatchObject({
      accessToken: "notion-access-token",
      refreshToken: "notion-refresh-token",
    });
    expect(stored.expiresAt).not.toBeNull();

    // A second connect reuses the stored dynamic registration; no re-registration.
    const second = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "notion",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      masterKey,
      catalog: mcpCatalog,
      fetch: mcpFetch,
    });
    expect(new URL(second.authorizationUrl).searchParams.get("client_id")).toBe(
      "notion-dcr-client",
    );
    expect(state.registerCalls).toBe(1);
    const afterSecond = await db.clientRegistration.findMany({
      where: { orgId: org.org.id, providerKey: "notion" },
    });
    expect(afterSecond).toHaveLength(1);
  });

  it("syncs MCP tools on connect via the callback route, tolerating sync failure", async () => {
    const org = await fixture("notion");
    const { fetch: mcpFetch } = mcpFlowFetch();
    const app = createApp({
      db,
      auth,
      env,
      connectorFetch: mcpFetch,
      mcpClientFactory: async () => ({
        listTools: async () => ({
          tools: [
            {
              name: "search_pages",
              description: "Search pages.",
              annotations: { readOnlyHint: true },
            },
          ],
        }),
        close: async () => {},
      }),
    });

    const started = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "notion",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      returnTo: "https://app.trema.example/connectors",
      masterKey,
      fetch: mcpFetch,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";

    const response = await app.request(
      `/connect/callback?state=${encodeURIComponent(state)}&code=notion-code`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.trema.example/connectors");

    const item = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: org.installation.id } },
    });
    const body = item.body as { syncedTools?: unknown };
    expect(body.syncedTools).toEqual([
      { name: "search_pages", description: "Search pages.", sensitivity: "read" },
    ]);

    // A failing MCP server still redirects; the credential survives for a manual sync.
    const failing = createApp({
      db,
      auth,
      env,
      connectorFetch: mcpFetch,
      mcpClientFactory: async () => {
        throw new Error("mcp server unreachable");
      },
    });
    const second = await startOAuthConnect(db, {
      orgId: org.org.id,
      providerKey: "notion",
      installationItemId: org.installation.id,
      principalId: org.principal.id,
      authBaseUrl: env.TREMA_AUTH_BASE_URL,
      returnTo: "https://app.trema.example/connectors",
      masterKey,
      fetch: mcpFetch,
    });
    const secondState = new URL(second.authorizationUrl).searchParams.get("state") ?? "";
    const secondResponse = await failing.request(
      `/connect/callback?state=${encodeURIComponent(secondState)}&code=notion-code`,
    );
    expect(secondResponse.status).toBe(302);
    expect(secondResponse.headers.get("location")).toBe("https://app.trema.example/connectors");
  });
});
