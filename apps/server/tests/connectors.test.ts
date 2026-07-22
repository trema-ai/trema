import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { decryptEnvelope } from "#/lib/crypto/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { connectorsRouter } from "#/rpc/connectors.js";
import { orgRouter } from "#/rpc/org.js";
import {
  ConnectorCatalogDefectError,
  CredentialVerificationError,
  completeOAuthCallback,
  createClientRegistration,
  createStaticCredential,
  loadProviderCatalog,
  NoClientRegistrationError,
  OAuthStateExpiredError,
  OAuthStateSingleUseError,
  resolveClientRegistration,
  startOAuthConnect,
} from "#/services/connectors/index.js";
import { githubProvider } from "#/services/connectors/providers/github.js";
import { linearProvider } from "#/services/connectors/providers/linear.js";

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
      tokenResponseMetadata: ["custom"],
    },
  },
]);
const linearCatalog = loadProviderCatalog([linearProvider]);
const basicCatalog = loadProviderCatalog([
  {
    ...linearProvider,
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
        ...linearProvider,
        transport: { ...linearProvider.transport, verification: undefined },
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
});
