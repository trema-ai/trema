import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { messagingRouter } from "#server/rpc/messaging.js";
import { createClientRegistration } from "#server/services/connectors/index.js";
import {
  hashIdentityLinkChallengeToken,
  IdentityLinkChallengeNotFoundError,
  mintSlackIdentityLinkChallenge,
  previewSlackIdentityLinkChallenge,
  redeemSlackIdentityLinkChallenge,
  setSlackIdentityLink,
} from "#server/services/messaging/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!testDatabaseUrl);
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 31).toString("base64");

integration("Slack identity link challenges", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "identity-link-challenge-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
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
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    return {
      user,
      context: { db, auth, env, headers: new Headers({ cookie }) },
    };
  }

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
    const signedUp = await signUp("Ada Lovelace");
    const member = await db.principal.create({
      data: {
        orgId: org.id,
        kind: "human",
        authId: signedUp.user.id,
        displayName: signedUp.user.name,
        email: signedUp.user.email,
      },
    });
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    await db.grant.create({
      data: { orgId: org.id, principalId: member.id, scopeId: orgScope.id, role: "member" },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: org.id },
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
          bot_user_id: "U999BOT",
        },
        ciphertext: encryptEnvelope(
          {
            accessToken: "xoxb-safe-test-token",
            raw: { access_token: "xoxb-safe-test-token" },
          },
          masterKey,
        ),
        providerScopes: ["app_mentions:read", "chat:write"],
      },
    });
    return {
      org,
      agent,
      member,
      orgScope,
      connection,
      workspaceId,
      ...signedUp,
    };
  }

  async function addMember(orgId: string, scopeId: string, name: string) {
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
    await db.grant.create({
      data: { orgId, principalId: principal.id, scopeId, role: "member" },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...signedUp, principal };
  }

  it("lets an active member link the challenged Slack identity to themselves", async () => {
    const fixture = await setup("TLINKOK");
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });

    expect(minted.link).toBe(
      `https://trema.example/link/slack?token=${encodeURIComponent(minted.token)}`,
    );
    const persisted = await db.identityLinkChallenge.findUniqueOrThrow({
      where: { id: minted.challenge.id },
    });
    expect(persisted.tokenHash).toBe(hashIdentityLinkChallengeToken(minted.token));
    expect(persisted.tokenHash).not.toBe(minted.token);
    expect(JSON.stringify(persisted)).not.toContain(minted.token);

    const preview = await call(
      messagingRouter.slack.identityChallenges.preview,
      { token: minted.token },
      { context: { db, auth, env, headers: new Headers() } },
    );
    expect(preview).toMatchObject({
      orgId: fixture.org.id,
      orgName: fixture.org.name,
      surface: "slack",
      workspaceId: "TLINKOK",
      userId: "U123ABC",
    });

    const redeemed = await call(
      messagingRouter.slack.identityChallenges.redeem,
      { token: minted.token },
      { context: fixture.context },
    );
    expect(redeemed).toEqual({
      orgId: fixture.org.id,
      identityLinkId: expect.any(String),
      principalId: fixture.member.id,
      workspaceId: "TLINKOK",
      userId: "U123ABC",
    });

    await expect(
      db.identityLink.findUniqueOrThrow({
        where: {
          orgId_surface_externalUserId: {
            orgId: fixture.org.id,
            surface: "slack",
            externalUserId: "TLINKOK:U123ABC",
          },
        },
      }),
    ).resolves.toMatchObject({ principalId: fixture.member.id });

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: fixture.org.id, action: "messaging.slack.identity.self_link" },
    });
    expect(audit.actorPrincipalId).toBe(fixture.member.id);
    expect(JSON.stringify(audit.payload)).not.toContain(minted.token);
  });

  it("rejects expired challenges", async () => {
    const fixture = await setup("TEXPIRED");
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.identityLinkChallenge.update({
      where: { id: minted.challenge.id },
      data: { expiresAt: new Date("2026-01-01T00:10:00.000Z") },
    });

    await expect(previewSlackIdentityLinkChallenge(db, minted.token)).rejects.toBeInstanceOf(
      IdentityLinkChallengeNotFoundError,
    );
    await expect(
      redeemSlackIdentityLinkChallenge(db, {
        token: minted.token,
        authId: fixture.user.id,
        now: new Date("2026-01-01T00:20:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(IdentityLinkChallengeNotFoundError);
    await expect(db.identityLink.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
  });

  it("rejects replayed challenges", async () => {
    const fixture = await setup("TREPLAY");
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });
    await redeemSlackIdentityLinkChallenge(db, {
      token: minted.token,
      authId: fixture.user.id,
    });

    await expect(
      redeemSlackIdentityLinkChallenge(db, {
        token: minted.token,
        authId: fixture.user.id,
      }),
    ).rejects.toBeInstanceOf(IdentityLinkChallengeNotFoundError);
    await expect(
      call(
        messagingRouter.slack.identityChallenges.preview,
        { token: minted.token },
        { context: { db, auth, env, headers: new Headers() } },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects token tampering", async () => {
    const fixture = await setup("TTAMPER");
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });
    const tampered = `${minted.token.slice(0, -4)}xxxx`;

    await expect(previewSlackIdentityLinkChallenge(db, tampered)).rejects.toBeInstanceOf(
      IdentityLinkChallengeNotFoundError,
    );
    await expect(
      redeemSlackIdentityLinkChallenge(db, {
        token: tampered,
        authId: fixture.user.id,
      }),
    ).rejects.toBeInstanceOf(IdentityLinkChallengeNotFoundError);
    await expect(db.identityLink.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
  });

  it("rejects cross-organization redemption", async () => {
    const fixture = await setup("TCROSSORG");
    const other = await setup("TOTHERORG");
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });

    await expect(
      redeemSlackIdentityLinkChallenge(db, {
        token: minted.token,
        authId: other.user.id,
      }),
    ).rejects.toMatchObject({ reason: "not_a_member" });

    await expect(
      call(
        messagingRouter.slack.identityChallenges.redeem,
        { token: minted.token },
        { context: other.context },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "not_a_member" } });

    await expect(db.identityLink.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    await expect(
      db.identityLinkChallenge.findUniqueOrThrow({ where: { id: minted.challenge.id } }),
    ).resolves.toMatchObject({ redeemedAt: null });
  });

  it("binds only the challenged workspace and Slack user", async () => {
    const fixture = await setup("TBOUNDWS");
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });

    const redeemed = await redeemSlackIdentityLinkChallenge(db, {
      token: minted.token,
      authId: fixture.user.id,
    });
    expect(redeemed).toMatchObject({
      workspaceId: "TBOUNDWS",
      userId: "U123ABC",
      principalId: fixture.member.id,
    });
    await expect(db.identityLink.findMany({ where: { orgId: fixture.org.id } })).resolves.toEqual([
      expect.objectContaining({
        externalUserId: "TBOUNDWS:U123ABC",
        principalId: fixture.member.id,
      }),
    ]);
  });

  it("leaves conflicting links unchanged and does not consume the challenge", async () => {
    const fixture = await setup("TCONFLICT");
    const other = await addMember(fixture.org.id, fixture.orgScope.id, "Other Member");
    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: other.principal.id,
    });
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });

    await expect(
      redeemSlackIdentityLinkChallenge(db, {
        token: minted.token,
        authId: fixture.user.id,
      }),
    ).rejects.toMatchObject({ reason: "identity_conflict" });

    await expect(
      db.identityLink.findUniqueOrThrow({
        where: {
          orgId_surface_externalUserId: {
            orgId: fixture.org.id,
            surface: "slack",
            externalUserId: "TCONFLICT:U123ABC",
          },
        },
      }),
    ).resolves.toMatchObject({ principalId: other.principal.id });
    await expect(
      db.identityLinkChallenge.findUniqueOrThrow({ where: { id: minted.challenge.id } }),
    ).resolves.toMatchObject({ redeemedAt: null });
  });

  it("rejects deactivated members without creating a link", async () => {
    const fixture = await setup("TDEACTIVATED");
    await db.principal.update({
      where: { id: fixture.member.id },
      data: { deactivatedAt: new Date() },
    });
    const minted = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });

    await expect(
      redeemSlackIdentityLinkChallenge(db, {
        token: minted.token,
        authId: fixture.user.id,
      }),
    ).rejects.toMatchObject({ reason: "deactivated" });
    await expect(db.identityLink.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    await expect(
      db.identityLinkChallenge.findUniqueOrThrow({ where: { id: minted.challenge.id } }),
    ).resolves.toMatchObject({ redeemedAt: null });
  });

  it("replaces an outstanding challenge for the same Slack identity", async () => {
    const fixture = await setup("TREPLACE");
    const first = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });
    const second = await mintSlackIdentityLinkChallenge(db, env, {
      orgId: fixture.org.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
    });

    await expect(previewSlackIdentityLinkChallenge(db, first.token)).rejects.toBeInstanceOf(
      IdentityLinkChallengeNotFoundError,
    );
    await expect(previewSlackIdentityLinkChallenge(db, second.token)).resolves.toMatchObject({
      workspaceId: "TREPLACE",
      userId: "U123ABC",
    });
  });
});
