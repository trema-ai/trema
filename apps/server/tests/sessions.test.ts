import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { type Environment, parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { orgRouter } from "#server/rpc/org.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import { sessionsRouter } from "#server/rpc/sessions.js";
import { hashSessionToken, SESSION_TOKEN_TTL_MS } from "#server/services/sessions/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("context sessions", () => {
  const db = createPrismaClient(databaseUrl);
  const baseEnvironment = {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "session-integration-secret-at-least-32-characters",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  };
  const env = parseEnv(baseEnvironment);
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
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function createOrg(name = "Session Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const [orgScope, agent] = await Promise.all([
      db.scope.findFirstOrThrow({ where: { orgId: membership.org.id, kind: "org" } }),
      db.principal.findFirstOrThrow({ where: { orgId: membership.org.id, kind: "agent" } }),
    ]);
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: signedUp.context },
    );
    return { ...signedUp, ...membership, orgScope, agent, credential };
  }

  async function linkMember(
    orgId: string,
    orgScopeId: string,
    name: string,
    externalUserId: string,
  ) {
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
      data: { orgId, principalId: principal.id, scopeId: orgScopeId, role: "member" },
    });
    await db.identityLink.create({
      data: { orgId, surface: "slack", externalUserId, principalId: principal.id },
    });
    return { ...signedUp, principal };
  }

  function serviceContext(secret?: string, environment: Environment = env) {
    const headers = new Headers();
    if (secret) headers.set("authorization", `Bearer ${secret}`);
    return { db, auth, env: environment, headers };
  }

  async function standingMemory(
    orgId: string,
    scopeId: string,
    createdById: string,
    input: { title: string; type: string; content: string; lastUsedAt?: Date },
  ) {
    return db.item.create({
      data: {
        orgId,
        scopeId,
        kind: "memory",
        title: input.title,
        body: { type: input.type, content: input.content },
        status: "active",
        disclosure: "standing",
        createdById,
        ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
      },
    });
  }

  it("opens a service-mode session on a bound location with dual attribution", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Support" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C1", scopeId: shared.id },
      { context: org.context },
    );
    const member = await linkMember(org.org.id, org.orgScope.id, "Asking Human", "U-ASKS");

    const opened = await call(
      sessionsRouter.open,
      {
        surface: "slack",
        locationRef: "T1:C1",
        threadRef: "1700000000.0001",
        requester: { externalUserId: "U-ASKS" },
      },
      { context: serviceContext(org.credential.secret) },
    );

    expect(opened.mode).toBe("service");
    expect(opened.actingPrincipalId).toBe(org.agent.id);
    expect(opened.requesterPrincipalId).toBe(member.principal.id);
    expect(opened.requesterExternalRef).toBe("U-ASKS");
    expect(opened.scopeChain.map(({ id }) => id)).toEqual([org.orgScope.id, shared.id]);
    expect(opened.sessionToken).toMatch(/^trema_ses_/);
    expect(opened.policySnapshot.decisions.read.action).toBe("allow");
    expect(opened.policySnapshot.decisions.write.action).toBe("require_approval");
    expect(opened.tools).toEqual([]);

    const persisted = await db.contextSession.findUniqueOrThrow({
      where: { id: opened.sessionId },
    });
    expect(persisted.tokenHash).toBe(hashSessionToken(opened.sessionToken));
    expect(JSON.stringify(persisted)).not.toContain(opened.sessionToken);
    expect(persisted.threadRef).toBe("1700000000.0001");
    expect(persisted.expiresAt.getTime() - persisted.createdAt.getTime()).toBeGreaterThan(
      SESSION_TOKEN_TTL_MS - 5_000,
    );

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "session.open", subject: opened.sessionId },
    });
    expect(audit.actorPrincipalId).toBe(org.agent.id);
  });

  it("derives delegated mode from a personal scope and service mode from the org scope", async () => {
    const org = await createOrg();
    const member = await linkMember(org.org.id, org.orgScope.id, "Dm Human", "U-DM");

    const personal = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:D1", dm: true, requester: { externalUserId: "U-DM" } },
      { context: serviceContext(org.credential.secret) },
    );
    expect(personal.mode).toBe("delegated");
    expect(personal.actingPrincipalId).toBe(member.principal.id);
    expect(personal.requesterPrincipalId).toBe(member.principal.id);
    expect(personal.scopeChain.map(({ kind }) => kind)).toEqual(["org", "personal"]);
    // A personal scope approves its own writes and keeps a confirm step for
    // destructive calls.
    expect(personal.policySnapshot.decisions.write.action).toBe("allow");
    expect(personal.policySnapshot.decisions.destructive.allowRequesterApproval).toBe(true);

    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1", scopeId: org.orgScope.id },
      { context: org.context },
    );
    const orgWide = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(orgWide.mode).toBe("service");
    expect(orgWide.actingPrincipalId).toBe(org.agent.id);
    expect(orgWide.scopeChain.map(({ id }) => id)).toEqual([org.orgScope.id]);
    expect(orgWide.requesterPrincipalId).toBeNull();
    expect(orgWide.requesterExternalRef).toBeNull();
  });

  it("records an unlinked requester and refuses an unlinked DM or unbound location", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Helpdesk" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C9", scopeId: shared.id },
      { context: org.context },
    );

    const opened = await call(
      sessionsRouter.open,
      {
        surface: "slack",
        locationRef: "T1:C9",
        requester: { externalUserId: "U-STRANGER" },
      },
      { context: serviceContext(org.credential.secret) },
    );
    expect(opened.requesterPrincipalId).toBeNull();
    expect(opened.requesterExternalRef).toBe("U-STRANGER");

    await expect(
      call(
        sessionsRouter.open,
        {
          surface: "slack",
          locationRef: "T1:D5",
          dm: true,
          requester: { externalUserId: "U-STRANGER" },
        },
        { context: serviceContext(org.credential.secret) },
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { code: "identity_unlinked", externalUserId: "U-STRANGER" },
    });

    await expect(
      call(
        sessionsRouter.open,
        { surface: "slack", locationRef: "T1:UNKNOWN" },
        { context: serviceContext(org.credential.secret) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { code: "location_unbound" } });

    await expect(
      call(
        sessionsRouter.open,
        { surface: "slack", locationRef: "T1:C9" },
        { context: serviceContext("trema_sc_unknown") },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("assembles standing context across the chain and cuts it at the token budget", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Platform" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C2", scopeId: shared.id },
      { context: org.context },
    );

    await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: org.orgScope.id,
        kind: "instruction",
        title: "Org instruction",
        body: { content: "Never share customer data." },
        status: "active",
        disclosure: "standing",
        createdById: org.principal.id,
      },
    });
    await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: shared.id,
        kind: "instruction",
        title: "Team instruction",
        body: { content: "Answer in the team's voice." },
        status: "active",
        disclosure: "standing",
        createdById: org.principal.id,
      },
    });
    const long = "y".repeat(400);
    const stale = await standingMemory(org.org.id, shared.id, org.principal.id, {
      title: "Stale rule",
      type: "rule",
      content: long,
      lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fresh = await standingMemory(org.org.id, shared.id, org.principal.id, {
      title: "Fresh preference",
      type: "preference",
      content: long,
      lastUsedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    // Retrieved items and archived items never join the standing set.
    await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: shared.id,
        kind: "memory",
        title: "Retrieved fact",
        body: { type: "fact", content: "The staging host is stage.example." },
        status: "active",
        disclosure: "retrieved",
        createdById: org.principal.id,
      },
    });

    const generous = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C2" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(generous.standing.instructions).toBe(
      "Never share customer data.\n\nAnswer in the team's voice.",
    );
    expect(generous.standing.rules.map(({ id }) => id)).toEqual([fresh.id, stale.id]);
    expect(generous.standing.overflowItemIds).toEqual([]);
    expect(generous.standing.skillIndex).toEqual([]);

    const tight = parseEnv({ ...baseEnvironment, TREMA_SESSION_STANDING_BUDGET_TOKENS: "120" });
    const cut = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C2" },
      { context: serviceContext(org.credential.secret, tight) },
    );
    expect(cut.standing.budgetTokens).toBe(120);
    expect(cut.standing.rules.map(({ id }) => id)).toEqual([fresh.id]);
    expect(cut.standing.overflowItemIds).toEqual([stale.id]);
    expect(cut.standing.instructions).toBe(generous.standing.instructions);
  });

  it("pins the snapshot against later context edits", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Pinned" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C3", scopeId: shared.id },
      { context: org.context },
    );
    await standingMemory(org.org.id, shared.id, org.principal.id, {
      title: "Original rule",
      type: "rule",
      content: "Open a pull request for every change.",
    });

    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C3" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(opened.standing.rules).toHaveLength(1);

    await standingMemory(org.org.id, shared.id, org.principal.id, {
      title: "Added after the session opened",
      type: "rule",
      content: "Deploy on Fridays.",
    });

    const persisted = await db.contextSession.findUniqueOrThrow({
      where: { id: opened.sessionId },
    });
    const standing = persisted.standing as { rules: { content: string }[] };
    expect(standing.rules).toHaveLength(1);
    expect(standing.rules[0]?.content).toBe("Open a pull request for every change.");
    expect(persisted.snapshotHash).toBe(opened.snapshotHash);

    const reopened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C3" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(reopened.standing.rules).toHaveLength(2);
    expect(reopened.snapshotHash).not.toBe(opened.snapshotHash);
  });

  it("renews before expiry, refuses renewal after it, and closes once with usage", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Lifetime" }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C4", scopeId: shared.id },
      { context: org.context },
    );
    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C4" },
      { context: serviceContext(org.credential.secret) },
    );
    const sessionContext = serviceContext(opened.sessionToken);

    const renewed = await call(
      sessionsRouter.renew,
      { id: opened.sessionId },
      { context: sessionContext },
    );
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(opened.expiresAt).getTime(),
    );

    await expect(
      call(sessionsRouter.renew, { id: opened.sessionId }, { context: serviceContext() }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(sessionsRouter.renew, { id: randomUUID() }, { context: sessionContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.contextSession.update({
      where: { id: opened.sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(
      call(sessionsRouter.renew, { id: opened.sessionId }, { context: sessionContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", data: { code: "session_expired" } });

    // Usage still lands after expiry, so a long run never loses its accounting.
    const closed = await call(
      sessionsRouter.close,
      {
        id: opened.sessionId,
        usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, costUsd: 0.02 },
      },
      { context: sessionContext },
    );
    expect(closed.usage).toMatchObject({ inputTokens: 1200, costUsd: 0.02 });

    const persisted = await db.contextSession.findUniqueOrThrow({
      where: { id: opened.sessionId },
    });
    expect(persisted.closedAt).not.toBeNull();
    expect(persisted.usage).toMatchObject({ outputTokens: 340 });

    await expect(
      call(sessionsRouter.close, { id: opened.sessionId }, { context: sessionContext }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "session_closed" } });

    const audits = await db.auditLog.findMany({
      where: { orgId: org.org.id, subject: opened.sessionId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map(({ action }) => action)).toEqual([
      "session.open",
      "session.renew",
      "session.close",
    ]);
    expect(JSON.stringify(audits)).not.toContain(opened.sessionToken);
  });
});
