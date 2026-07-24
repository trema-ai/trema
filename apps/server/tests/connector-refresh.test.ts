import { randomUUID } from "node:crypto";

import { googleWorkspaceProvider, loadProviderCatalog, notionMcpProvider } from "@trema/connectors";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptEnvelope, encryptEnvelope } from "#/lib/crypto/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import {
  ConnectorConnectionNotFoundError,
  ConnectorReconnectRequiredError,
  createClientRegistration,
  type McpClientFactory,
  REFRESH_FAILURE_BUDGET_MS,
  resolveConnectionCredential,
  syncConnectorInstallation,
} from "#/services/connectors/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 61).toString("base64");
const googleCatalog = loadProviderCatalog([googleWorkspaceProvider]);

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

integration("connector credential refresh", () => {
  const db = createPrismaClient(databaseUrl);
  const lockDb = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), lockDb.$disconnect()]);
  });

  async function connectorOwner(providerKey = "google_workspace") {
    const org = await db.org.create({
      data: { name: `Refresh test ${randomUUID()}` },
    });
    const principal = await db.principal.create({
      data: {
        orgId: org.id,
        kind: "agent",
        displayName: "Refresh agent",
      },
    });
    if (providerKey === "google_workspace") {
      await createClientRegistration(db, {
        orgId: org.id,
        providerKey,
        source: "customer",
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        masterKey,
      });
    }
    return { org, principal };
  }

  async function oauthConnection(input: {
    orgId: string;
    principalId: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
    refreshAttempts?: number;
    lastRefreshFailure?: Date;
    refreshFailureStartedAt?: Date;
  }) {
    return db.connectorConnection.create({
      data: {
        orgId: input.orgId,
        principalId: input.principalId,
        providerKey: "google_workspace",
        mode: "oauth2_code",
        config: {},
        ciphertext: encryptEnvelope(
          {
            accessToken: input.accessToken ?? "old-access-token",
            ...(input.refreshToken === undefined
              ? { refreshToken: "old-refresh-token" }
              : input.refreshToken
                ? { refreshToken: input.refreshToken }
                : {}),
            raw: { token_type: "Bearer" },
          },
          masterKey,
        ),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
        ...(input.refreshAttempts === undefined ? {} : { refreshAttempts: input.refreshAttempts }),
        ...(input.lastRefreshFailure ? { lastRefreshFailure: input.lastRefreshFailure } : {}),
        ...(input.refreshFailureStartedAt
          ? { refreshFailureStartedAt: input.refreshFailureStartedAt }
          : {}),
      },
    });
  }

  function successfulFetch(
    responses: readonly Record<string, unknown>[] = [
      {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      },
    ],
  ): FetchMock {
    let index = 0;
    return vi.fn(async () => {
      const payload = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  it("refreshes inside the default margin and honors tokenExpirationBuffer overrides", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const owner = await connectorOwner();
    const connection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      expiresAt: new Date(now.getTime() + 16 * 60 * 1000),
    });
    const fetch = successfulFetch();

    await expect(
      resolveConnectionCredential(db, {
        orgId: owner.org.id,
        connectionId: connection.id,
        masterKey,
        catalog: googleCatalog,
        fetch,
        now,
      }),
    ).resolves.toMatchObject({
      credential: { accessToken: "old-access-token" },
    });
    expect(fetch).not.toHaveBeenCalled();

    await db.connectorConnection.update({
      where: { id: connection.id },
      data: { expiresAt: new Date(now.getTime() + 14 * 60 * 1000) },
    });
    await expect(
      resolveConnectionCredential(db, {
        orgId: owner.org.id,
        connectionId: connection.id,
        masterKey,
        catalog: googleCatalog,
        fetch,
        now,
      }),
    ).resolves.toMatchObject({
      credential: { accessToken: "new-access-token" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [refreshRequest, refreshInit] = fetch.mock.calls[0]!;
    expect(String(refreshRequest)).toBe("https://oauth2.googleapis.com/token");
    expect(new Headers(refreshInit?.headers).has("Authorization")).toBe(false);
    const refreshBody = new URLSearchParams(String(refreshInit?.body));
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("client_id")).toBe("google-client-id");
    expect(refreshBody.get("client_secret")).toBe("google-client-secret");

    const narrowBufferCatalog = loadProviderCatalog([
      {
        ...googleWorkspaceProvider,
        auth: {
          ...googleWorkspaceProvider.auth,
          tokenExpirationBuffer: 60,
        },
      },
    ]);
    const narrowBufferConnection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      expiresAt: new Date(now.getTime() + 2 * 60 * 1000),
    });
    const narrowFetch = successfulFetch();
    await expect(
      resolveConnectionCredential(db, {
        orgId: owner.org.id,
        connectionId: narrowBufferConnection.id,
        masterKey,
        catalog: narrowBufferCatalog,
        fetch: narrowFetch,
        now,
      }),
    ).resolves.toMatchObject({
      credential: { accessToken: "old-access-token" },
    });
    expect(narrowFetch).not.toHaveBeenCalled();
  });

  it("uses a conservative lifetime when a refreshable token has no expiresAt", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const issuedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const owner = await connectorOwner();
    const connection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      expiresAt: null,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
    const fetch = successfulFetch();

    await expect(
      resolveConnectionCredential(db, {
        orgId: owner.org.id,
        connectionId: connection.id,
        masterKey,
        catalog: googleCatalog,
        fetch,
        now,
      }),
    ).resolves.toMatchObject({
      credential: { accessToken: "new-access-token" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("collapses concurrent in-process resolution to exactly one token exchange", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const owner = await connectorOwner();
    const connection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    let releaseExchange!: () => void;
    const exchangeReleased = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const fetch: FetchMock = vi.fn(async () => {
      await exchangeReleased;
      return new Response(
        JSON.stringify({
          access_token: "collapsed-access-token",
          refresh_token: "collapsed-refresh-token",
          expires_in: 3600,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    const resolutions = Array.from({ length: 8 }, () =>
      resolveConnectionCredential(db, {
        orgId: owner.org.id,
        connectionId: connection.id,
        masterKey,
        catalog: googleCatalog,
        fetch,
        now,
      }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(
      resolveConnectionCredential(db, {
        orgId: randomUUID(),
        connectionId: connection.id,
        masterKey,
        catalog: googleCatalog,
        fetch,
        now,
      }),
    ).rejects.toBeInstanceOf(ConnectorConnectionNotFoundError);
    releaseExchange();

    const results = await Promise.all(resolutions);
    expect(
      results.every((result) => result.credential.accessToken === "collapsed-access-token"),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("double-checks after the distributed lock and skips a redundant exchange", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const owner = await connectorOwner();
    const connection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const holder = lockDb.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${connection.id}, 0))
      `;
      lockAcquired();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await transaction.connectorConnection.update({
        where: { id: connection.id },
        data: {
          ciphertext: encryptEnvelope(
            {
              accessToken: "other-worker-access-token",
              refreshToken: "other-worker-refresh-token",
              raw: { access_token: "other-worker-access-token" },
            },
            masterKey,
          ),
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          lastRefreshSuccess: now,
        },
      });
    });
    await acquired;
    const fetch = successfulFetch();
    const resolving = resolveConnectionCredential(db, {
      orgId: owner.org.id,
      connectionId: connection.id,
      masterKey,
      catalog: googleCatalog,
      fetch,
      now,
    });

    await holder;
    await expect(resolving).resolves.toMatchObject({
      credential: { accessToken: "other-worker-access-token" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains an omitted refresh token and stores a rotated refresh token", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const owner = await connectorOwner();
    const retained = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      accessToken: "retained-old-access",
      refreshToken: "retained-refresh-token",
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const rotated = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      accessToken: "rotated-old-access",
      refreshToken: "rotated-old-refresh",
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const fetch = successfulFetch([
      { access_token: "retained-new-access", expires_in: 3600, provider_extension: "kept" },
      {
        access_token: "rotated-new-access",
        refresh_token: "rotated-new-refresh",
        expires_in: 3600,
      },
    ]);

    await resolveConnectionCredential(db, {
      orgId: owner.org.id,
      connectionId: retained.id,
      masterKey,
      catalog: googleCatalog,
      fetch,
      now,
    });
    await resolveConnectionCredential(db, {
      orgId: owner.org.id,
      connectionId: rotated.id,
      masterKey,
      catalog: googleCatalog,
      fetch,
      now,
    });

    const retainedStored = await db.connectorConnection.findUniqueOrThrow({
      where: { id: retained.id },
    });
    const rotatedStored = await db.connectorConnection.findUniqueOrThrow({
      where: { id: rotated.id },
    });
    expect(decryptEnvelope(retainedStored.ciphertext, masterKey)).toEqual({
      accessToken: "retained-new-access",
      refreshToken: "retained-refresh-token",
      raw: {
        access_token: "retained-new-access",
        expires_in: 3600,
        provider_extension: "kept",
      },
    });
    expect(decryptEnvelope(rotatedStored.ciphertext, masterKey)).toMatchObject({
      accessToken: "rotated-new-access",
      refreshToken: "rotated-new-refresh",
    });
  });

  it("accrues failures, enforces cooldown, exhausts the budget, and redacts errors", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const accessToken = "access-token-that-must-not-leak";
    const refreshToken = "refresh-token-that-must-not-leak";
    const owner = await connectorOwner();
    const connection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      accessToken,
      refreshToken,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const rawProviderDetail = `provider echoed ${accessToken} and ${refreshToken}`;
    const fetch: FetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: rawProviderDetail,
            access_token: accessToken,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    await expect(
      resolveConnectionCredential(db, {
        orgId: owner.org.id,
        connectionId: connection.id,
        masterKey,
        catalog: googleCatalog,
        fetch,
        now,
      }),
    ).resolves.toMatchObject({ credential: { accessToken } });
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      refreshAttempts: 1,
      refreshExhausted: false,
      lastRefreshFailure: now,
      refreshFailureStartedAt: now,
    });

    await resolveConnectionCredential(db, {
      orgId: owner.org.id,
      connectionId: connection.id,
      masterKey,
      catalog: googleCatalog,
      fetch,
      now: new Date(now.getTime() + 10_000),
    });
    expect(fetch).toHaveBeenCalledOnce();

    const exhaustedAt = new Date(now.getTime() + 31_000);
    await db.connectorConnection.update({
      where: { id: connection.id },
      data: {
        lastRefreshFailure: new Date(exhaustedAt.getTime() - 31_000),
        refreshFailureStartedAt: new Date(exhaustedAt.getTime() - REFRESH_FAILURE_BUDGET_MS - 1),
      },
    });
    const failure = await resolveConnectionCredential(db, {
      orgId: owner.org.id,
      connectionId: connection.id,
      masterKey,
      catalog: googleCatalog,
      fetch,
      now: exhaustedAt,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectorReconnectRequiredError);
    expect(failure).toMatchObject({
      code: "reconnect_needed",
      reconnectNeeded: true,
      reason: "refresh_exhausted",
      providerStatus: 400,
      providerCode: "invalid_grant",
    });
    expect(String((failure as Error).message)).not.toContain(accessToken);
    expect(String((failure as Error).message)).not.toContain(refreshToken);
    expect(String((failure as Error).message)).not.toContain(rawProviderDetail);
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      refreshAttempts: 2,
      refreshExhausted: true,
      lastRefreshFailure: exhaustedAt,
    });
  });

  it("clears the entire failure streak after a successful refresh", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const owner = await connectorOwner();
    const connection = await oauthConnection({
      orgId: owner.org.id,
      principalId: owner.principal.id,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      refreshAttempts: 3,
      lastRefreshFailure: new Date(now.getTime() - 60_000),
      refreshFailureStartedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    });

    await resolveConnectionCredential(db, {
      orgId: owner.org.id,
      connectionId: connection.id,
      masterKey,
      catalog: googleCatalog,
      fetch: successfulFetch(),
      now,
    });

    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      refreshAttempts: 0,
      refreshExhausted: false,
      lastRefreshFailure: null,
      refreshFailureStartedAt: null,
      lastRefreshSuccess: now,
    });
  });

  it("refreshes stale MCP OAuth credentials with the persisted DCR client before sync", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const owner = await connectorOwner("notion");
    const scope = await db.scope.create({
      data: {
        orgId: owner.org.id,
        kind: "org",
        name: "Organization",
      },
    });
    await db.clientRegistration.create({
      data: {
        orgId: owner.org.id,
        providerKey: "notion",
        source: "dynamic",
        clientId: "persisted-dcr-client",
        clientSecretCiphertext: encryptEnvelope("persisted-dcr-secret", masterKey),
        tokenEndpointAuthMethod: "client_secret_post",
      },
    });
    const connection = await db.connectorConnection.create({
      data: {
        orgId: owner.org.id,
        principalId: owner.principal.id,
        providerKey: "notion",
        mode: "mcp_oauth",
        config: {},
        ciphertext: encryptEnvelope(
          {
            accessToken: "stale-mcp-access",
            refreshToken: "mcp-refresh-token",
            raw: {},
          },
          masterKey,
        ),
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      },
    });
    const installation = await db.item.create({
      data: {
        orgId: owner.org.id,
        scopeId: scope.id,
        kind: "connector",
        title: "Notion",
        body: {
          catalogKey: "notion",
          connectionId: connection.id,
          enabledTools: "all",
        },
        status: "active",
        disclosure: "retrieved",
        createdById: owner.principal.id,
        updatedById: owner.principal.id,
      },
    });
    const tokenEndpoint = "https://mcp.notion.com/token";
    const fetch: FetchMock = vi.fn(async (request, init) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.notion.com/mcp",
            authorization_servers: ["https://mcp.notion.com"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "https://mcp.notion.com",
            authorization_endpoint: "https://mcp.notion.com/authorize",
            token_endpoint: tokenEndpoint,
            response_types_supported: ["code"],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === tokenEndpoint) {
        const body = new URLSearchParams(String(init?.body));
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("mcp-refresh-token");
        expect(body.get("client_id")).toBe("persisted-dcr-client");
        expect(body.get("client_secret")).toBe("persisted-dcr-secret");
        expect(body.get("resource")).toBe("https://mcp.notion.com/mcp");
        return new Response(
          JSON.stringify({
            access_token: "refreshed-mcp-access",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 401 });
    });
    const clientFactory = vi.fn(async ({ authorization }) => {
      expect(authorization).toBe("Bearer refreshed-mcp-access");
      return {
        listTools: async () => ({
          tools: [{ name: "search", annotations: { readOnlyHint: true } }],
        }),
        close: async () => {},
      };
    }) satisfies McpClientFactory;

    await syncConnectorInstallation(db, {
      orgId: owner.org.id,
      actorPrincipalId: owner.principal.id,
      installationItemId: installation.id,
      masterKey,
      catalog: loadProviderCatalog([notionMcpProvider]),
      fetch,
      clientFactory,
      now,
    });

    expect(clientFactory).toHaveBeenCalledOnce();
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      refreshAttempts: 0,
      lastRefreshSuccess: now,
    });
  });
});
