import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import {
  createSlackBinding,
  listSlackBindings,
  listSlackIdentityLinks,
  resolveSlackRequest,
  SlackRequestRejectedError,
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
          { accessToken: "xoxb-safe-test-token", raw: { access_token: "xoxb-safe-test-token" } },
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

  it("audits bindings, requester links, and a remotely revoked uninstall without token material", async () => {
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
    const fetch = vi.fn(async () => Response.json({ ok: true, revoked: true }, { status: 200 }));
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
    expect(fetch).toHaveBeenCalledOnce();
  });
});
