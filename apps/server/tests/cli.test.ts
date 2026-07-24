import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { type Environment, parseEnv } from "#/lib/env/schema.js";
import { bootstrapRouter } from "#/rpc/bootstrap.js";
import { AdminOrgResolutionError, promote, resetPassword } from "#/services/admin/index.js";
import {
  BootstrapConflictError,
  hashBootstrapToken,
  mintBootstrapToken,
} from "#/services/bootstrap/index.js";
import { createOrgWithOwner } from "#/services/org/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const authSecret = "cli-integration-secret-at-least-32-characters";
const credentialMasterKey = Buffer.alloc(32, 3).toString("base64");

function environment(mode: "hosted" | "dedicated" = "dedicated"): Environment {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: authSecret,
    TREMA_MODE: mode,
    ...(mode === "dedicated" ? { TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey } : {}),
  });
}

integration("CLI escape hatch commands", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function signUp(env: Environment, name = "CLI User") {
    const auth = createAuth({ db, env });
    const email = `${randomUUID()}@example.com`;
    const password = "original-integration-password";
    const response = await auth.api.signUpEmail({
      body: { name, email, password },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    return { auth, email, user, cookie };
  }

  it("resets a password through better-auth and writes host audits", async () => {
    const env = environment();
    const account = await signUp(env);
    const membership = await createOrgWithOwner(db, {
      name: "Reset Org",
      owner: {
        authId: account.user.id,
        displayName: account.user.name,
        email: account.user.email,
      },
    });

    await resetPassword({
      db,
      auth: account.auth,
      email: account.email,
      password: "new-integration-password",
    });

    await expect(
      account.auth.api.signInEmail({
        body: { email: account.email, password: "new-integration-password" },
      }),
    ).resolves.toMatchObject({ user: { email: account.email } });
    await expect(
      db.auditLog.findFirst({ where: { action: "admin.reset_password" } }),
    ).resolves.toMatchObject({
      orgId: membership.org.id,
      actorPrincipalId: null,
      subject: membership.ownerPrincipal.id,
      payload: { actor: "host", userId: account.user.id },
    });
  });

  it("promotes a missing principal idempotently and writes host audits", async () => {
    const env = environment();
    const owner = await signUp(env, "Existing Owner");
    const target = await signUp(env, "New Owner");
    const membership = await createOrgWithOwner(db, {
      name: "Promotion Org",
      owner: { authId: owner.user.id, displayName: owner.user.name, email: owner.user.email },
    });

    const first = await promote({ db, env, email: target.email });
    const second = await promote({ db, env, email: target.email });

    expect(second.principal.id).toBe(first.principal.id);
    expect(second.grant.id).toBe(first.grant.id);
    await expect(
      db.principal.count({ where: { orgId: membership.org.id, authId: target.user.id } }),
    ).resolves.toBe(1);
    await expect(
      db.grant.count({ where: { orgId: membership.org.id, principalId: first.principal.id } }),
    ).resolves.toBe(1);
    await expect(
      db.auditLog.findFirst({ where: { action: "admin.promote" } }),
    ).resolves.toMatchObject({
      orgId: membership.org.id,
      actorPrincipalId: null,
      payload: { actor: "host", userId: target.user.id, role: "owner" },
    });
  });

  it("reports zero and ambiguous organization resolution errors", async () => {
    const env = environment("hosted");
    const target = await signUp(env);
    await expect(promote({ db, env, email: target.email })).rejects.toThrow(
      new AdminOrgResolutionError("No organization exists"),
    );

    const firstOwner = await signUp(env);
    const secondOwner = await signUp(env);
    await createOrgWithOwner(db, {
      name: "First Org",
      owner: {
        authId: firstOwner.user.id,
        displayName: firstOwner.user.name,
        email: firstOwner.user.email,
      },
    });
    await createOrgWithOwner(db, {
      name: "Second Org",
      owner: {
        authId: secondOwner.user.id,
        displayName: secondOwner.user.name,
        email: secondOwner.user.email,
      },
    });
    await expect(promote({ db, env, email: target.email })).rejects.toThrow("Use --org <id>");
  });

  it("mints, re-mints, and redeems a bootstrap token", async () => {
    const env = environment();
    const firstToken = await mintBootstrapToken({ db, generateToken: () => "first-cli-token" });
    const secondToken = await mintBootstrapToken({ db, generateToken: () => "second-cli-token" });
    const persisted = await db.bootstrapToken.findUniqueOrThrow({ where: { id: "bootstrap" } });
    expect(persisted.tokenHash).toBe(hashBootstrapToken(secondToken));
    expect(persisted.tokenHash).not.toBe(hashBootstrapToken(firstToken));

    const owner = await signUp(env);
    const context = {
      db,
      auth: owner.auth,
      env,
      headers: new Headers({ cookie: owner.cookie }),
    };
    await expect(
      call(bootstrapRouter.redeem, { token: firstToken, orgName: "Old Token Org" }, { context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        bootstrapRouter.redeem,
        { token: secondToken, orgName: "CLI Bootstrap Org" },
        { context },
      ),
    ).resolves.toMatchObject({ org: { name: "CLI Bootstrap Org" } });
  });

  it("refuses to mint a bootstrap token after an organization exists", async () => {
    const env = environment();
    const owner = await signUp(env);
    await createOrgWithOwner(db, {
      name: "Existing Org",
      owner: { authId: owner.user.id, displayName: owner.user.name, email: owner.user.email },
    });
    await expect(mintBootstrapToken({ db })).rejects.toBeInstanceOf(BootstrapConflictError);
  });
});
