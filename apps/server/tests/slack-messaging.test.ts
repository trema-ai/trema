import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptEnvelope, encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { createClientRegistration } from "#server/services/connectors/index.js";
import {
  createSlackBinding,
  listSlackBindings,
  listSlackIdentityLinks,
  resolveSlackRequest,
  SlackRequestRejectedError,
  SlackUninstallError,
  setSlackIdentityLink,
  uninstallSlackInstallation,
} from "#server/services/messaging/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 31).toString("base64");

integration("Slack installation and conversation bindings", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function setup(workspaceId = "T123ABC") {
    const org = await db.org.create({ data: { name: `Org ${randomUUID()}` } });
    await createClientRegistration(db, {
      orgId: org.id,
      providerKey: "slack",
      source: "customer",
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      signingSecret: "slack-signing-secret",
      masterKey,
    });
    const agent = await db.principal.create({
      data: { orgId: org.id, kind: "agent", displayName: "Trema" },
    });
    const member = await db.principal.create({
      data: { orgId: org.id, kind: "human", displayName: "Ada" },
    });
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    const sharedScope = await db.scope.create({
      data: { orgId: org.id, kind: "shared", name: "Support" },
    });
    const connection = await db.connectorConnection.create({
      data: {
        orgId: org.id,
        providerKey: "slack",
        ownerPrincipalId: agent.id,
        authMode: "oauth2_code",
        config: {
          "team.id": workspaceId,
          "team.name": "Trema Test",
          "enterprise.id": "E123ABC",
          bot_user_id: "U999BOT",
        },
        ciphertext: encryptEnvelope(
          {
            accessToken: "xoxb-safe-test-token",
            raw: {
              access_token: "xoxb-safe-test-token",
              authed_user: {
                id: "UINSTALLER",
                access_token: "xoxp-safe-user-token",
                token_type: "user",
              },
            },
          },
          masterKey,
        ),
        providerScopes: ["app_mentions:read", "chat:write"],
      },
    });
    const installation = await db.item.create({
      data: {
        orgId: org.id,
        scopeId: orgScope.id,
        kind: "connector",
        title: "Slack",
        body: {
          catalogKey: "slack",
          connectionId: connection.id,
          access: { kind: "scope" },
          enabledTools: "all",
        },
        status: "active",
        disclosure: "standing",
        createdById: member.id,
      },
    });
    return { org, agent, member, orgScope, sharedScope, connection, installation, workspaceId };
  }

  it("resolves workspace, installation, scope, requester, binding, conversation, and run safely", async () => {
    const fixture = await setup();
    const binding = await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C123ABC",
      scopeId: fixture.sharedScope.id,
    });
    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: fixture.member.id,
    });
    const conversation = await db.conversation.create({
      data: {
        orgId: fixture.org.id,
        scopeId: fixture.sharedScope.id,
        surface: "slack",
        locationRef: `${fixture.workspaceId}:C123ABC`,
        threadRef: "1720000000.000001",
      },
    });
    const session = await db.contextSession.create({
      data: {
        orgId: fixture.org.id,
        scopeId: fixture.sharedScope.id,
        surface: "slack",
        locationRef: `${fixture.workspaceId}:C123ABC`,
        threadRef: "1720000000.000001",
        scopeChain: [fixture.orgScope.id, fixture.sharedScope.id],
        agentPrincipalId: fixture.agent.id,
        requesterPrincipalId: fixture.member.id,
        standing: {},
        policySnapshot: {},
        snapshotHash: "snapshot",
        tokenHash: `token-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const run = await db.agentRun.create({
      data: {
        id: `run-${randomUUID()}`,
        orgId: fixture.org.id,
        threadRef: "thread-internal",
        state: "completed",
        trigger: "message",
        sessionId: session.id,
      },
    });

    await expect(
      resolveSlackRequest(db, {
        workspaceId: fixture.workspaceId,
        enterpriseId: "E123ABC",
        channelId: "C123ABC",
        threadTs: "1720000000.000001",
        userId: "U123ABC",
        masterKey,
      }),
    ).resolves.toMatchObject({
      orgId: fixture.org.id,
      connectionId: fixture.connection.id,
      installationItemId: fixture.installation.id,
      credentialOwnerPrincipalId: fixture.agent.id,
      scopeId: fixture.sharedScope.id,
      requesterPrincipalId: fixture.member.id,
      bindingId: binding.id,
      conversationId: conversation.id,
      runId: run.id,
      locationRef: `${fixture.workspaceId}:C123ABC`,
      externalUserId: `${fixture.workspaceId}:U123ABC`,
    });
  });

  it("rejects unbound, unlinked, mismatched-enterprise, and revoked requests without fallback", async () => {
    const fixture = await setup();
    await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C123ABC",
      scopeId: fixture.sharedScope.id,
    });

    await expect(
      resolveSlackRequest(db, {
        workspaceId: fixture.workspaceId,
        channelId: "C123ABC",
        userId: "U123ABC",
        masterKey,
      }),
    ).rejects.toMatchObject({ reason: "identity_unlinked" });

    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: fixture.member.id,
    });
    await expect(
      resolveSlackRequest(db, {
        workspaceId: fixture.workspaceId,
        channelId: "COTHER",
        userId: "U123ABC",
        masterKey,
      }),
    ).rejects.toMatchObject({ reason: "location_unbound" });
    await expect(
      resolveSlackRequest(db, {
        workspaceId: fixture.workspaceId,
        enterpriseId: "EOTHER",
        channelId: "C123ABC",
        userId: "U123ABC",
        masterKey,
      }),
    ).rejects.toMatchObject({ reason: "enterprise_mismatch" });

    await db.connectorConnection.update({
      where: { id: fixture.connection.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      resolveSlackRequest(db, {
        workspaceId: fixture.workspaceId,
        channelId: "C123ABC",
        userId: "U123ABC",
        masterKey,
      }),
    ).rejects.toBeInstanceOf(SlackRequestRejectedError);
  });

  it("enforces one active Trema organization per Slack workspace", async () => {
    const first = await setup("TUNIQUE");
    const secondOrg = await db.org.create({ data: { name: "Other org" } });
    const secondAgent = await db.principal.create({
      data: { orgId: secondOrg.id, kind: "agent", displayName: "Trema" },
    });

    await expect(
      db.connectorConnection.create({
        data: {
          orgId: secondOrg.id,
          providerKey: "slack",
          ownerPrincipalId: secondAgent.id,
          authMode: "oauth2_code",
          config: { "team.id": first.workspaceId },
          ciphertext: encryptEnvelope({ accessToken: "another-token" }, masterKey),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps implicit personal DM bindings out of the administrator binding list", async () => {
    const fixture = await setup();
    const personalScope = await db.scope.create({
      data: {
        orgId: fixture.org.id,
        kind: "personal",
        name: "Ada",
        ownerId: fixture.member.id,
      },
    });
    await db.binding.create({
      data: {
        orgId: fixture.org.id,
        surface: "slack",
        locationRef: `${fixture.workspaceId}:D123ABC`,
        scopeId: personalScope.id,
      },
    });
    const managed = await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C123ABC",
      scopeId: fixture.sharedScope.id,
    });

    await expect(listSlackBindings(db, fixture.org.id)).resolves.toMatchObject([
      { id: managed.id, scope: { kind: "shared" } },
    ]);
  });

  it("retries a refreshable Slack credential before rejecting an expired installation", async () => {
    const fixture = await setup();
    const now = new Date("2026-08-01T16:00:00.000Z");
    await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C123ABC",
      scopeId: fixture.sharedScope.id,
    });
    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: fixture.member.id,
    });
    await db.connectorConnection.update({
      where: { id: fixture.connection.id },
      data: {
        ciphertext: encryptEnvelope(
          {
            accessToken: "expired-bot-access",
            refreshToken: "retryable-bot-refresh",
            raw: { access_token: "expired-bot-access" },
          },
          masterKey,
        ),
        expiresAt: new Date(now.getTime() - 1_000),
        lastRefreshFailure: new Date(now.getTime() - 60_000),
        refreshFailureStartedAt: new Date(now.getTime() - 120_000),
        refreshAttempts: 1,
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        ok: true,
        access_token: "refreshed-bot-access",
        refresh_token: "refreshed-bot-refresh",
        expires_in: 43_200,
        token_type: "bot",
      }),
    );

    await expect(
      resolveSlackRequest(db, {
        workspaceId: fixture.workspaceId,
        channelId: "C123ABC",
        userId: "U123ABC",
        masterKey,
        fetch,
        now,
      }),
    ).resolves.toMatchObject({
      connectionId: fixture.connection.id,
      scopeId: fixture.sharedScope.id,
    });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      refreshAttempts: 0,
      lastRefreshFailure: null,
      refreshFailureStartedAt: null,
      refreshExhausted: false,
    });
  });

  it("audits bindings, requester links, and a remote app uninstall without token material", async () => {
    const fixture = await setup();
    await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C123ABC",
      scopeId: fixture.sharedScope.id,
    });
    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: fixture.member.id,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true }, { status: 200 }),
    );
    await uninstallSlackInstallation(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      ownerPrincipalId: fixture.agent.id,
      connectionId: fixture.connection.id,
      masterKey,
      fetch,
    });

    await expect(listSlackBindings(db, fixture.org.id)).resolves.toHaveLength(1);
    await expect(listSlackIdentityLinks(db, fixture.org.id)).resolves.toHaveLength(1);
    const audits = await db.auditLog.findMany({
      where: { orgId: fixture.org.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map(({ action }) => action)).toEqual([
      "binding.create",
      "messaging.slack.identity.set",
      "messaging.slack.installation.uninstall",
    ]);
    expect(JSON.stringify(audits)).not.toContain("xoxb-safe-test-token");
    expect(JSON.stringify(audits)).not.toContain("xoxp-safe-user-token");
    expect(fetch).toHaveBeenCalledOnce();
    const [request, init] = fetch.mock.calls[0]!;
    expect(String(request)).toBe("https://slack.com/api/apps.uninstall");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer xoxp-safe-user-token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_id")).toBe("slack-client-id");
    expect(body.get("client_secret")).toBe("slack-client-secret");
    expect(body.has("token")).toBe(false);
  });

  it("requires reauthorization when a legacy installation has no user token", async () => {
    const fixture = await setup();
    await db.connectorConnection.update({
      where: { id: fixture.connection.id },
      data: {
        ciphertext: encryptEnvelope(
          { accessToken: "xoxb-legacy-token", raw: { access_token: "xoxb-legacy-token" } },
          masterKey,
        ),
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      uninstallSlackInstallation(db, {
        orgId: fixture.org.id,
        actorPrincipalId: fixture.member.id,
        ownerPrincipalId: fixture.agent.id,
        connectionId: fixture.connection.id,
        masterKey,
        fetch,
      }),
    ).rejects.toEqual(
      new SlackUninstallError("Slack must be reauthorized before it can be uninstalled"),
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
  });

  it("rotates and persists an expiring Slack user token before uninstalling", async () => {
    const fixture = await setup();
    await db.connectorConnection.update({
      where: { id: fixture.connection.id },
      data: {
        ciphertext: encryptEnvelope(
          {
            accessToken: "xoxb-safe-test-token",
            raw: {
              access_token: "xoxb-safe-test-token",
              authed_user: {
                id: "UINSTALLER",
                access_token: "xoxe.old-user-access",
                refresh_token: "xoxe.old-user-refresh",
              },
            },
          },
          masterKey,
        ),
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      if (String(request) === "https://slack.com/api/oauth.v2.access") {
        return Response.json({
          ok: true,
          access_token: "xoxe.new-user-access",
          refresh_token: "xoxe.new-user-refresh",
          expires_in: 43_200,
          token_type: "user",
        });
      }
      return Response.json({ ok: true });
    });

    await uninstallSlackInstallation(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      ownerPrincipalId: fixture.agent.id,
      connectionId: fixture.connection.id,
      masterKey,
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://slack.com/api/oauth.v2.access");
    expect(String(fetch.mock.calls[1]![0])).toBe("https://slack.com/api/apps.uninstall");
    const uninstallHeaders = new Headers(fetch.mock.calls[1]![1]?.headers);
    expect(uninstallHeaders.get("Authorization")).toBe("Bearer xoxe.new-user-access");
    const stored = await db.connectorConnection.findUniqueOrThrow({
      where: { id: fixture.connection.id },
    });
    expect(decryptEnvelope(stored.ciphertext, masterKey)).toMatchObject({
      raw: {
        authed_user: {
          access_token: "xoxe.new-user-access",
          refresh_token: "xoxe.new-user-refresh",
        },
      },
    });
  });
});
