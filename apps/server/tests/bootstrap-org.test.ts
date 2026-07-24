import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { type Environment, parseEnv } from "#/lib/env/schema.js";
import { bootstrapRouter } from "#/rpc/bootstrap.js";
import { configRouter } from "#/rpc/config.js";
import { orgRouter } from "#/rpc/org.js";
import { hashBootstrapToken, initializeBootstrap } from "#/services/bootstrap/index.js";
import { createOrgWithOwner } from "#/services/org/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const authSecret = "bootstrap-integration-secret-at-least-32-characters";
const credentialMasterKey = Buffer.alloc(32, 2).toString("base64");

function environment(mode: "hosted" | "dedicated", bootstrapToken?: string): Environment {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: authSecret,
    TREMA_MODE: mode,
    TREMA_BOOTSTRAP_TOKEN: bootstrapToken,
    ...(mode === "dedicated" ? { TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey } : {}),
  });
}

integration("bootstrap and organizations", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function signUp(env: Environment, name = "Test Owner") {
    const auth = createAuth({ db, env });
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password: "integration-password",
      },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const user = await db.user.findUniqueOrThrow({ where: { email } });

    if (!cookie) {
      throw new Error("Sign-up did not return a session cookie");
    }

    return {
      auth,
      cookie,
      email,
      user,
      context: {
        db,
        auth,
        env,
        headers: new Headers({ cookie }),
      },
    };
  }

  it("creates org and personal scopes, the owner grant, and a scope-less agent atomically", async () => {
    const env = environment("hosted");
    const { user } = await signUp(env, "Atomic Owner");

    const result = await createOrgWithOwner(db, {
      name: "Atomic Org",
      owner: {
        authId: user.id,
        displayName: user.name,
        email: user.email,
      },
    });

    const [scopes, principals, grants] = await Promise.all([
      db.scope.findMany({ where: { orgId: result.org.id } }),
      db.principal.findMany({ where: { orgId: result.org.id } }),
      db.grant.findMany({ where: { orgId: result.org.id } }),
    ]);
    const agent = principals.find((principal) => principal.kind === "agent");

    expect(scopes).toHaveLength(2);
    const orgScope = scopes.find((scope) => scope.kind === "org");
    const personalScope = scopes.find((scope) => scope.kind === "personal");
    expect(orgScope).toMatchObject({ kind: "org", name: "Atomic Org", ownerId: null });
    expect(personalScope).toMatchObject({
      kind: "personal",
      name: "Atomic Owner",
      ownerId: result.ownerPrincipal.id,
    });
    expect(principals).toHaveLength(2);
    expect(result.ownerPrincipal).toMatchObject({
      kind: "human",
      authId: user.id,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      principalId: result.ownerPrincipal.id,
      scopeId: orgScope?.id,
      role: "owner",
    });
    expect(agent).toBeDefined();
    if (!agent) {
      throw new Error("Agent principal was not created");
    }
    await expect(db.grant.count({ where: { principalId: agent.id } })).resolves.toBe(0);
    await expect(db.scope.count({ where: { ownerId: agent.id } })).resolves.toBe(0);
  });

  it("does not create bootstrap personal scopes when the new org disables them", async () => {
    const env = environment("hosted");
    const { user } = await signUp(env, "Policy-disabled Owner");

    const result = await createOrgWithOwner(db, {
      name: "Policy-disabled Org",
      personalScopesEnabled: false,
      owner: {
        authId: user.id,
        displayName: user.name,
        email: user.email,
      },
    });

    await expect(
      db.scope.findMany({ where: { orgId: result.org.id }, select: { kind: true } }),
    ).resolves.toEqual([{ kind: "org" }]);
  });

  it("allows exactly one winner in a concurrent dedicated bootstrap race", async () => {
    const token = "concurrent-bootstrap-token";
    const env = environment("dedicated", token);
    await initializeBootstrap({ db, env });
    const first = await signUp(env, "First Racer");
    const second = await signUp(env, "Second Racer");

    const results = await Promise.allSettled([
      call(
        bootstrapRouter.redeem,
        { token, orgName: "First Race Org" },
        { context: first.context },
      ),
      call(
        bootstrapRouter.redeem,
        { token, orgName: "Second Race Org" },
        { context: second.context },
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT" },
    });
    await expect(db.org.count()).resolves.toBe(1);
  });

  it("returns conflict when the correct token is reused after bootstrap", async () => {
    const token = "one-use-bootstrap-token";
    const env = environment("dedicated", token);
    await initializeBootstrap({ db, env });
    const owner = await signUp(env);

    const membership = await call(
      bootstrapRouter.redeem,
      { token, orgName: "Bootstrapped Org" },
      { context: owner.context },
    );

    await expect(
      db.auditLog.findFirst({ where: { orgId: membership.org.id } }),
    ).resolves.toMatchObject({
      actorPrincipalId: membership.principal.id,
      action: "org.bootstrap",
      subject: membership.org.id,
    });

    await expect(
      call(bootstrapRouter.redeem, { token, orgName: "Second Org" }, { context: owner.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.org.count()).resolves.toBe(1);
  });

  it("rejects a wrong bootstrap token without creating an org", async () => {
    const env = environment("dedicated", "correct-bootstrap-token");
    await initializeBootstrap({ db, env });
    const owner = await signUp(env);

    await expect(
      call(
        bootstrapRouter.redeem,
        { token: "wrong-bootstrap-token", orgName: "Rejected Org" },
        { context: owner.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(db.org.count()).resolves.toBe(0);
  });

  it("generates, logs once, and persists only the hash of a startup token", async () => {
    const generatedToken = "generated-bootstrap-token";
    const env = environment("dedicated");
    const log = vi.fn();

    const initialized = await initializeBootstrap({
      db,
      env,
      log,
      generateToken: () => generatedToken,
    });
    await initializeBootstrap({
      db,
      env,
      log,
      generateToken: () => "must-not-replace-token",
    });

    expect(initialized).toEqual({ generatedToken });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(`Bootstrap token: ${generatedToken}`);
    const persisted = await db.bootstrapToken.findUniqueOrThrow({
      where: { id: "bootstrap" },
    });
    expect(persisted.tokenHash).toBe(hashBootstrapToken(generatedToken));
    expect(JSON.stringify(persisted)).not.toContain(generatedToken);

    const owner = await signUp(env);
    await expect(
      call(
        bootstrapRouter.redeem,
        { token: generatedToken, orgName: "Generated Token Org" },
        { context: owner.context },
      ),
    ).resolves.toMatchObject({ org: { name: "Generated Token Org" } });
  });

  it("creates hosted orgs with audit logs and updates the current session", async () => {
    const env = environment("hosted");
    const owner = await signUp(env);

    const membership = await call(
      orgRouter.create,
      { name: "Hosted Org" },
      { context: owner.context },
    );

    await expect(
      db.auditLog.findFirst({ where: { orgId: membership.org.id } }),
    ).resolves.toMatchObject({
      actorPrincipalId: membership.principal.id,
      action: "org.create",
      subject: membership.org.id,
    });
    const session = await owner.auth.api.getSession({
      headers: owner.context.headers,
    });
    expect(session?.session.activeOrgId).toBe(membership.org.id);
  });

  it("isolates org lists and resolves a two-org user through switch and current", async () => {
    const env = environment("hosted");
    const owner = await signUp(env, "Two Org Owner");
    const outsider = await signUp(env, "Outsider");
    const first = await call(orgRouter.create, { name: "First Org" }, { context: owner.context });
    const second = await call(orgRouter.create, { name: "Second Org" }, { context: owner.context });
    await call(orgRouter.create, { name: "Outsider Org" }, { context: outsider.context });

    const memberships = await call(orgRouter.list, undefined, {
      context: owner.context,
    });
    expect(memberships.map(({ org }) => org.id)).toEqual([first.org.id, second.org.id]);

    await expect(
      call(orgRouter.switch, { orgId: first.org.id }, { context: owner.context }),
    ).resolves.toMatchObject({
      org: { id: first.org.id },
      principal: { id: first.principal.id },
    });
    await expect(
      call(orgRouter.current, undefined, { context: owner.context }),
    ).resolves.toMatchObject({
      org: { id: first.org.id },
      principal: { id: first.principal.id },
    });
  });

  it("sets the sole organization on a newly created sign-in session", async () => {
    const env = environment("hosted");
    const owner = await signUp(env);
    const membership = await call(
      orgRouter.create,
      { name: "Only Org" },
      { context: owner.context },
    );

    const response = await owner.auth.api.signInEmail({
      body: {
        email: owner.email,
        password: "integration-password",
      },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const session = await owner.auth.api.getSession({
      headers: new Headers({ cookie: cookie ?? "" }),
    });

    expect(session?.session.activeOrgId).toBe(membership.org.id);
  });

  it("reports public mode, bootstrap state, and enabled providers", async () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      TREMA_AUTH_SECRET: authSecret,
      TREMA_MODE: "dedicated",
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
      TREMA_PASSWORD_AUTH_ENABLED: "false",
      TREMA_GOOGLE_CLIENT_ID: "google-client",
      TREMA_GOOGLE_CLIENT_SECRET: "google-secret",
      TREMA_TERMS_URL: "https://trema.example/terms",
    });
    const auth = createAuth({ db, env });

    await expect(
      call(configRouter.get, undefined, {
        context: { db, auth, env, headers: new Headers() },
      }),
    ).resolves.toEqual({
      mode: "dedicated",
      needsBootstrap: true,
      providers: { password: false, google: true },
      legal: { termsUrl: "https://trema.example/terms", privacyUrl: null },
    });
  });
});
