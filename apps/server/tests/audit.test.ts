import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { auditRouter } from "#/rpc/audit.js";
import { orgRouter } from "#/rpc/org.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!testDatabaseUrl);
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("audit log query", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "audit-log-integration-secret-at-least-32-chars",
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
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function createOrg(name = "Audit Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    return { ...signedUp, ...membership };
  }

  async function record(
    orgId: string,
    action: string,
    options: { actorPrincipalId?: string | null; createdAt?: Date } = {},
  ) {
    return db.auditLog.create({
      data: {
        orgId,
        actorPrincipalId: options.actorPrincipalId ?? null,
        action,
        subject: randomUUID(),
        payload: { detail: action },
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });
  }

  it("returns entries newest first with the actor resolved and the system actor as null", async () => {
    const org = await createOrg();
    await record(org.org.id, "invite.create", { actorPrincipalId: org.principal.id });
    await record(org.org.id, "admin.promote");

    const page = await call(auditRouter.list, {}, { context: org.context });

    expect(page.entries.map((entry) => entry.action)).toEqual([
      "admin.promote",
      "invite.create",
      "org.create",
    ]);
    expect(page.entries[0]?.actor).toBeNull();
    expect(page.entries[1]?.actor).toMatchObject({
      id: org.principal.id,
      displayName: org.principal.displayName,
      kind: "human",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("pages through entries with the returned cursor", async () => {
    const org = await createOrg();
    for (let index = 0; index < 4; index += 1) {
      await record(org.org.id, `item.create.${index}`, { actorPrincipalId: org.principal.id });
    }

    const first = await call(auditRouter.list, { limit: 2 }, { context: org.context });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBe(first.entries[1]?.id);

    const second = await call(
      auditRouter.list,
      { limit: 2, cursor: first.nextCursor ?? undefined },
      { context: org.context },
    );
    const seen = [...first.entries, ...second.entries].map((entry) => entry.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(second.entries.map((entry) => entry.action)).toEqual(["item.create.1", "item.create.0"]);
  });

  it("filters by action, action prefix, actor, and time range", async () => {
    const org = await createOrg();
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    await record(org.org.id, "grant.set_role", { actorPrincipalId: org.principal.id });
    await record(org.org.id, "invite.create", { actorPrincipalId: org.principal.id });
    await record(org.org.id, "invite.revoke", { createdAt: old });

    const byAction = await call(
      auditRouter.list,
      { action: "grant.set_role" },
      { context: org.context },
    );
    expect(byAction.entries.map((entry) => entry.action)).toEqual(["grant.set_role"]);

    const byPrefix = await call(
      auditRouter.list,
      { actionPrefix: "invite." },
      { context: org.context },
    );
    expect(byPrefix.entries.map((entry) => entry.action)).toEqual([
      "invite.create",
      "invite.revoke",
    ]);

    const byActor = await call(
      auditRouter.list,
      { actorPrincipalId: org.principal.id },
      { context: org.context },
    );
    expect(byActor.entries.every((entry) => entry.actor?.id === org.principal.id)).toBe(true);

    const byRange = await call(
      auditRouter.list,
      { to: new Date(old.getTime() + 1_000).toISOString() },
      { context: org.context },
    );
    expect(byRange.entries.map((entry) => entry.action)).toEqual(["invite.revoke"]);
  });

  it("rejects a range whose start is after its end", async () => {
    const org = await createOrg();
    await expect(
      call(
        auditRouter.list,
        { from: new Date().toISOString(), to: new Date(Date.now() - 1_000).toISOString() },
        { context: org.context },
      ),
    ).rejects.toThrow(/range start/i);
  });

  it("lists the distinct actions present in the organization", async () => {
    const org = await createOrg();
    await record(org.org.id, "invite.create", { actorPrincipalId: org.principal.id });
    await record(org.org.id, "invite.create", { actorPrincipalId: org.principal.id });

    expect(await call(auditRouter.actions, undefined, { context: org.context })).toEqual([
      "invite.create",
      "org.create",
    ]);
  });

  it("keeps one organization's entries out of another's", async () => {
    const first = await createOrg("First Audit Org");
    const second = await createOrg("Second Audit Org");
    await record(first.org.id, "grant.set_role", { actorPrincipalId: first.principal.id });

    const page = await call(auditRouter.list, {}, { context: second.context });
    expect(page.entries.map((entry) => entry.action)).toEqual(["org.create"]);
  });

  it("denies a member without the audit capability", async () => {
    const org = await createOrg();
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "org" },
    });
    const member = await signUp("Audit Member");
    const principal = await db.principal.create({
      data: {
        orgId: org.org.id,
        kind: "human",
        displayName: "Audit Member",
        authId: member.user.id,
        email: member.user.email,
      },
    });
    await db.grant.create({
      data: { orgId: org.org.id, principalId: principal.id, scopeId: orgScope.id, role: "member" },
    });
    await db.session.updateMany({
      where: { userId: member.user.id },
      data: { activeOrgId: org.org.id },
    });

    await expect(call(auditRouter.list, {}, { context: member.context })).rejects.toThrow(
      /read_audit/,
    );
  });
});
