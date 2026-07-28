import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { type Environment, parseEnv } from "#server/lib/env/schema.js";
import { createInvite, revokeInvite } from "#server/services/members/index.js";
import { createOrgWithOwner } from "#server/services/org/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const authSecret = "account-creation-secret-at-least-32-characters";
const credentialMasterKey = Buffer.alloc(32, 3).toString("base64");

function environment(
  mode: "hosted" | "dedicated",
  overrides: Record<string, string> = {},
): Environment {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: authSecret,
    TREMA_MODE: mode,
    ...(mode === "dedicated" ? { TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey } : {}),
    ...overrides,
  });
}

integration("account creation", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  // Returns before awaiting so a rejected attempt still names the email the
  // sign-up would have created.
  function signUp(env: Environment, inviteToken?: string) {
    const auth = createAuth({ db, env });
    const email = `${randomUUID()}@example.com`;
    const attempt = auth.api.signUpEmail({
      body: {
        name: "New Account",
        email,
        password: "integration-password",
      },
      headers: new Headers(inviteToken ? { "x-trema-invite-token": inviteToken } : {}),
      asResponse: true,
    });
    return { email, attempt };
  }

  async function seedOrg() {
    const env = environment("dedicated");
    const owner = await db.user.create({
      data: {
        id: randomUUID(),
        name: "Invite Owner",
        email: `${randomUUID()}@example.com`,
      },
    });
    const { org, ownerPrincipal } = await createOrgWithOwner(db, {
      name: `Invite Org ${randomUUID()}`,
      owner: {
        authId: owner.id,
        displayName: owner.name,
        email: owner.email,
      },
    });

    async function invite(expiresAt?: Date) {
      const created = await createInvite(db, env, {
        orgId: org.id,
        actorPrincipalId: ownerPrincipal.id,
        role: "member",
        ...(expiresAt ? { expiresAt } : {}),
      });
      const token = new URL(created.link).searchParams.get("token");
      if (!token) {
        throw new Error("Invite link did not carry a token");
      }
      return { id: created.invite.id, token };
    }

    return { env, org, ownerPrincipal, invite };
  }

  it("rejects a dedicated sign-up that carries no invite", async () => {
    const { env } = await seedOrg();

    const { email, attempt } = signUp(env);

    await expect(attempt).rejects.toMatchObject({
      status: "FORBIDDEN",
      statusCode: 403,
      message: "Account creation requires an invite",
    });
    await expect(db.user.findUnique({ where: { email } })).resolves.toBeNull();
  });

  it("accepts a dedicated sign-up carrying a redeemable invite, leaving it unredeemed", async () => {
    const { env, invite } = await seedOrg();
    const pending = await invite();

    const { email, attempt } = signUp(env, pending.token);

    expect((await attempt).status).toBe(200);
    await expect(db.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ email });
    await expect(db.invite.findUniqueOrThrow({ where: { id: pending.id } })).resolves.toMatchObject(
      {
        redeemedAt: null,
        redeemedById: null,
      },
    );
  });

  it.each([
    [
      "a revoked",
      async (fixture: Awaited<ReturnType<typeof seedOrg>>) => {
        const pending = await fixture.invite();
        await revokeInvite(db, {
          orgId: fixture.org.id,
          actorPrincipalId: fixture.ownerPrincipal.id,
          inviteId: pending.id,
        });
        return pending.token;
      },
    ],
    [
      "an expired",
      async (fixture: Awaited<ReturnType<typeof seedOrg>>) => {
        const pending = await fixture.invite(new Date(Date.now() - 1_000));
        return pending.token;
      },
    ],
    ["an unknown", async () => "not-an-invite-token"],
  ])("rejects a dedicated sign-up carrying %s invite token", async (_label, tokenFor) => {
    const fixture = await seedOrg();

    const { email, attempt } = signUp(fixture.env, await tokenFor(fixture));

    await expect(attempt).rejects.toMatchObject({
      status: "FORBIDDEN",
      message: "Account creation requires an invite",
    });
    await expect(db.user.findUnique({ where: { email } })).resolves.toBeNull();
  });

  it("accepts a dedicated sign-up while no organization exists", async () => {
    const { email, attempt } = signUp(environment("dedicated"));

    expect((await attempt).status).toBe(200);
    await expect(db.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ email });
  });

  it("accepts a dedicated sign-up when open signup is configured", async () => {
    await seedOrg();

    const { email, attempt } = signUp(environment("dedicated", { TREMA_OPEN_SIGNUP: "true" }));

    expect((await attempt).status).toBe(200);
    await expect(db.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ email });
  });

  it("leaves hosted sign-up open once an organization exists", async () => {
    await seedOrg();

    const { email, attempt } = signUp(environment("hosted"));

    expect((await attempt).status).toBe(200);
    await expect(db.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ email });
  });
});
