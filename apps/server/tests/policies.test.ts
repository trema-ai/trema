import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { orgRouter } from "#server/rpc/org.js";
import { policiesRouter } from "#server/rpc/policies.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import { sessionsRouter } from "#server/rpc/sessions.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("approval policies", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "policy-integration-secret-at-least-32-characters",
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
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function createOrg() {
    const signedUp = await signUp("Policy Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Policy Org" },
      {
        context: signedUp.context,
      },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: signedUp.context },
    );
    return { ...signedUp, ...membership, orgScope, credential };
  }

  async function addMember(orgId: string, orgScopeId: string, role: Role, name: string) {
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
      data: { orgId, principalId: principal.id, scopeId: orgScopeId, role },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...signedUp, principal };
  }

  function serviceContext(secret: string) {
    return { db, auth, env, headers: new Headers({ authorization: `Bearer ${secret}` }) };
  }

  it("resolves the strictest applicable ceiling and routes by the most specific row", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Support" }, { context: org.context });

    await call(
      policiesRouter.set,
      { scopeId: org.orgScope.id, maxMode: "full" },
      { context: org.context },
    );
    const narrow = await call(
      policiesRouter.set,
      { scopeId: shared.id, maxMode: "ask", approverRoles: ["owner"] },
      { context: org.context },
    );

    // The shared scope tightens the org's ceiling; it never loosens it.
    const resolvedShared = await call(
      policiesRouter.resolved,
      { scopeId: shared.id },
      { context: org.context },
    );
    expect(resolvedShared.scopeChain).toEqual([org.orgScope.id, shared.id]);
    expect(resolvedShared.ceiling).toBe("ask");
    expect(resolvedShared.routing).toMatchObject({
      approverRoles: ["owner"],
      source: { kind: "policy", policyId: narrow.id },
    });

    const resolvedOrg = await call(
      policiesRouter.resolved,
      { scopeId: org.orgScope.id },
      { context: org.context },
    );
    expect(resolvedOrg.scopeChain).toEqual([org.orgScope.id]);
    expect(resolvedOrg.ceiling).toBe("full");
  });

  it("resolves connector rows against the connector, and pins untrusted entries to ask", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Ops" }, { context: org.context });

    await call(
      policiesRouter.set,
      { scopeId: shared.id, connectorKey: "github", maxMode: "ask" },
      { context: org.context },
    );

    // The connector row governs its connector; the scope-wide view and other
    // connectors resolve the default ceiling.
    const github = await call(
      policiesRouter.resolved,
      { scopeId: shared.id, connectorKey: "github" },
      { context: org.context },
    );
    expect(github.ceiling).toBe("ask");
    const scopeWide = await call(
      policiesRouter.resolved,
      { scopeId: shared.id },
      { context: org.context },
    );
    expect(scopeWide.ceiling).toBe("delegated");
  });

  it("replaces a scope's row per key and falls back again when it is deleted", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Sales" }, { context: org.context });

    const first = await call(
      policiesRouter.set,
      { scopeId: shared.id, maxMode: "full" },
      { context: org.context },
    );
    const second = await call(
      policiesRouter.set,
      { scopeId: shared.id, maxMode: "ask" },
      { context: org.context },
    );
    expect(second.id).toBe(first.id);

    // The scope-wide row and a connector row are separate keys.
    const connectorRow = await call(
      policiesRouter.set,
      { scopeId: shared.id, connectorKey: "github", maxMode: "delegated" },
      { context: org.context },
    );
    expect(connectorRow.id).not.toBe(second.id);

    const listed = await call(
      policiesRouter.list,
      { scopeId: shared.id },
      { context: org.context },
    );
    expect(listed.policies).toHaveLength(2);
    expect(listed.policies[0]).toMatchObject({ connectorKey: null, maxMode: "ask" });

    await call(policiesRouter.delete, { scopeId: shared.id }, { context: org.context });
    const resolved = await call(
      policiesRouter.resolved,
      { scopeId: shared.id },
      { context: org.context },
    );
    // The github row still stands; the scope-wide view is back on defaults.
    expect(resolved.ceiling).toBe("delegated");
    expect(resolved.routing.source).toMatchObject({ kind: "default" });
    await expect(
      call(policiesRouter.delete, { scopeId: shared.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a row nobody could resolve and guards unknown scopes", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Ops 2" }, { context: org.context });

    await expect(
      call(
        policiesRouter.set,
        {
          scopeId: shared.id,
          maxMode: "ask",
          approverRoles: [],
          allowRequesterApproval: false,
        },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // An unknown scope fails the capability check before the service sees it:
    // nobody holds a role at a scope that does not exist.
    await expect(
      call(policiesRouter.set, { scopeId: randomUUID(), maxMode: "ask" }, { context: org.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets a personal scope's owner tighten their own policy and keeps others out", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Personal Owner");
    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        ownerId: member.principal.id,
        name: "Personal Owner",
      },
    });

    const pinned = await call(
      policiesRouter.set,
      { scopeId: personal.id, maxMode: "ask" },
      { context: member.context },
    );
    expect(pinned).toMatchObject({ maxMode: "ask", allowRequesterApproval: true });

    // Organization admins do not read personal-scope policies, and the same
    // member cannot touch a shared scope's.
    const shared = await call(scopesRouter.create, { name: "Shared" }, { context: org.context });
    await expect(
      call(policiesRouter.set, { scopeId: shared.id, maxMode: "ask" }, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asOwner = await call(policiesRouter.list, {}, { context: org.context });
    expect(asOwner.policies).toHaveLength(0);
    const asMember = await call(policiesRouter.list, {}, { context: member.context });
    expect(asMember.policies.map(({ id }) => id)).toEqual([pinned.id]);
  });

  it("pins the snapshot at open, so a policy edited mid-run reaches the next session only", async () => {
    const org = await createOrg();
    const shared = await call(
      scopesRouter.create,
      { name: "Engineering" },
      {
        context: org.context,
      },
    );
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C9", scopeId: shared.id },
      { context: org.context },
    );
    await call(
      policiesRouter.set,
      { scopeId: shared.id, maxMode: "full" },
      { context: org.context },
    );

    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C9" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(opened.policySnapshot.rows).toHaveLength(1);
    expect(opened.policySnapshot.rows[0]).toMatchObject({ scopeId: shared.id, maxMode: "full" });

    await call(
      policiesRouter.set,
      { scopeId: shared.id, maxMode: "ask" },
      { context: org.context },
    );

    const persisted = await db.contextSession.findUniqueOrThrow({
      where: { id: opened.sessionId },
      select: { policySnapshot: true, snapshotHash: true },
    });
    const snapshot = persisted.policySnapshot as {
      rows: { maxMode: string }[];
    };
    expect(snapshot.rows[0]?.maxMode).toBe("full");

    const reopened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C9" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(reopened.policySnapshot.rows[0]?.maxMode).toBe("ask");
    expect(reopened.snapshotHash).not.toBe(persisted.snapshotHash);
  });
});
