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

  it("resolves the narrowest scope's row per class and keeps the defaults elsewhere", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Support" }, { context: org.context });

    await call(
      policiesRouter.set,
      { scopeId: org.orgScope.id, sensitivity: "destructive", action: "deny" },
      { context: org.context },
    );
    const narrow = await call(
      policiesRouter.set,
      {
        scopeId: shared.id,
        sensitivity: "destructive",
        action: "require_approval",
        approverRoles: ["owner"],
      },
      { context: org.context },
    );

    const resolvedShared = await call(
      policiesRouter.resolved,
      { scopeId: shared.id },
      { context: org.context },
    );
    expect(resolvedShared.scopeChain).toEqual([org.orgScope.id, shared.id]);
    expect(resolvedShared.decisions.destructive).toMatchObject({
      action: "require_approval",
      approverRoles: ["owner"],
      source: { kind: "policy", policyId: narrow.id, scopeId: shared.id },
    });
    // Nobody wrote a read or write row, so those classes stay on the defaults.
    expect(resolvedShared.decisions.read).toMatchObject({ action: "allow" });
    expect(resolvedShared.decisions.write.source).toMatchObject({ kind: "default" });

    // A session opened at the organization scope sees the organization's row.
    const resolvedOrg = await call(
      policiesRouter.resolved,
      { scopeId: org.orgScope.id },
      { context: org.context },
    );
    expect(resolvedOrg.scopeChain).toEqual([org.orgScope.id]);
    expect(resolvedOrg.decisions.destructive).toMatchObject({ action: "deny" });
  });

  it("replaces a scope's row per class and falls back again when it is deleted", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Sales" }, { context: org.context });

    const first = await call(
      policiesRouter.set,
      { scopeId: shared.id, sensitivity: "write", action: "allow" },
      { context: org.context },
    );
    const second = await call(
      policiesRouter.set,
      { scopeId: shared.id, sensitivity: "write", action: "deny" },
      { context: org.context },
    );
    expect(second.id).toBe(first.id);

    const listed = await call(
      policiesRouter.list,
      { scopeId: shared.id },
      { context: org.context },
    );
    expect(listed.policies).toHaveLength(1);
    expect(listed.policies[0]).toMatchObject({ sensitivity: "write", action: "deny" });

    await call(
      policiesRouter.delete,
      { scopeId: shared.id, sensitivity: "write" },
      { context: org.context },
    );
    const resolved = await call(
      policiesRouter.resolved,
      { scopeId: shared.id },
      { context: org.context },
    );
    expect(resolved.decisions.write.source).toMatchObject({ kind: "default" });
    await expect(
      call(
        policiesRouter.delete,
        { scopeId: shared.id, sensitivity: "write" },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a gate nobody can resolve and stores no approvers for an ungated class", async () => {
    const org = await createOrg();
    const shared = await call(scopesRouter.create, { name: "Ops" }, { context: org.context });

    // Separation of duties: outside a personal scope the requester cannot be
    // the sole approver, so a shared-scope gate needs an approver role.
    await expect(
      call(
        policiesRouter.set,
        {
          scopeId: shared.id,
          sensitivity: "destructive",
          action: "require_approval",
          approverRoles: [],
          allowRequesterApproval: true,
        },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const allowed = await call(
      policiesRouter.set,
      {
        scopeId: shared.id,
        sensitivity: "write",
        action: "allow",
        approverRoles: ["admin"],
        allowRequesterApproval: true,
      },
      { context: org.context },
    );
    expect(allowed).toMatchObject({ approverRoles: [], allowRequesterApproval: false });

    // An unknown scope fails the capability check before the service sees it:
    // nobody holds a role at a scope that does not exist.
    await expect(
      call(
        policiesRouter.set,
        { scopeId: randomUUID(), sensitivity: "read", action: "allow" },
        { context: org.context },
      ),
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

    // A personal-scope approval is a confirm step: the owner is the approver.
    const confirmStep = await call(
      policiesRouter.set,
      {
        scopeId: personal.id,
        sensitivity: "write",
        action: "require_approval",
        allowRequesterApproval: true,
      },
      { context: member.context },
    );
    expect(confirmStep).toMatchObject({ approverRoles: [], allowRequesterApproval: true });

    // Organization admins do not read personal-scope policies, and the same
    // member cannot touch a shared scope's.
    const shared = await call(scopesRouter.create, { name: "Shared" }, { context: org.context });
    await expect(
      call(
        policiesRouter.set,
        { scopeId: shared.id, sensitivity: "write", action: "allow" },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const asOwner = await call(policiesRouter.list, {}, { context: org.context });
    expect(asOwner.policies).toHaveLength(0);
    const asMember = await call(policiesRouter.list, {}, { context: member.context });
    expect(asMember.policies.map(({ id }) => id)).toEqual([confirmStep.id]);
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
      { scopeId: shared.id, sensitivity: "write", action: "allow" },
      { context: org.context },
    );

    const opened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C9" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(opened.policySnapshot.decisions.write).toMatchObject({
      action: "allow",
      source: { kind: "policy", scopeId: shared.id },
    });

    await call(
      policiesRouter.set,
      { scopeId: shared.id, sensitivity: "write", action: "deny" },
      { context: org.context },
    );

    const persisted = await db.contextSession.findUniqueOrThrow({
      where: { id: opened.sessionId },
      select: { policySnapshot: true, snapshotHash: true },
    });
    const snapshot = persisted.policySnapshot as {
      decisions: { write: { action: string } };
    };
    expect(snapshot.decisions.write.action).toBe("allow");

    const reopened = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:C9" },
      { context: serviceContext(org.credential.secret) },
    );
    expect(reopened.policySnapshot.decisions.write.action).toBe("deny");
    expect(reopened.snapshotHash).not.toBe(persisted.snapshotHash);
  });
});
